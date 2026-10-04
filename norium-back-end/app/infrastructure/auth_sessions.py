"""Authoritative sessions. PostgreSQL in shared runtimes; SQLite only locally.

Account row locks serialize creation, rotation and revocation across replicas.
Only hashes of refresh/CSRF credentials are stored. Cookie values never enter
documents, audit events or logs. All variable SQL values use bound parameters.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any

from app.core.tenant import get_data_root, is_local_or_test_environment
from app.infrastructure.persistence import postgres_store

ABSOLUTE_SECONDS = 7 * 24 * 3600
IDLE_SECONDS = 24 * 3600
ACCESS_SECONDS = 15 * 60
RECENT_SECONDS = 5 * 60
MAX_SESSIONS = 20
EVENT_RETENTION_SECONDS = 30 * 24 * 3600
MAX_EVENTS_PER_ACCOUNT = 500
_schema_guard = threading.Lock()
_postgres_initialized = False
_sqlite_initialized: set[str] = set()


def persistence_enabled() -> bool:
    configured = os.getenv("NORIUM_PERSISTENT_SESSIONS_ENABLED", "").strip().lower()
    if configured:
        return configured in {"1", "true", "yes"}
    return is_local_or_test_environment()


class SessionError(ValueError):
    def __init__(self, code: str, status: int = 401):
        super().__init__(code)
        self.code, self.status = code, status


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def credential() -> str:
    return secrets.token_urlsafe(32)


def metadata(agent: str) -> tuple[str, str, str]:
    # A display hint, never a device identity or an authorization input.
    text = agent[:512].lower()
    browser = next((name for marker, name in (("edg", "Edge"), ("firefox", "Firefox"),
        ("chrome", "Chrome"), ("safari", "Safari")) if marker in text), "Navegador")
    system = next((name for marker, name in (("android", "Android"), ("iphone", "iOS"),
        ("ipad", "iPadOS"), ("windows", "Windows"), ("macintosh", "macOS"),
        ("linux", "Linux")) if marker in text), "Sistema não identificado")
    kind = "Tablet" if "ipad" in text or ("android" in text and "mobile" not in text) else (
        "Celular" if "mobile" in text or "iphone" in text else "Computador")
    return browser, system, kind


class _Database:
    def __init__(self, db: Any, postgres: bool):
        self.db, self.postgres = db, postgres

    def execute(self, query: str, values: tuple = ()):
        return self.db.execute(query if self.postgres else query.replace("%s", "?"), values)


_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS norium_auth_schema (
        id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS norium_auth_accounts (
        user_id TEXT PRIMARY KEY, epoch BIGINT NOT NULL DEFAULT 0)""",
    """CREATE TABLE IF NOT EXISTS norium_auth_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, version BIGINT NOT NULL,
        created BIGINT NOT NULL, authenticated BIGINT NOT NULL, last_activity BIGINT NOT NULL,
        expires BIGINT NOT NULL, persistent INTEGER NOT NULL, revoked BIGINT,
        browser TEXT NOT NULL, system TEXT NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '', csrf_hash TEXT NOT NULL,
        last_rotation BIGINT NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES norium_auth_accounts(user_id))""",
    """CREATE TABLE IF NOT EXISTS norium_auth_credentials (
        hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, consumed BIGINT,
        FOREIGN KEY(session_id) REFERENCES norium_auth_sessions(id) ON DELETE CASCADE)""",
    "CREATE INDEX IF NOT EXISTS norium_auth_user_sessions ON norium_auth_sessions(user_id,expires)",
    "CREATE INDEX IF NOT EXISTS norium_auth_session_credentials ON norium_auth_credentials(session_id)",
    """CREATE TABLE IF NOT EXISTS norium_auth_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
        action TEXT NOT NULL, created BIGINT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES norium_auth_accounts(user_id))""",
    "CREATE INDEX IF NOT EXISTS norium_auth_user_events ON norium_auth_events(user_id,created)",
)


def _initialize_schema(db: _Database) -> None:
    for statement in _SCHEMA:
        db.execute(statement)
    db.execute("INSERT INTO norium_auth_schema(id,version) VALUES (1,1) ON CONFLICT(id) DO NOTHING")
    if db.execute("SELECT version FROM norium_auth_schema WHERE id=1").fetchone()["version"] != 1:
        raise postgres_store.PostgresStoreError("auth_session_schema_version_unsupported")


def _event(db: _Database, user_id: str, action: str, sid: str | None = None) -> None:
    # Fixed action labels and opaque IDs only; no cookie, password, IP or agent.
    now = int(time.time())
    db.execute("INSERT INTO norium_auth_events(id,user_id,session_id,action,created) VALUES (%s,%s,%s,%s,%s)",
               (secrets.token_urlsafe(18), user_id, sid, action, now))
    db.execute("""DELETE FROM norium_auth_events WHERE user_id=%s AND (created<=%s OR id IN
        (SELECT id FROM norium_auth_events WHERE user_id=%s ORDER BY created DESC,id DESC LIMIT 1000 OFFSET %s))""",
        (user_id, now - EVENT_RETENTION_SECONDS, user_id, MAX_EVENTS_PER_ACCOUNT))


@contextmanager
def transaction(*, read_only: bool = False):
    global _postgres_initialized
    if postgres_store.configured():
        from psycopg import Error as DatabaseError
        try:
            postgres_store.initialize()
            if not _postgres_initialized:
                with _schema_guard:
                    if not _postgres_initialized:
                        with postgres_store.connection() as connection:
                            db = _Database(connection, True)
                            db.execute("SET LOCAL lock_timeout = '5s'")
                            db.execute("SELECT pg_advisory_xact_lock(hashtextextended('norium:auth-schema', 0))")
                            _initialize_schema(db)
                        _postgres_initialized = True
            with postgres_store.connection() as connection:
                db = _Database(connection, True)
                db.execute("SET LOCAL lock_timeout = '5s'")
                yield db
        except DatabaseError:
            raise postgres_store.PostgresStoreError("auth_session_database_unavailable") from None
        return
    if postgres_store.required() or not is_local_or_test_environment():
        raise postgres_store.PostgresStoreError("auth_sessions_postgresql_required")
    path = get_data_root().resolve() / "_system" / "auth_sessions.sqlite3"
    try:
        path.resolve().relative_to(get_data_root().resolve())
    except ValueError:
        raise postgres_store.PostgresStoreError("auth_session_path_outside_data_root") from None
    if path.is_symlink() or path.parent.is_symlink():
        raise postgres_store.PostgresStoreError("auth_session_symlink_not_allowed")
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    connection = sqlite3.connect(path, timeout=5)
    if os.name != "nt":
        path.chmod(0o600)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        db = _Database(connection, False)
        with _schema_guard:
            if not existed or str(path) not in _sqlite_initialized:
                connection.execute("BEGIN IMMEDIATE")
                _initialize_schema(db)
                connection.commit()
                _sqlite_initialized.add(str(path))
        connection.execute("BEGIN" if read_only else "BEGIN IMMEDIATE")
        yield db
        connection.commit()
    except sqlite3.Error:
        connection.rollback()
        raise postgres_store.PostgresStoreError("auth_session_database_unavailable") from None
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _account(db: _Database, user_id: str) -> int:
    db.execute("INSERT INTO norium_auth_accounts(user_id) VALUES (%s) ON CONFLICT(user_id) DO NOTHING", (user_id,))
    query = ("SELECT epoch FROM norium_auth_accounts WHERE user_id=%s FOR UPDATE" if db.postgres
             else "SELECT epoch FROM norium_auth_accounts WHERE user_id=%s")
    row = db.execute(query, (user_id,)).fetchone()
    return int(row["epoch"])


def epoch(user_id: str) -> int:
    with transaction() as db:
        return _account(db, user_id)


def _valid(row: Any, user_id: str, version: int, now: int) -> dict:
    if (not row or row["user_id"] != user_id or int(row["version"]) != version
            or row["revoked"] is not None or int(row["expires"]) <= now
            or int(row["last_activity"]) + IDLE_SECONDS <= now):
        raise SessionError("session_invalid")
    return dict(row)


def create(user_id: str, version: int, *, persistent: bool = False, agent: str = "",
           expected_epoch: int | None = None) -> tuple[dict, str, str]:
    now, sid, refresh, csrf = int(time.time()), secrets.token_urlsafe(18), credential(), credential()
    browser, system, kind = metadata(agent)
    with transaction() as db:
        current_epoch = _account(db, user_id)
        if expected_epoch is not None and current_epoch != expected_epoch:
            raise SessionError("session_creation_conflict")
        # Cleanup is scoped to this account, including consumed credential hashes.
        db.execute("DELETE FROM norium_auth_sessions WHERE user_id=%s AND expires<=%s", (user_id, now))
        count = db.execute("SELECT COUNT(*) AS total FROM norium_auth_sessions WHERE user_id=%s AND revoked IS NULL AND last_activity>%s",
                           (user_id, now - IDLE_SECONDS)).fetchone()["total"]
        if count >= MAX_SESSIONS:
            raise SessionError("session_limit", 429)
        db.execute("""INSERT INTO norium_auth_sessions
            (id,user_id,version,created,authenticated,last_activity,expires,persistent,browser,system,kind,csrf_hash)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (sid, user_id, version, now, now, now, now + ABSOLUTE_SECONDS, int(persistent), browser, system, kind, digest(csrf)))
        db.execute("INSERT INTO norium_auth_credentials(hash,session_id) VALUES (%s,%s)", (digest(refresh), sid))
        row = db.execute("SELECT * FROM norium_auth_sessions WHERE id=%s", (sid,)).fetchone()
        _event(db, user_id, "session_created", sid)
    return dict(row), refresh, csrf


def validate(sid: str, user_id: str, version: int, *, touch: bool = False) -> dict:
    now = int(time.time())
    with transaction(read_only=not touch) as db:
        row = _valid(db.execute("SELECT * FROM norium_auth_sessions WHERE id=%s", (sid,)).fetchone(), user_id, version, now)
        if touch and now - row["last_activity"] >= 60:
            db.execute("UPDATE norium_auth_sessions SET last_activity=%s WHERE id=%s", (now, sid))
            row["last_activity"] = now
        return row


def lookup(refresh: str) -> dict | None:
    if not isinstance(refresh, str) or not 40 <= len(refresh) <= 100 or not refresh.isascii():
        return None
    with transaction(read_only=True) as db:
        row = db.execute("""SELECT s.* FROM norium_auth_sessions s JOIN norium_auth_credentials c
            ON c.session_id=s.id WHERE c.hash=%s""", (digest(refresh),)).fetchone()
        return dict(row) if row else None


def rotate(refresh: str, csrf: str, user_id: str, version: int) -> tuple[dict, str]:
    now, replacement, failure = int(time.time()), credential(), None
    with transaction() as db:
        _account(db, user_id)
        record = db.execute("SELECT * FROM norium_auth_credentials WHERE hash=%s", (digest(refresh),)).fetchone()
        if not record:
            raise SessionError("session_invalid")
        row = _valid(db.execute("SELECT * FROM norium_auth_sessions WHERE id=%s", (record["session_id"],)).fetchone(), user_id, version, now)
        if not secrets.compare_digest(row["csrf_hash"], digest(csrf)):
            raise SessionError("csrf_invalid", 403)
        if record["consumed"] is not None:
            db.execute("UPDATE norium_auth_sessions SET revoked=%s WHERE id=%s", (now, row["id"]))
            _event(db, user_id, "refresh_reused", row["id"])
            failure = SessionError("refresh_reused")
        else:
            if now - row["last_rotation"] < 5:
                raise SessionError("refresh_rate_limit", 429)
            count = db.execute("SELECT COUNT(*) AS total FROM norium_auth_credentials WHERE session_id=%s", (row["id"],)).fetchone()["total"]
            if count >= 1024:
                db.execute("UPDATE norium_auth_sessions SET revoked=%s WHERE id=%s", (now, row["id"]))
                _event(db, user_id, "refresh_limit", row["id"])
                failure = SessionError("refresh_limit")
            else:
                db.execute("UPDATE norium_auth_sessions SET last_rotation=%s WHERE id=%s", (now, row["id"]))
                db.execute("UPDATE norium_auth_credentials SET consumed=%s WHERE hash=%s", (now, digest(refresh)))
                db.execute("INSERT INTO norium_auth_credentials(hash,session_id) VALUES (%s,%s)", (digest(replacement), row["id"]))
                _event(db, user_id, "session_renewed", row["id"])
    # Raising inside the transaction would roll back the replay revocation.
    if failure:
        raise failure
    return row, replacement


def list_sessions(user_id: str, version: int) -> list[dict]:
    now = int(time.time())
    with transaction(read_only=True) as db:
        rows = db.execute("""SELECT * FROM norium_auth_sessions WHERE user_id=%s AND version=%s
            AND revoked IS NULL AND expires>%s AND last_activity>%s ORDER BY last_activity DESC""",
            (user_id, version, now, now - IDLE_SECONDS)).fetchall()
    return [dict(row) for row in rows]


def revoke(user_id: str, *, sid: str | None = None, except_sid: str | None = None) -> None:
    with transaction() as db:
        _account(db, user_id)
        if sid:
            changed = db.execute("UPDATE norium_auth_sessions SET revoked=%s WHERE user_id=%s AND id=%s AND revoked IS NULL", (int(time.time()), user_id, sid)).rowcount
            if changed:
                _event(db, user_id, "session_revoked", sid)
        elif except_sid:
            db.execute("UPDATE norium_auth_sessions SET revoked=%s WHERE user_id=%s AND id<>%s AND revoked IS NULL", (int(time.time()), user_id, except_sid))
            db.execute("UPDATE norium_auth_accounts SET epoch=epoch+1 WHERE user_id=%s", (user_id,))
            _event(db, user_id, "other_sessions_revoked", except_sid)
        else:
            db.execute("UPDATE norium_auth_sessions SET revoked=%s WHERE user_id=%s AND revoked IS NULL", (int(time.time()), user_id))
            db.execute("UPDATE norium_auth_accounts SET epoch=epoch+1 WHERE user_id=%s", (user_id,))
            _event(db, user_id, "all_sessions_revoked")


def reauthenticate(sid: str, user_id: str, version: int) -> None:
    now = int(time.time())
    with transaction() as db:
        _account(db, user_id)
        _valid(db.execute("SELECT * FROM norium_auth_sessions WHERE id=%s", (sid,)).fetchone(), user_id, version, now)
        db.execute("UPDATE norium_auth_sessions SET authenticated=%s,last_activity=%s WHERE id=%s", (now, now, sid))
        _event(db, user_id, "session_reauthenticated", sid)


def rename(sid: str, user_id: str, version: int, label: str) -> None:
    with transaction() as db:
        _account(db, user_id)
        _valid(db.execute("SELECT * FROM norium_auth_sessions WHERE id=%s", (sid,)).fetchone(), user_id, version, int(time.time()))
        db.execute("UPDATE norium_auth_sessions SET label=%s WHERE id=%s AND user_id=%s", (label[:80], sid, user_id))


def readiness() -> None:
    with transaction(read_only=True) as db:
        db.execute("SELECT id FROM norium_auth_sessions LIMIT 1").fetchone()
        if db.execute("SELECT version FROM norium_auth_schema WHERE id=1").fetchone()["version"] != 1:
            raise postgres_store.PostgresStoreError("auth_session_schema_version_unsupported")


def purge_expired() -> int:
    with transaction() as db:
        # Bounded batches remove hashes through ON DELETE CASCADE. The epoch is
        # retained until account erasure; it is the concurrent revocation fence.
        count = db.execute("""DELETE FROM norium_auth_sessions WHERE id IN
            (SELECT id FROM norium_auth_sessions WHERE expires<=%s LIMIT 1000)""", (int(time.time()),)).rowcount
        db.execute("""DELETE FROM norium_auth_events WHERE id IN
            (SELECT id FROM norium_auth_events WHERE created<=%s LIMIT 1000)""", (int(time.time()) - EVENT_RETENTION_SECONDS,))
        return count


def erase_personal_sessions(user_id: str) -> None:
    with transaction() as db:
        _account(db, user_id)
        # Keep only the same opaque ID/epoch as the inactive account tombstone,
        # fencing any password check already in flight. Remove all session data.
        db.execute("UPDATE norium_auth_accounts SET epoch=epoch+1 WHERE user_id=%s", (user_id,))
        db.execute("DELETE FROM norium_auth_sessions WHERE user_id=%s", (user_id,))
        db.execute("DELETE FROM norium_auth_events WHERE user_id=%s", (user_id,))
