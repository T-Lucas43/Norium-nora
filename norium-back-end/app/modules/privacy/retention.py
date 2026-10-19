"""Retenção opt-in, incremental; zero desliga cada prazo e timestamps ausentes ficam."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.core.tenant import get_data_root, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store, files, document_cache

DEFAULT_DAYS = {"NORA": 365, "WHATSAPP": 180, "MEDIA": 90, "UPLOADS": 365, "SYSTEM_LOGS": 90}


def retention_days(kind: str) -> int:
    try:
        return max(0, min(36500, int(os.getenv(f"NORIUM_RETENTION_{kind}_DAYS", str(DEFAULT_DAYS[kind])))))
    except ValueError:
        return DEFAULT_DAYS[kind]


def _at(value: Any) -> datetime | None:
    try:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, timezone.utc)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _cutoff(kind: str, now: datetime) -> datetime | None:
    days = retention_days(kind)
    return now - timedelta(days=days) if days else None


def _delete_document(path: Path) -> None:
    key = path.relative_to(get_data_root()).as_posix()
    if postgres_store.configured() or postgres_store.required():
        postgres_store.delete_document(key)
    else:
        path.unlink(missing_ok=True)
    document_cache.forget(key)


def maintain_retention(now: datetime | None = None) -> dict[str, int]:
    counts = {"retainedConversationsRemoved": 0, "retainedMessagesRemoved": 0,
              "retainedFilesRemoved": 0, "retainedLogsRemoved": 0}
    if os.getenv("NORIUM_RETENTION_ENABLED", "0").strip().lower() not in {"1", "true", "yes"}:
        return counts
    current = now or datetime.now(timezone.utc)
    root = get_data_root().resolve()
    pg = postgres_store.configured() or postgres_store.required()
    if pg:
        paths = [root / key for key in postgres_store.list_document_keys("user_")]
    else:
        paths = list(root.glob("user_*/**/*.json"))
    nora_cutoff, wa_cutoff = _cutoff("NORA", current), _cutoff("WHATSAPP", current)
    for path in paths[:10000]:
        if not pg and path.is_symlink():
            continue
        if path.name == "nora_conversations_db.json" and nora_cutoff:
            payload = read_json_file(path, {})
            rows = payload.get("conversations", []) if isinstance(payload, dict) else []
            removed = [row for row in rows if isinstance(row, dict) and (at := _at(row.get("updatedAt"))) and at < nora_cutoff]
            for row in removed[:500]:
                identifier = str(row.get("id") or "")
                import re
                if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", identifier):
                    continue
                for prefix in ("nora_chat_", "nora_ctx_"):
                    _delete_document(path.parent / f"{prefix}{identifier}_db.json")
                rows.remove(row)
                counts["retainedConversationsRemoved"] += 1
            if removed:
                write_json_file(path, payload)
        elif path.name in {"conversas_db.json", "evolution_conversas_db.json"} and wa_cutoff:
            payload = read_json_file(path, {})
            changed = False
            if not isinstance(payload, dict):
                continue
            for conversation in payload.values():
                if not isinstance(conversation, dict) or not isinstance(conversation.get("mensagens"), list):
                    continue
                rows = conversation["mensagens"]
                retained = [row for row in rows if not isinstance(row, dict) or not (at := _at(row.get("timestamp"))) or at >= wa_cutoff]
                if len(rows) != len(retained):
                    counts["retainedMessagesRemoved"] += len(rows) - len(retained)
                    conversation["mensagens"] = retained
                    conversation["ultimaMensagem"] = retained[-1].get("texto", "") if retained else ""
                    changed = True
            if changed:
                write_json_file(path, payload)
    # Account-scoped cached media and generic uploads. Business attachments stay
    # under their own business retention, not a generic age-based deletion.
    upload_cutoff, media_cutoff = _cutoff("UPLOADS", current), _cutoff("MEDIA", current)
    for path in files.list_paths(root / "uploads")[:500]:
        if not pg and path.is_symlink():
            continue
        cutoff = media_cutoff if "whatsapp_media" in path.parts else upload_cutoff
        if not cutoff:
            continue
        info = files.info(path)
        # PostgreSQL remains authoritative; absence cannot revive local remnants.
        at = _at(info.get("updatedAt")) if pg and info else None if pg else _at(path.stat().st_mtime)
        if at and at < cutoff:
            files.delete(path)
            counts["retainedFilesRemoved"] += 1
    log_cutoff = _cutoff("SYSTEM_LOGS", current)
    if log_cutoff:
        from app.services.system_logs import purge_logs_before
        counts["retainedLogsRemoved"] = purge_logs_before(log_cutoff)
    return counts
