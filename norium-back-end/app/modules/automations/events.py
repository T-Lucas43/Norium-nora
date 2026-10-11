"""Durable event delivery. Only explicitly enabled event triggers are eligible.

A claimed job is never automatically retried: a crash during an external send
has an unknown outcome, so retrying could send the same message twice.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone

from app.core.request_context import current_workspace_id, set_request_context, reset_request_context
from app.core.tenant import get_data_root, read_user_db, read_account_db
from app.infrastructure.persistence import postgres_store

logger = logging.getLogger(__name__)
automation_origin = contextvars.ContextVar("automation_origin", default=False)
_postgres_schema_guard = threading.Lock()
_postgres_schema_ready = False
EVENT_TYPES = {"whatsapp.received", "team.message", "team.mentioned", "gmail.received", "task.created", "task.updated", "task.comment", "finance.created", "finance.updated", "calendar.created", "calendar.updated"}


class _PostgresAutomationConnection:
    postgres = True

    def __init__(self):
        self._context = postgres_store.connection()
        self.raw = self._context.__enter__()
        self.closed = False

    def execute(self, query, params=()):
        normalized = query.replace("INSERT OR IGNORE INTO", "INSERT INTO")
        if "INSERT OR IGNORE INTO" in query:
            normalized += " ON CONFLICT DO NOTHING"
        if normalized.strip().upper() == "BEGIN IMMEDIATE":
            normalized = "BEGIN"
        normalized = re.sub(r"\bjobs\b", "automation_jobs", normalized)
        return self.raw.execute(normalized.replace("?", "%s"), params)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.raw.rollback() if exc_type else self.raw.commit()
        finally:
            self.close()

    def close(self):
        if not self.closed:
            self.closed = True
            self._context.__exit__(None, None, None)


def connection():
    if postgres_store.configured() or postgres_store.required():
        global _postgres_schema_ready
        db = _PostgresAutomationConnection()
        try:
            with _postgres_schema_guard:
                if not _postgres_schema_ready:
                    db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
                automation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
                finished_at TEXT, error TEXT, lease_until DOUBLE PRECISION NOT NULL DEFAULT 0)""")
                    db.execute("CREATE INDEX IF NOT EXISTS automation_jobs_status ON jobs(status, created_at)")
                    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS automation_one_running_scope ON jobs(user_id,workspace_id) WHERE status='running'")
                    db.raw.commit()
                    _postgres_schema_ready = True
            return db
        except Exception:
            db.close()
            raise
    db = sqlite3.connect(get_data_root() / "automation_events.sqlite3", timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        automation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
        finished_at TEXT, error TEXT, lease_until REAL NOT NULL DEFAULT 0)""")
    if "lease_until" not in {row[1] for row in db.execute("PRAGMA table_info(jobs)")}:
        db.execute("ALTER TABLE jobs ADD COLUMN lease_until REAL NOT NULL DEFAULT 0")
    db.execute("CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at)")
    return db


def event_type(event):
    source, meta = event.get("source"), event.get("metadata") or {}
    action = meta.get("action")
    if source == "whatsapp" and meta.get("messageId") and meta.get("fromMe") is False:
        return "whatsapp.received"
    if source == "equipe" and meta.get("senderId") != meta.get("userId"):
        return {"team_message_created": "team.message", "team_member_mentioned": "team.mentioned"}.get(action)
    if source == "gmail" and event.get("title") == "E-mail recebido" and meta.get("messageId"):
        return "gmail.received"
    if source == "kanban":
        return {"task_created": "task.created", "task_updated": "task.updated", "task_comment_added": "task.comment"}.get(action)
    if source == "financeiro":
        return {"finance_entry_created": "finance.created", "finance_entry_updated": "finance.updated"}.get(action)
    if source == "calendar":
        return {"Compromisso criado": "calendar.created", "Compromisso atualizado": "calendar.updated"}.get(event.get("title"))
    return None


def trigger_config(automation):
    nodes = (automation.get("flow") or {}).get("nodes") or []
    return next((node.get("config") or {} for node in nodes if node.get("kind") == "trigger"), {})


def fingerprint(automation):
    # Ignore run counters; edits invalidate queued jobs so a newly changed
    # destination cannot receive an older event unexpectedly.
    payload = {key: automation.get(key) for key in ("flow", "variables", "active", "requiresApproval", "actions")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def matches(automation, event):
    config = trigger_config(automation)
    if not automation.get("active") or automation.get("requiresApproval") or (automation.get("variables") or {}).get("approvalRequired") == "true" or config.get("automatic") != "true":
        return False
    if config.get("eventType") not in EVENT_TYPES or config.get("eventType") != event_type(event):
        return False
    try:
        enabled = datetime.fromisoformat(config["enabledAt"].replace("Z", "+00:00"))
        occurred = datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00"))
        if enabled.tzinfo is None or occurred.tzinfo is None or occurred < enabled:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    meta = event.get("metadata") or {}
    for field, event_field in (("sourceId", "conversaId"), ("senderId", "senderId"), ("scope", "scope"), ("subteamId", "subteamId"), ("projectId", "projectId"), ("taskStatus", "status")):
        expected, actual = str(config.get(field) or ""), str(meta.get(event_field) or "")
        if field == "sourceId":
            expected = re.sub(r"@(s.whatsapp.net|c.us)$", "", expected)
            actual = re.sub(r"@(s.whatsapp.net|c.us)$", "", actual)
        if expected and expected != actual:
            return False
    contains = str(config.get("contains") or "").strip().casefold()
    return not contains or contains in f'{event.get("title", "")} {event.get("description", "")}'.casefold()


def enqueue_event(event, workspace_id):
    user_id = str((event.get("metadata") or {}).get("userId") or "")
    if not user_id or not event_type(event):
        return
    # Never create demonstration automations as a side effect of an event.
    store = read_user_db(user_id, "automacoes", {})
    eligible = [item for item in store.get("automations", []) if matches(item, event)]
    if not eligible:
        return
    meta = event.get("metadata") or {}
    event_key = str(meta.get("messageId") or event.get("id") or "")
    if not event_key:
        return
    db = connection()
    try:
        with db:
            for automation in eligible:
                key = json.dumps([user_id, workspace_id, automation["id"], event_type(event), event_key])
                db.execute("INSERT OR IGNORE INTO jobs(id,user_id,workspace_id,automation_id,fingerprint,event,created_at) VALUES(?,?,?,?,?,?,?)",
                           (hashlib.sha256(key.encode()).hexdigest(), user_id, workspace_id, automation["id"], fingerprint(automation), json.dumps(event), datetime.now(timezone.utc).isoformat()))
    finally:
        db.close()


async def publish_event(event):
    if automation_origin.get():
        return
    try:
        await asyncio.to_thread(enqueue_event, event, current_workspace_id())
        _wake_worker()
    except Exception:
        logger.exception("Falha ao enfileirar evento de automação")


# O worker dorme sem consultar o banco e acorda quando um evento é enfileirado.
_wake: asyncio.Event | None = None
_WORKER_IDLE_MAX_SECONDS = 30.0


def _wake_worker() -> None:
    if _wake is not None:
        _wake.set()


def claim_job():
    db = connection()
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE jobs SET status='interrupted',finished_at=?,error=? WHERE status='running' AND lease_until<?",
                       (datetime.now(timezone.utc).isoformat(), "O executor perdeu a conexão. Confira o canal antes de repetir o envio.", time.time()))
            pending_query = """SELECT * FROM jobs candidate WHERE status='pending'
                AND NOT EXISTS (SELECT 1 FROM jobs running WHERE running.status='running'
                AND running.user_id=candidate.user_id AND running.workspace_id=candidate.workspace_id)
                ORDER BY created_at LIMIT 1"""
            locked_query = """SELECT * FROM jobs candidate WHERE status='pending'
                AND NOT EXISTS (SELECT 1 FROM jobs running WHERE running.status='running'
                AND running.user_id=candidate.user_id AND running.workspace_id=candidate.workspace_id)
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"""
            row = db.execute(locked_query if getattr(db, "postgres", False) else pending_query).fetchone()
            if row:
                try:
                    updated = db.execute("UPDATE jobs SET status='running',lease_until=? WHERE id=? AND status='pending'", (time.time() + 90, row["id"]))
                except Exception as exc:
                    if getattr(db, "postgres", False) and getattr(exc, "sqlstate", None) == "23505":
                        db.raw.rollback()
                        return None
                    raise
                if updated.rowcount != 1:
                    return None
                return dict(row)
    finally:
        db.close()
    return None


def finish_job(job_id, status, error=None):
    db = connection()
    try:
        with db:
            db.execute("UPDATE jobs SET status=?,finished_at=?,error=? WHERE id=?", (status, datetime.now(timezone.utc).isoformat(), error, job_id))
    finally:
        db.close()


def renew_lease(job_id):
    db = connection()
    try:
        with db:
            db.execute("UPDATE jobs SET lease_until=? WHERE id=? AND status='running'", (time.time() + 90, job_id))
    finally:
        db.close()


async def heartbeat(job_id):
    while True:
        await asyncio.sleep(15)
        await asyncio.to_thread(renew_lease, job_id)


def recent_jobs(user_id, workspace_id):
    db = connection()
    try:
        return [dict(row) for row in db.execute(
            "SELECT id,automation_id,status,created_at,finished_at,error FROM jobs WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 30",
            (user_id, workspace_id))]
    finally:
        db.close()


async def process_job(job):
    from app.modules.automations.router import execute_automation
    from app.routers.auth_router import read_user_store, assert_route_permissions, sanitize_user
    tokens = set_request_context(f'automation:{job["id"]}', job["workspace_id"])
    origin_token = automation_origin.set(True)
    lease = asyncio.create_task(heartbeat(job["id"]))
    try:
        users = await read_user_store()
        actor = next((sanitize_user(item) for item in users.get("users", []) if str(item.get("id")) == job["user_id"]), None)
        if not actor or actor.get("status") != "ativo":
            raise ValueError("Conta inativa")
        assert_route_permissions(actor, "/api/automacoes")
        if job["workspace_id"] != "primary":
            account = read_account_db(str(actor.get("teamOwnerId") or actor["id"]), "plataforma", {})
            if not any(item.get("id") == job["workspace_id"] and item.get("active", True) for item in account.get("workspaces", [])):
                raise ValueError("Workspace indisponível para esta conta")
        store = read_user_db(job["user_id"], "automacoes", {})
        automation = next((item for item in store.get("automations", []) if item.get("id") == job["automation_id"]), None)
        event = json.loads(job["event"])
        if not automation or fingerprint(automation) != job["fingerprint"] or not matches(automation, event):
            await asyncio.to_thread(finish_job, job["id"], "cancelled")
            return
        result = await execute_automation(job["user_id"], job["automation_id"], "Gatilho automático", event=event)
        log = result["historyItem"]
        await asyncio.to_thread(finish_job, job["id"], "failed" if log["status"] == "erro" else "done", log.get("error"))
    except asyncio.CancelledError:
        await asyncio.to_thread(finish_job, job["id"], "interrupted", "Execução interrompida; confira o histórico antes de executar novamente.")
        raise
    except Exception:
        logger.exception("Falha no disparo automático")
        await asyncio.to_thread(finish_job, job["id"], "failed", "Falha ao executar o evento. Consulte os logs do servidor.")
    finally:
        lease.cancel()
        try:
            await lease
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Falha ao renovar a reserva de execução")
        automation_origin.reset(origin_token)
        reset_request_context(tokens)


async def worker():
    global _wake
    _wake = asyncio.Event()
    idle = 1.0
    while True:
        try:
            _wake.clear()
            job = await asyncio.to_thread(claim_job)
            if job:
                idle = 1.0
                await process_job(job)
            else:
                # Sem fila: espera crescente (1 s → 30 s) e acorda na hora com um evento novo.
                try:
                    await asyncio.wait_for(_wake.wait(), timeout=idle)
                    idle = 1.0
                except asyncio.TimeoutError:
                    idle = min(idle * 2, _WORKER_IDLE_MAX_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Falha no worker de automações")
            await asyncio.sleep(5)
