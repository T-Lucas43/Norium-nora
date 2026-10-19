"""Bounded queue for user-requested internal work; never dispatches a provider.

Handlers must be idempotent and keep an application receipt with their data.
The job row is locked throughout each internal mutation, fencing stale workers.
Supported web topology remains the existing single legacy writer.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

from fastapi import HTTPException

from app.core.identity import require_team_id, require_user_id
from app.core.request_context import current_workspace_id, reset_request_context, set_request_context
from app.core.tenant import get_data_root, read_account_db
from app.infrastructure.persistence import postgres_store

logger = logging.getLogger(__name__)
KINDS = frozenset({"import.clients", "import.catalog", "import.preview.clients", "import.preview.catalog"})
INPUT_TTL_SECONDS = 86400
_wake: asyncio.Event | None = None
SCHEMA = """CREATE TABLE IF NOT EXISTS norium_business_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT NOT NULL,
 workspace TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
 lease TEXT NOT NULL DEFAULT '', lease_until DOUBLE PRECISION NOT NULL DEFAULT 0,
 progress INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '{}',
 error_code TEXT NOT NULL DEFAULT '', created_at DOUBLE PRECISION NOT NULL,
 updated_at DOUBLE PRECISION NOT NULL, cleanup_at DOUBLE PRECISION NOT NULL DEFAULT 0,
 UNIQUE(user_id,workspace,kind,request_key))"""


@contextmanager
def database():
    if postgres_store.configured() or postgres_store.required():
        with postgres_store.connection() as db:
            db.execute(SCHEMA)
            db.execute("CREATE INDEX IF NOT EXISTS norium_business_queue ON norium_business_jobs(status,lease_until,created_at)")
            yield db, True
        return
    db = sqlite3.connect(get_data_root() / "business_jobs.sqlite3", timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        yield db, False
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def sql(db, pg, query, args=()):
    return db.execute(query.replace("?", "%s") if pg else query, args)


def exposed(row):
    return {"id": row["id"], "kind": row["kind"], "status": row["status"],
            "progress": row["progress"], "result": json.loads(row["result"]),
            "errorCode": row["error_code"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def enqueue(user: dict, kind: str, payload: dict, request_key: str):
    if kind not in KINDS:
        raise ValueError("Unregistered internal job")
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True, allow_nan=False)
    if len(encoded) > 12_000_000:
        raise HTTPException(413, "Arquivo excede o limite desta importação.")
    digest, stamp = hashlib.sha256(encoded.encode()).hexdigest(), time.time()
    actor, team, workspace = require_user_id(user), require_team_id(user), current_workspace_id()
    with database() as (db, pg):
        if pg:
            db.execute("SELECT pg_advisory_xact_lock(hashtextextended('norium:business-input-budget',0))")
        count = sql(db, pg, "SELECT COUNT(*) AS n FROM norium_business_jobs WHERE user_id=? AND workspace=? AND status IN ('queued','running')", (actor, workspace)).fetchone()["n"]
        existing = sql(db, pg, "SELECT * FROM norium_business_jobs WHERE user_id=? AND workspace=? AND kind=? AND request_key=?", (actor, workspace, kind, request_key)).fetchone()
        if existing:
            if existing["request_hash"] != digest:
                raise HTTPException(409, "A mesma chave já foi usada com outro conteúdo.")
            return exposed(existing)
        if count >= 5:
            raise HTTPException(429, "Aguarde a conclusão das importações em andamento.")
        budget = sql(db, pg, """SELECT COALESCE(SUM(length(payload)),0) AS total,
            COALESCE(SUM(CASE WHEN user_id=? THEN length(payload) ELSE 0 END),0) AS personal
            FROM norium_business_jobs WHERE payload!='{}'""", (actor,)).fetchone()
        if int(budget["total"])+len(encoded) > 128_000_000 or int(budget["personal"])+len(encoded) > 32_000_000:
            raise HTTPException(429, "A fila de arquivos está cheia. Aguarde o processamento ou a expiração dos temporários.")
        identifier = "business_job_" + uuid.uuid4().hex
        sql(db, pg, """INSERT INTO norium_business_jobs
            (id,user_id,team_id,workspace,kind,request_key,request_hash,payload,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT DO NOTHING""",
            (identifier, actor, team, workspace, kind, request_key, digest, encoded, stamp, stamp))
        row = sql(db, pg, "SELECT * FROM norium_business_jobs WHERE user_id=? AND workspace=? AND kind=? AND request_key=?", (actor, workspace, kind, request_key)).fetchone()
        if row["request_hash"] != digest:
            raise HTTPException(409, "A mesma chave já foi usada com outro conteúdo.")
        return exposed(row)


def read(user: dict, identifier: str):
    with database() as (db, pg):
        row = sql(db, pg, "SELECT id,kind,status,progress,result,error_code,created_at,updated_at FROM norium_business_jobs WHERE id=? AND user_id=? AND team_id=? AND workspace=?", (identifier, require_user_id(user), require_team_id(user), current_workspace_id())).fetchone()
        if not row:
            raise HTTPException(404, "Importação não encontrada.")
        return exposed(row)


def recent(user: dict, target: str):
    with database() as (db, pg):
        rows = sql(db, pg, """SELECT id,kind,status,progress,result,error_code,created_at,updated_at
            FROM norium_business_jobs WHERE user_id=? AND team_id=? AND workspace=?
            AND kind IN (?,?) ORDER BY created_at DESC LIMIT 20""",
            (require_user_id(user), require_team_id(user), current_workspace_id(), "import."+target, "import.preview."+target)).fetchall()
        return [exposed(row) for row in rows]


async def notify(job):
    from app.modules.inbox.router import manager
    # Only a wake-up identifier; recipients fetch their own authorized result.
    context = set_request_context("business-job-notification", job["workspace"])
    try:
        await manager.broadcast(job["user_id"], {"type": "BUSINESS_JOB_UPDATED", "jobId": job["id"], "workspace": job["workspace"]})
    except Exception:
        logger.warning("business_job_notification_deferred")
    finally:
        reset_request_context(context)


def claim():
    stamp = time.time()
    with database() as (db, pg):
        query = """SELECT * FROM norium_business_jobs WHERE kind IN
            ('import.clients','import.catalog','import.preview.clients','import.preview.catalog')
            AND (status='queued' OR (status='running' AND lease_until<?))
            ORDER BY created_at LIMIT 1"""
        row = sql(db, pg, query + (" FOR UPDATE SKIP LOCKED" if pg else ""), (stamp,)).fetchone()
        if not row:
            return None
        lease = uuid.uuid4().hex
        sql(db, pg, "UPDATE norium_business_jobs SET status='running',lease=?,lease_until=?,updated_at=? WHERE id=?", (lease, stamp+120, stamp, row["id"]))
        return {**dict(row), "lease": lease, "payload": json.loads(row["payload"])}


def apply_chunk(job: dict, operation):
    """Fence an idempotent internal effect and its progress under the job lock."""
    with database() as (db, pg):
        query = ("SELECT * FROM norium_business_jobs WHERE id=? FOR UPDATE" if pg else
                 "SELECT * FROM norium_business_jobs WHERE id=?")
        row = sql(db, pg, query, (job["id"],)).fetchone()
        if not row or row["status"] != "running" or row["lease"] != job["lease"] or row["lease_until"] <= time.time():
            raise RuntimeError("business_job_lease_lost")
        progress, result, completed = operation(dict(row))
        sql(db, pg, """UPDATE norium_business_jobs SET progress=?,result=?,status=?,
            lease_until=?,updated_at=?,payload=CASE WHEN ? THEN '{}' ELSE payload END WHERE id=? AND lease=?""",
            (progress, json.dumps(result, ensure_ascii=True), "completed" if completed else "running",
             time.time()+120, time.time(), completed, job["id"], job["lease"]))
        return completed


def fail(job: dict, code: str, *, keep_payload: bool = False):
    with database() as (db, pg):
        sql(db, pg, "UPDATE norium_business_jobs SET status='failed',error_code=?,payload=CASE WHEN ? THEN payload ELSE '{}' END,updated_at=? WHERE id=? AND lease=? AND status='running'", (code, keep_payload, time.time(), job["id"], job["lease"]))


def retry(user: dict, identifier: str):
    with database() as (db, pg):
        query = ("SELECT * FROM norium_business_jobs WHERE id=? AND user_id=? AND team_id=? AND workspace=? FOR UPDATE" if pg else
                 "SELECT * FROM norium_business_jobs WHERE id=? AND user_id=? AND team_id=? AND workspace=?")
        row = sql(db, pg, query,
                  (identifier, require_user_id(user), require_team_id(user), current_workspace_id())).fetchone()
        if not row:
            raise HTTPException(404, "Importação não encontrada.")
        if row["status"] != "failed" or row["error_code"] != "processing_unavailable":
            raise HTTPException(409, "Esta importação não pode ser retomada. Confira o estado atual.")
        if row["created_at"] + INPUT_TTL_SECONDS <= time.time():
            raise HTTPException(409, "O arquivo expirou. Selecione-o novamente para preparar outra prévia.")
        result = json.loads(row["result"])
        result["retryCount"] = int(result.get("retryCount", 0)) + 1
        sql(db, pg, "UPDATE norium_business_jobs SET status='queued',lease='',lease_until=0,error_code='',result=?,updated_at=? WHERE id=?", (json.dumps(result), time.time(), identifier))


async def live_user(job):
    from app.modules.auth.router import assert_route_permissions, effective_permissions, find_user, read_user_store
    store = await read_user_store()
    user = find_user(store, job["user_id"])
    owner = find_user(store, job["team_id"])
    if not user or user.get("status") != "ativo" or require_team_id(user) != job["team_id"]:
        raise PermissionError("job_actor_changed")
    if not owner or owner.get("status") != "ativo":
        raise PermissionError("job_team_changed")
    user = {**user, "permissions": effective_permissions(user)}
    assert_route_permissions(user, "/api/clientes" if job["kind"].endswith(".clients") else "/api/comercial")
    if job["workspace"] != "primary":
        account = await asyncio.to_thread(read_account_db, job["team_id"], "plataforma", {})
        if not any(item.get("id") == job["workspace"] and item.get("active", True) for item in account.get("workspaces", [])):
            raise PermissionError("job_workspace_changed")
    return user


def wake():
    if _wake is not None:
        _wake.set()


def expire_inputs():
    """Remove temporary inputs in bounded batches, preserving applied records."""
    from .store import mutate, snapshot
    stamp = time.time()
    with database() as (db, pg):
        query = ("""SELECT id,user_id,team_id,workspace,result FROM norium_business_jobs
            WHERE cleanup_at=0 AND created_at<? AND (status!='running' OR lease_until<?)
            ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED""" if pg else
            """SELECT id,user_id,team_id,workspace,result FROM norium_business_jobs
            WHERE cleanup_at=0 AND created_at<? AND (status!='running' OR lease_until<?)
            ORDER BY created_at LIMIT 50""")
        rows = sql(db, pg, query, (stamp-INPUT_TTL_SECONDS, stamp)).fetchall()
        for row in rows:
            context = set_request_context("business-input-expiration", row["workspace"])
            try:
                identity = {"id": row["user_id"], "teamOwnerId": row["team_id"]}
                previews = snapshot(identity, "import_previews")["items"]
                preview_id = json.loads(row["result"]).get("previewId")
                pending_preview_expiry = any(item.get("id") == preview_id and item.get("expiresAt", 0) > stamp for item in previews)
                if any(item.get("expiresAt", 0) <= stamp for item in previews):
                    def remove_expired(data):
                        data["items"] = [item for item in data["items"] if item.get("expiresAt", 0) > stamp]
                    mutate(identity, "import_previews", remove_expired)
                sql(db, pg, """UPDATE norium_business_jobs SET payload='{}',cleanup_at=?,
                    status=CASE WHEN status IN ('queued','running','failed') THEN 'failed' ELSE status END,
                    error_code=CASE WHEN status IN ('queued','running','failed') THEN 'expired_import' ELSE error_code END
                    WHERE id=?""", (0 if pending_preview_expiry else stamp, row["id"]))
            finally:
                reset_request_context(context)


async def worker():
    global _wake
    _wake = asyncio.Event()
    last_cleanup = 0.0
    try:
        while True:
            job = None
            try:
                if time.monotonic()-last_cleanup >= 300:
                    await asyncio.to_thread(expire_inputs)
                    last_cleanup = time.monotonic()
                if os.getenv("NORIUM_BUSINESS_WORKER_ENABLED", "1") == "1":
                    job = await asyncio.to_thread(claim)
                if job:
                    if job["created_at"]+INPUT_TTL_SECONDS <= time.time():
                        await mark_failure(job, "expired_import")
                        continue
                    context = set_request_context("business-job", job["workspace"])
                    try:
                        await notify(job)
                        from .imports import process_job
                        await process_job(job)
                        await notify(job)
                    finally:
                        reset_request_context(context)
                    continue
            except asyncio.CancelledError:
                raise
            except (HTTPException, PermissionError):
                if job:
                    await mark_failure(job, "permission_changed")
            except ValueError:
                if job:
                    await mark_failure(job, "invalid_import")
            except Exception:
                # Storage/transport failures are not classified as a safe retry.
                # The idempotent handler will reconcile its source receipts after
                # lease expiry; no raw customer row or exception is logged.
                logger.warning("business_job_deferred")
                if job:
                    await mark_failure(job, "processing_unavailable", keep_payload=True)
            try:
                await asyncio.wait_for(_wake.wait(), timeout=60)
            except asyncio.TimeoutError:
                pass
            _wake.clear()
    finally:
        _wake = None


async def mark_failure(job: dict, code: str, *, keep_payload: bool = False):
    """A failed checkpoint must not stop the worker or expose uploaded rows."""
    try:
        await asyncio.to_thread(fail, job, code, keep_payload=keep_payload)
        await notify(job)
    except Exception:
        logger.warning("business_job_checkpoint_deferred")
