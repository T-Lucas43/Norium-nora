"""Durable, content-free send intents. An uncertain intent is never re-armed."""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager

from app.core.request_context import current_workspace_id
from app.core.tenant import get_data_root
from app.infrastructure.persistence import postgres_store

SCHEMA = """CREATE TABLE IF NOT EXISTS norium_outbound_receipts (
 user_id TEXT NOT NULL, workspace TEXT NOT NULL, operation_id TEXT NOT NULL,
 digest TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL,
 created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
 PRIMARY KEY (user_id, workspace, operation_id))"""


@contextmanager
def database():
    if postgres_store.configured() or postgres_store.required():
        with postgres_store.connection() as db:
            db.execute(SCHEMA)
            yield db, True
        return
    db = sqlite3.connect(get_data_root() / "outbound_receipts.sqlite3", timeout=30)
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


def _execute(db, postgres, sql, params):
    return db.execute(sql.replace("?", "%s") if postgres else sql, params)


def begin(user_id: str, key: str, digest: str) -> tuple[dict, bool]:
    if not user_id or not key or not digest:
        raise ValueError("An exact actor, operation and digest are required")
    workspace, now = current_workspace_id(), time.time()
    with database() as (db, postgres):
        cursor = _execute(db, postgres, """INSERT INTO norium_outbound_receipts
            VALUES (?,?,?,?,?,'',?,?) ON CONFLICT(user_id,workspace,operation_id) DO NOTHING""",
            (user_id, workspace, key, digest, "sending", now, now))
        armed = cursor.rowcount == 1
        row = _execute(db, postgres, """SELECT * FROM norium_outbound_receipts
            WHERE user_id=? AND workspace=? AND operation_id=?""", (user_id, workspace, key)).fetchone()
        result = dict(row)
        if result["digest"] != digest:
            raise PermissionError("The operation is bound to different content")
        return result, armed


def read(user_id: str, key: str) -> dict | None:
    with database() as (db, postgres):
        row = _execute(db, postgres, """SELECT * FROM norium_outbound_receipts
            WHERE user_id=? AND workspace=? AND operation_id=?""", (user_id, current_workspace_id(), key)).fetchone()
        return dict(row) if row is not None else None


def finish(user_id: str, key: str, digest: str, status: str, provider_id: str = "") -> None:
    if status not in {"confirmed", "failed", "unknown"} or (status == "confirmed" and not provider_id):
        raise ValueError("A completed send needs an exact provider receipt")
    with database() as (db, postgres):
        cursor = _execute(db, postgres, """UPDATE norium_outbound_receipts
            SET status=?,provider_id=?,updated_at=? WHERE user_id=? AND workspace=?
            AND operation_id=? AND digest=? AND status IN ('sending','unknown')""",
            (status, provider_id, time.time(), user_id, current_workspace_id(), key, digest))
        if cursor.rowcount != 1:
            row = _execute(db, postgres, """SELECT status,provider_id,digest FROM norium_outbound_receipts
                WHERE user_id=? AND workspace=? AND operation_id=?""", (user_id, current_workspace_id(), key)).fetchone()
            if row is None or row["digest"] != digest or row["status"] != status or row["provider_id"] != provider_id:
                raise PermissionError("The send intent is unavailable or already settled")
