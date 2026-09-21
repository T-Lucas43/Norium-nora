from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.core.tenant import get_data_root


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
        self.path = Path(path) if path else get_data_root() / "scheduling.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA busy_timeout = 30000")
        db.execute("PRAGMA journal_mode = WAL")
        return db

    def migrate(self) -> None:
        sql = (Path(__file__).parent / "migrations" / "001_initial.sql").read_text(encoding="utf-8")
        db = self.connect()
        try:
            db.executescript(sql)
        finally:
            db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        db = self.connect()
        try:
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
