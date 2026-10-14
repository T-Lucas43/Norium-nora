"""Registro persistente e sanitizado de eventos operacionais do Norium."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.tenant import get_system_db_path
from app.infrastructure.persistence import postgres_store
from app.core.log_masking import mask_text, mask_metadata


_LOCK = threading.RLock()
_postgres_schema_ready = False
_MAX_STORED_LOGS = 10_000
_MAX_FILE_BYTES = 8 * 1024 * 1024
_ALLOWED_LEVELS = {"info", "warning", "error"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path() -> Path:
    return Path(get_system_db_path("system_logs")).with_suffix(".jsonl")


def _read() -> list[dict[str, Any]]:
    path = _path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-_MAX_STORED_LOGS:]
    except (FileNotFoundError, OSError, UnicodeError):
        return []
    items: list[dict[str, Any]] = []
    for line in reversed(lines):
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            items.append(item)
    return items


def _compact(path: Path) -> None:
    if not path.is_file() or path.stat().st_size <= _MAX_FILE_BYTES:
        return
    retained = list(reversed(_read()[: _MAX_STORED_LOGS // 2]))
    temporary = path.with_suffix(".tmp")
    temporary.write_text("".join(f"{json.dumps(item, ensure_ascii=False, separators=(',', ':'))}\n" for item in retained), encoding="utf-8")
    os.replace(temporary, path)


def _ensure_postgres_schema() -> None:
    global _postgres_schema_ready
    if _postgres_schema_ready:
        return
    with _LOCK:
        if _postgres_schema_ready:
            return
        postgres_store.initialize()
        with postgres_store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS norium_system_logs (
                id TEXT PRIMARY KEY,event TEXT NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL,
                user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,metadata JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL)""")
        _postgres_schema_ready = True


def record_system_log(
    event: str,
    *,
    level: str = "info",
    message: str = "",
    user_id: str = "anonymous",
    workspace_id: str = "primary",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Armazena metadados técnicos sem corpos, tokens, cookies ou segredos."""
    normalized_level = level if level in _ALLOWED_LEVELS else "info"
    entry = {
        "id": f"log_{uuid.uuid4().hex}",
        "event": mask_text(event)[:120],
        "level": normalized_level,
        "message": mask_text(message)[:500],
        "userId": str(user_id or "anonymous")[:160],
        "workspaceId": str(workspace_id or "primary")[:120],
        "metadata": mask_metadata(metadata or {}),
        "createdAt": _now_iso(),
    }
    if postgres_store.configured() or postgres_store.required():
        from psycopg.types.json import Jsonb
        _ensure_postgres_schema()
        with postgres_store.connection() as db:
            db.execute("INSERT INTO norium_system_logs VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                       (entry["id"], entry["event"], entry["level"], entry["message"], entry["userId"],
                        entry["workspaceId"], Jsonb(entry["metadata"]), entry["createdAt"]))
        return entry
    with _LOCK:
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _compact(path)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
            stream.flush()
    return entry


def list_system_logs(*, limit: int = 200, level: str = "", search: str = "") -> list[dict[str, Any]]:
    query = search.strip().casefold()
    if postgres_store.configured() or postgres_store.required():
        _ensure_postgres_schema()
        with postgres_store.connection() as db:
            rows = db.execute("SELECT * FROM norium_system_logs ORDER BY created_at DESC LIMIT %s", (max(1, min(limit * 5, 5000)),)).fetchall()
        items = [{"id": row["id"], "event": row["event"], "level": row["level"], "message": row["message"],
                  "userId": row["user_id"], "workspaceId": row["workspace_id"], "metadata": row["metadata"],
                  "createdAt": row["created_at"].isoformat()} for row in rows]
    else:
        with _LOCK:
            items = _read()
    if level in _ALLOWED_LEVELS:
        items = [item for item in items if item.get("level") == level]
    if query:
        items = [
            item for item in items
            if query in " ".join((
                str(item.get("event") or ""),
                str(item.get("message") or ""),
                str(item.get("userId") or ""),
                str(item.get("workspaceId") or ""),
            )).casefold()
        ]
    return items[: max(1, min(limit, 1000))]


def personal_logs(user_id: str, *, purge: bool = False) -> list[dict[str, Any]]:
    """Inclui somente eventos do titular; logs locais sobrevivem ao cutover."""
    with _LOCK:
        items = _read()
        personal = [item for item in items if str(item.get("userId") or "") == user_id]
        if purge and personal:
            retained = [item for item in items if str(item.get("userId") or "") != user_id]
            path = _path()
            temporary = path.with_suffix(".tmp")
            temporary.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in reversed(retained)), encoding="utf-8")
            os.replace(temporary, path)
    return personal


def purge_logs_before(cutoff: datetime) -> int:
    if postgres_store.configured() or postgres_store.required():
        _ensure_postgres_schema()
        with postgres_store.connection() as db:
            result = db.execute("DELETE FROM norium_system_logs WHERE created_at < %s", (cutoff,))
            return result.rowcount
    with _LOCK:
        items = _read()
        retained = []
        for item in items:
            try:
                at = datetime.fromisoformat(str(item.get("createdAt", "")).replace("Z", "+00:00"))
                if at.tzinfo is None:
                    at = at.replace(tzinfo=timezone.utc)
            except ValueError:
                retained.append(item)
                continue
            if at >= cutoff:
                retained.append(item)
        if len(retained) != len(items):
            path = _path()
            temporary = path.with_suffix(".tmp")
            temporary.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in reversed(retained)), encoding="utf-8")
            os.replace(temporary, path)
        return len(items) - len(retained)
