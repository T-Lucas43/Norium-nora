"""Transactional brain storage. PostgreSQL in shared environments; SQLite in tests.

JSON here is a versioned SQL record, never the legacy business JSON directory.
An interrupted transaction cannot replace an unreadable record with an empty one.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
import base64
import binascii
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

from app.infrastructure.persistence.postgres_tls import production_tls_mode_allowed

from .contracts import BrainError, Scope, Submit, TERMINAL, canonical, fingerprint


SCHEMA = (
    "CREATE TABLE IF NOT EXISTS nora_schema (version INTEGER PRIMARY KEY)",
    "INSERT INTO nora_schema(version) VALUES (1) ON CONFLICT DO NOTHING",
    """CREATE TABLE IF NOT EXISTS nora_jobs (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL, workspace TEXT NOT NULL,
        request_key TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL,
        updated DOUBLE PRECISION NOT NULL, lease_until DOUBLE PRECISION NOT NULL DEFAULT 0,
        payload TEXT NOT NULL, UNIQUE(tenant,actor,workspace,request_key))""",
    "CREATE INDEX IF NOT EXISTS nora_queue ON nora_jobs(state,lease_until,updated)",
    """CREATE TABLE IF NOT EXISTS nora_events (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        workspace TEXT NOT NULL, at DOUBLE PRECISION NOT NULL, expires DOUBLE PRECISION NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS nora_event_scope ON nora_events(tenant,actor,workspace,at)",
    "CREATE INDEX IF NOT EXISTS nora_event_job ON nora_events(job_id,at)",
    """CREATE TABLE IF NOT EXISTS nora_budget (
        account TEXT PRIMARY KEY, period TEXT NOT NULL, used BIGINT NOT NULL DEFAULT 0,
        reserved BIGINT NOT NULL DEFAULT 0)""",
    """CREATE TABLE IF NOT EXISTS nora_preferences (
        tenant TEXT NOT NULL, actor TEXT NOT NULL, workspace TEXT NOT NULL, name TEXT NOT NULL,
        value TEXT NOT NULL, source TEXT NOT NULL, updated DOUBLE PRECISION NOT NULL,
        PRIMARY KEY(tenant,actor,workspace,name))""",
    """CREATE TABLE IF NOT EXISTS nora_tombstones (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, at DOUBLE PRECISION NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS nora_internal_nonces (
        nonce TEXT PRIMARY KEY, expires DOUBLE PRECISION NOT NULL)""",
)


class Repository:
    def __init__(self, url: str, *, clock: Callable[[], float] = time.time):
        self.url, self.clock = url, clock
        self.postgres = url.startswith(("postgresql://", "postgres://"))
        if not self.postgres and not url.startswith("sqlite:///"):
            raise BrainError("database_configuration_required", 503)
        if not self.postgres:
            from app.core.tenant import is_local_or_test_environment
            if not is_local_or_test_environment(require_explicit=True):
                raise BrainError("postgresql_required", 503)
            self.path = url.removeprefix("sqlite:///")
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def transaction(self):
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            from app.core.tenant import is_local_or_test_environment
            local = is_local_or_test_environment(require_explicit=True)
            sslmode = os.getenv("NORA_BRAIN_DB_SSLMODE", "prefer" if local else "verify-full").strip().lower()
            if not production_tls_mode_allowed(sslmode, local=local):
                raise BrainError("postgresql_tls_verification_required", 503)
            sslrootcert = os.getenv("NORA_BRAIN_DB_SSLROOTCERT", "system" if not local and sslmode == "verify-full" else "").strip()
            tls_options = {"sslrootcert": sslrootcert} if sslrootcert else {}
            connection = psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5, sslmode=sslmode, **tls_options)
        else:
            connection = sqlite3.connect(self.path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def sql(self, connection, statement, params=()):
        return connection.execute(statement.replace("?", "%s") if self.postgres else statement, params)

    def initialize(self):
        with self.transaction() as connection:
            for statement in SCHEMA:
                self.sql(connection, statement)
            versions = [row["version"] for row in self.sql(connection, "SELECT version FROM nora_schema")]
            if versions != [1]:
                raise BrainError("unsupported_database_version", 503)

    def ping(self):
        with self.transaction() as connection:
            row = self.sql(connection, "SELECT version FROM nora_schema").fetchone()
            if row is None or row["version"] != 1:
                raise BrainError("brain_storage_unavailable", 503)
        return {"status": "ready", "driver": "postgresql" if self.postgres else "sqlite"}

    def consume_nonce(self, nonce, expires):
        with self.transaction() as connection:
            self.sql(connection, "DELETE FROM nora_internal_nonces WHERE expires<=?", (self.clock(),))
            cursor = self.sql(connection, "INSERT INTO nora_internal_nonces(nonce,expires) VALUES (?,?) ON CONFLICT DO NOTHING",
                              (nonce, expires))
            if cursor.rowcount != 1:
                raise BrainError("internal_request_replayed", 409)

    def _read(self, connection, job_id, scope=None, *, lock=False):
        query, params = "SELECT * FROM nora_jobs WHERE id=?", [job_id]
        if scope is not None:
            query += " AND tenant=? AND actor=? AND workspace=?"
            params.extend((scope.tenant, scope.user, scope.workspace))
        if lock and self.postgres:
            query += " FOR UPDATE"
        row = self.sql(connection, query, params).fetchone()
        if row is None:
            raise BrainError("job_not_found", 404)
        try:
            job = json.loads(row["payload"])
            if (not isinstance(job, dict) or job["id"] != row["id"] or
                    job["scope"] != {"tenant": row["tenant"], "user": row["actor"], "workspace": row["workspace"]}
                    or not isinstance(job["steps"], list) or job["schema"] != 1):
                raise ValueError()
            return job
        except (ValueError, KeyError, TypeError):
            raise BrainError("brain_storage_invalid", 503) from None

    def _save(self, connection, job):
        job["updatedAt"] = self.clock()
        job["revision"] += 1
        self.sql(connection, "UPDATE nora_jobs SET payload=?,state=?,updated=?,lease_until=? WHERE id=?",
                 (canonical(job), job["status"], job["updatedAt"], job.get("leaseUntil", 0), job["id"]))

    def event(self, connection, job, kind, evidence):
        scope, now = job["scope"], self.clock()
        event_id = uuid.uuid4().hex
        previous_id = job.get("lastEventId")
        envelope = {
            "schema": 1,
            "eventId": event_id,
            "previousEventId": previous_id,
            "jobId": job["id"],
            "stepId": evidence.get("step") if isinstance(evidence, dict) else None,
            "operationId": (evidence.get("operationId") or evidence.get("step")) if isinstance(evidence, dict) else None,
            "scope": scope,
            "requester": scope["user"],
            "executor": "nora-brain-worker" if job.get("lease") else scope["user"],
            "leaseVersion": job.get("lease") or None,
            "profile": job.get("profile"),
            "kind": kind,
            "evidence": evidence,
        }
        self.sql(connection, "INSERT INTO nora_events VALUES (?,?,?,?,?,?,?,?,?)",
                 (event_id, job["id"], scope["tenant"], scope["user"], scope["workspace"],
                  now, now + 365 * 86400, kind, canonical(envelope)))
        job["lastEventId"] = event_id

    def forfeit_reservation(self, connection, job, reason):
        """Conservatively charge usage whose provider measurement was lost."""
        reservation = job.pop("reservation", None)
        if not isinstance(reservation, dict):
            return False
        tokens = int(reservation.get("tokens") or 0)
        accounts = reservation.get("accounts") or []
        if tokens <= 0 or not accounts or job["budget"].get("reserved", 0) < tokens:
            raise BrainError("brain_budget_invalid", 503)
        for account in accounts:
            cursor = self.sql(connection, """UPDATE nora_budget SET reserved=reserved-?,used=used+?
                WHERE account=? AND reserved>=?""", (tokens, tokens, account, tokens))
            if cursor.rowcount != 1:
                raise BrainError("brain_budget_invalid", 503)
        job["budget"]["reserved"] -= tokens
        job["budget"]["tokens"] += tokens
        self.event(connection, job, "model_reservation_charged", {"tokens": tokens, "reason": reason})
        return True

    def create(self, scope: Scope, request: Submit):
        if request.category == "complex" and not request.complexBudgetApproved:
            raise BrainError("complex_budget_approval_required", 422)
        now, digest = self.clock(), fingerprint(request.model_dump(exclude={"requestId"}))
        job = {"schema": 1, "id": uuid.uuid4().hex, "scope": scope.as_dict(), "revision": 0,
               "message": request.message, "attachments": request.attachmentIds, "profile": request.category,
               "status": "queued", "steps": [], "notes": [], "result": "", "createdAt": now,
               "updatedAt": now, "lease": "", "leaseUntil": 0, "cancelRequested": False,
               "budget": {"tokens": 0, "reserved": 0, "calls": 0, "tools": 0, "seconds": 0}}
        with self.transaction() as connection:
            self.sql(connection, """INSERT INTO nora_jobs
                (id,tenant,actor,workspace,request_key,request_hash,state,updated,payload)
                VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,actor,workspace,request_key) DO NOTHING""",
                (job["id"], scope.tenant, scope.user, scope.workspace, request.requestId, digest,
                 job["status"], now, canonical(job)))
            row = self.sql(connection, "SELECT id,request_hash FROM nora_jobs WHERE tenant=? AND actor=? AND workspace=? AND request_key=?",
                           (scope.tenant, scope.user, scope.workspace, request.requestId)).fetchone()
            if row["request_hash"] != digest:
                raise BrainError("request_key_conflict")
            if row["id"] == job["id"]:
                self.event(connection, job, "created", {"profile": request.category})
                self._save(connection, job)
            return self._read(connection, row["id"], scope)

    def get(self, job_id, scope=None):
        with self.transaction() as connection:
            return self._read(connection, job_id, scope)

    def mutate(self, job_id, scope, change, *, lease=None):
        with self.transaction() as connection:
            job = self._read(connection, job_id, scope, lock=True)
            if lease is not None and (job.get("lease") != lease or job.get("leaseUntil", 0) <= self.clock()):
                raise BrainError("lease_lost")
            change(job, connection)
            self._save(connection, job)
            return job

    def list(self, scope, cursor=None):
        updated, item_id = self.clock() + 1, "~"
        if cursor:
            try:
                decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode())
                updated, item_id = float(decoded["updated"]), str(decoded["id"])
            except (ValueError, KeyError, TypeError, json.JSONDecodeError, binascii.Error):
                raise BrainError("invalid_cursor", 422) from None
        with self.transaction() as connection:
            rows = self.sql(connection, """SELECT id FROM nora_jobs WHERE tenant=? AND actor=? AND workspace=?
                AND (updated<? OR (updated=? AND id<?)) ORDER BY updated DESC,id DESC LIMIT 21""",
                (scope.tenant, scope.user, scope.workspace, updated, updated, item_id)).fetchall()
            items = [self._read(connection, row["id"], scope) for row in rows[:20]]
            next_cursor = None
            if len(rows) > 20 and items:
                token = canonical({"updated": items[-1]["updatedAt"], "id": items[-1]["id"]}).encode()
                next_cursor = base64.urlsafe_b64encode(token).decode().rstrip("=")
            return {"items": items, "nextCursor": next_cursor}

    def claim(self):
        now = self.clock()
        with self.transaction() as connection:
            # An expired review can never be approved. Return it to the queue so
            # the worker prepares a fresh, exact operation with a new digest.
            expired_query = "SELECT id FROM nora_jobs WHERE state='awaiting_approval' ORDER BY updated LIMIT 20"
            if self.postgres:
                expired_query += " FOR UPDATE SKIP LOCKED"
            for expired_row in self.sql(connection, expired_query).fetchall():
                expired_job = self._read(connection, expired_row["id"])
                expired_steps = [
                    step for step in expired_job["steps"]
                    if step.get("status") == "awaiting_approval"
                    and step.get("approval", {}).get("expiresAt", now + 1) <= now
                ]
                if not expired_steps:
                    continue
                for expired_step in expired_steps:
                    expired_step["status"] = "planned"
                    expired_step["approval"]["expiredAt"] = now
                    self.event(connection, expired_job, "approval_expired", {
                        "step": expired_step["id"],
                        "approvalId": expired_step["approval"].get("id"),
                        "digest": expired_step["approval"].get("digest"),
                    })
                expired_job["status"] = "queued"
                expired_job["result"] = "A revisão expirou; uma nova versão exata será preparada."
                self._save(connection, expired_job)
            query = "SELECT id FROM nora_jobs WHERE state IN ('queued','running') AND lease_until<=? ORDER BY updated LIMIT 1"
            if self.postgres:
                query += " FOR UPDATE SKIP LOCKED"
            row = self.sql(connection, query, (now,)).fetchone()
            if row is None:
                return None
            job = self._read(connection, row["id"])
            if job.get("lease"):
                # An expired lease proves nothing about acceptance at a remote provider.
                self.forfeit_reservation(connection, job, "executor_lease_expired")
                for step in job["steps"]:
                    if step["status"] == "executing":
                        step["status"] = "unknown"
                job["status"] = "unknown" if any(s["status"] == "unknown" for s in job["steps"]) else "budget_paused"
                job["result"] = "Execução interrompida. É necessário reconciliar o resultado antes de continuar."
                job["lease"], job["leaseUntil"] = "", 0
                self.event(connection, job, "lease_expired", {"status": job["status"]})
                self._save(connection, job)
                return None
            job["lease"], job["leaseUntil"], job["status"] = uuid.uuid4().hex, now + 120, "running"
            self._save(connection, job)
            return job

    def release(self, job_id, lease):
        def change(job, connection):
            if job["status"] == "running":
                job["status"] = "queued"
            job["lease"], job["leaseUntil"] = "", 0
            if job["status"] in TERMINAL:
                job.setdefault("closedAt", self.clock())
        return self.mutate(job_id, None, change, lease=lease)

    def cancel(self, job_id, scope):
        def change(job, connection):
            job["cancelRequested"] = True
            if job["status"] not in TERMINAL and not job.get("lease"):
                job["status"] = "unknown" if any(s["status"] == "unknown" for s in job["steps"]) else "cancelled"
                if job["status"] == "cancelled":
                    job["closedAt"] = self.clock()
            self.event(connection, job, "cancel_requested", {})
        return self.mutate(job_id, scope, change)

    def cleanup(self):
        """Expiry is maintenance, never an instruction delegated to the model."""
        now = self.clock()
        with self.transaction() as connection:
            rows = self.sql(connection, "SELECT id FROM nora_jobs WHERE state IN ('completed','cancelled','failed')").fetchall()
            for row in rows:
                job = self._read(connection, row["id"], lock=True)
                closed = job.get("closedAt", job["updatedAt"])
                if closed + 7 * 86400 <= now and (job["message"] or job["notes"] or job["attachments"]):
                    job["message"], job["notes"], job["attachments"] = "", [], []
                    for step in job["steps"]:
                        step.pop("arguments", None)
                        step.pop("prepared", None)
                        step.pop("result", None)
                    self.sql(connection, "INSERT INTO nora_tombstones VALUES (?,?,?) ON CONFLICT DO NOTHING", (job["id"], "context", now))
                    self._save(connection, job)
                if closed + 90 * 86400 <= now and (job["steps"] or job["result"] != "Resultado expirado."):
                    job["steps"], job["result"] = [], "Resultado expirado."
                    self.sql(connection, "INSERT INTO nora_tombstones VALUES (?,?,?) ON CONFLICT DO NOTHING", (job["id"] + ":summary", "summary", now))
                    self._save(connection, job)
            self.sql(connection, "DELETE FROM nora_events WHERE expires<=?", (now,))


def configured_repository() -> Repository:
    url = os.getenv("NORA_BRAIN_DATABASE_URL", "")
    if not url:
        raise BrainError("brain_not_configured", 503)
    return Repository(url)
