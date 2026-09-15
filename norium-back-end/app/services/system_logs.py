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


_LOCK = threading.RLock()
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
        "event": str(event)[:120],
        "level": normalized_level,
        "message": str(message)[:500],
        "userId": str(user_id or "anonymous")[:160],
        "workspaceId": str(workspace_id or "primary")[:120],
        "metadata": metadata or {},
        "createdAt": _now_iso(),
    }
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
