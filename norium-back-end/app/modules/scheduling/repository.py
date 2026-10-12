from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.core.tenant import get_data_root, is_shared_environment
from app.infrastructure.persistence import postgres_store

_postgres_migration_guard = threading.Lock()
_postgres_migrated = False

class _CompatRow(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


class _Cursor:
    def __init__(self, cursor) -> None:
        self.cursor = cursor
        self.rowcount = cursor.rowcount

    @staticmethod
    def _row(value):
        return _CompatRow(value) if isinstance(value, dict) else value

    def fetchone(self):
        return self._row(self.cursor.fetchone())

    def fetchall(self):
        return [self._row(row) for row in self.cursor.fetchall()]


class _PostgresConnection:
    def __init__(self) -> None:
        self._context = postgres_store.connection()
        self.raw = self._context.__enter__()
        self.closed = False

    def execute(self, query: str, params=()):
        query = query.replace("datetime(b.start_at, '-' || s.buffer_before || ' minutes')", "(b.start_at::timestamptz - make_interval(mins => s.buffer_before))")
        query = query.replace("datetime(b.end_at, '+' || s.buffer_after || ' minutes')", "(b.end_at::timestamptz + make_interval(mins => s.buffer_after))")
        query = query.replace(" service_id IS ?", " service_id IS NOT DISTINCT FROM ?")
        return _Cursor(self.raw.execute(query.replace("?", "%s"), params))

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def close(self):
        if not self.closed:
            self.closed = True
            self._context.__exit__(None, None, None)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def opaque_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(18)}"


def public_id() -> str:
    return secrets.token_urlsafe(24)


def token_pair() -> tuple[str, str]:
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class SchedulingRepository:
    def __init__(self, path: str | Path | None = None) -> None:
        self.postgres = path is None and (postgres_store.configured() or postgres_store.required())
        self.path = Path(path) if path else get_data_root() / "scheduling.sqlite3"
        if not self.postgres:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.postgres:
            global _postgres_migrated
            with _postgres_migration_guard:
                if not _postgres_migrated:
                    self.migrate()
                    _postgres_migrated = True
        else:
            self.migrate()

    def _connection_target(self) -> tuple[str, bool]:
        configured_vfs = os.getenv("NORIUM_SCHEDULING_SQLITE_VFS", "").strip()
        if configured_vfs not in ("", "unix-dotfile"):
            raise ValueError("Unsupported scheduling SQLite VFS")
        # Azure Files is an SMB volume. SQLite WAL and its default POSIX
        # byte-range locks are not safe there; dotfile locking serializes the
        # single-writer production runtime without disabling locking.
        vfs = configured_vfs or ("unix-dotfile" if is_shared_environment() else "")
        if vfs:
            return self.path.resolve().as_uri() + f"?vfs={vfs}", True
        return str(self.path), False

    def connect(self):
        if self.postgres:
            return _PostgresConnection()
        target, uri = self._connection_target()
        db = sqlite3.connect(target, uri=uri, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA busy_timeout = 30000")
        return db

    def migrate(self) -> None:
        migrations = sorted((Path(__file__).parent / "migrations").glob("*.sql"))
        db = self.connect()
        try:
            if self.postgres:
                for migration in migrations:
                    source = "\n".join(
                        line for line in migration.read_text(encoding="utf-8").splitlines()
                        if not line.lstrip().upper().startswith("PRAGMA ")
                    )
                    for statement in source.split(";"):
                        if statement.strip():
                            db.execute(statement)
                db.execute("ALTER TABLE scheduling_bookings ADD COLUMN IF NOT EXISTS completion_type TEXT")
                db.commit()
                return
            # DELETE journaling is supported by Azure Files; WAL is not.
            db.execute("PRAGMA journal_mode = DELETE")
            for migration in migrations:
                db.executescript(migration.read_text(encoding="utf-8"))
            columns = {row["name"] for row in db.execute("PRAGMA table_info(scheduling_bookings)").fetchall()}
            if "completion_type" not in columns:
                db.execute("ALTER TABLE scheduling_bookings ADD COLUMN completion_type TEXT")
        finally:
            db.close()

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        db = self.connect()
        try:
            if not self.postgres:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        for key in tuple(result):
            if key.endswith("_json"):
                result[key.removesuffix("_json")] = json.loads(result.pop(key) or "null")
        for key in ("active",):
            if key in result:
                result[key] = bool(result[key])
        return result

    def all(self, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        db = self.connect()
        try:
            return [self.decode(row) or {} for row in db.execute(query, params).fetchall()]
        finally:
            db.close()

    def one(self, query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        db = self.connect()
        try:
            return self.decode(db.execute(query, params).fetchone())
        finally:
            db.close()

    @staticmethod
    def audit(db: sqlite3.Connection, scope: tuple[str, str, str], action: str, entity_type: str, entity_id: str, metadata: dict[str, Any] | None = None) -> None:
        tenant_id, workspace_id, actor_id = scope
        db.execute(
            "INSERT INTO scheduling_audit VALUES (?,?,?,?,?,?,?,?,?)",
            (opaque_id("audit"), tenant_id, workspace_id, actor_id, action, entity_type, entity_id,
             json.dumps(metadata or {}, ensure_ascii=False), now_iso()),
        )

    def lock_slot(self, db, service_id: str, responsible_id: str, start_at: str) -> None:
        if self.postgres:
            db.execute("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (f"{service_id}:{responsible_id}:{start_at}",))

    @staticmethod
    def is_integrity_error(error: BaseException) -> bool:
        if isinstance(error, sqlite3.IntegrityError):
            return True
        current: BaseException | None = error
        while current is not None:
            if current.__class__.__module__.startswith("psycopg") and current.__class__.__name__ in {
                "IntegrityError", "UniqueViolation", "ForeignKeyViolation", "CheckViolation"
            }:
                return True
            current = current.__cause__
        return False
