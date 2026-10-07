"""Server-side conversation context for Nora: persistent turns plus safe compaction.

The frontend owns the visible transcript (see conversations.py). This module owns
a compact server-side log keyed by the same conversation id, so the model keeps
context across turns, tabs and restarts even when the client sends few or no
messages. Storage goes through read_user_db/write_user_db, which already scope
every file by user AND by the current workspace.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.tenant import get_user_db_path, read_user_db, write_user_db
from app.infrastructure.persistence.json_repository import PersistenceError

logger = logging.getLogger(__name__)

CONTEXT_VERSION = 1
CONTEXT_DB_PREFIX = "nora_ctx_"
ID_PATTERN = r"^[a-zA-Z0-9_-]{8,80}$"
ID_RE = re.compile(ID_PATTERN)
MAX_TURNS = 60
COMPACT_KEEP_RECENT = 20
MAX_TURN_CHARS = 4000
MAX_SUMMARY_CHARS = 4000
MAX_CONTEXT_MESSAGES = 24
FOLD_BULLET_CHARS = 220

context_lock = asyncio.Lock()


def valid_conversation_id(value: Any) -> str | None:
    """Return the id when it is safe to use as a store name, else None."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not ID_RE.fullmatch(cleaned):
        return None
    return cleaned


def context_db(conversation_id: str) -> str:
    return f"{CONTEXT_DB_PREFIX}{conversation_id}"


def empty_snapshot() -> dict[str, Any]:
    return {"version": CONTEXT_VERSION, "summary": "", "turns": []}


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def load_conversation_context(user_id: str, conversation_id: str) -> tuple[dict[str, Any], bool]:
    """Load the persisted snapshot; the flag tells whether appending is safe.

    Unknown ids, missing files and malformed schemas degrade to an empty
    snapshot. A store that fails closed (corrupt/unreadable) is reported as
    read-only so later appends never overwrite bytes kept for investigation.
    """
    if valid_conversation_id(conversation_id) is None:
        return empty_snapshot(), False
    try:
        record = read_user_db(user_id, context_db(conversation_id), {})
    except PersistenceError:
        logger.warning("nora_context_unreadable")
        return empty_snapshot(), False
    if not isinstance(record, dict):
        return empty_snapshot(), False
    if record.get("version") != CONTEXT_VERSION:
        return empty_snapshot(), True
    turns = record.get("turns")
    summary = record.get("summary", "")
    if not isinstance(turns, list) or not isinstance(summary, str):
        return empty_snapshot(), False
    cleaned_turns = []
    for turn in turns[-MAX_TURNS:]:
        if not isinstance(turn, dict):
            continue
        user_text = _clean_text(turn.get("user"), MAX_TURN_CHARS)
        ai_text = _clean_text(turn.get("ai"), MAX_TURN_CHARS)
        if not user_text or not ai_text:
            continue
        cleaned_turns.append({
            "ts": str(turn.get("ts") or ""),
            "user": user_text,
            "ai": ai_text,
            "intent": str(turn.get("intent") or "")[:40] or None,
        })
    return {"version": CONTEXT_VERSION, "summary": summary[:MAX_SUMMARY_CHARS], "turns": cleaned_turns}, True


def context_prompt_messages(snapshot: dict[str, Any], max_messages: int = MAX_CONTEXT_MESSAGES) -> list[dict[str, str]]:
    """Render a snapshot as model messages: summary first, then recent turns."""
    messages: list[dict[str, str]] = []
    summary = str(snapshot.get("summary") or "").strip()
    if summary:
        messages.append({
            "role": "system",
            "content": (
                "Resumo da conversa até aqui, mantido pelo Norium a partir dos turnos "
                "anteriores desta mesma conversa. Use como contexto; em caso de "
                "conflito com a mensagem atual, a mensagem atual prevalece.\n" + summary
            ),
        })
    turns = snapshot.get("turns") or []
    budget = max(0, max_messages - len(messages))
    take = budget // 2
    recent = turns[-take:] if take > 0 else []
    for turn in recent:
        messages.append({"role": "user", "content": turn["user"]})
        messages.append({"role": "assistant", "content": turn["ai"]})
    return messages[:max_messages]


def _comparable_text(value: Any) -> str:
    """Whitespace-normalized text for dedup; persisted turns are stored cleaned."""
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def merge_histories(persisted: list[dict[str, str]], client_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prepend persisted turns the client did not already send.

    Comparison is whitespace-normalized because persisted turns are stored
    cleaned while client transcripts keep raw formatting. Originals are kept
    untouched; only the comparison is normalized.
    """
    seen = {
        _comparable_text(item.get("content"))
        for item in client_messages
        if isinstance(item, dict) and _comparable_text(item.get("content"))
    }
    merged: list[dict[str, Any]] = [
        message for message in persisted
        if _comparable_text(message.get("content")) not in seen
    ]
    merged.extend(client_messages)
    return merged


def _fold_bullets(turns: list[dict[str, Any]]) -> list[str]:
    bullets: list[str] = []
    for turn in turns:
        user_text = str(turn.get("user") or "")
        ai_text = str(turn.get("ai") or "")
        if user_text:
            bullets.append(f"Você: {user_text[:FOLD_BULLET_CHARS]}")
        if ai_text:
            bullets.append(f"Nora: {ai_text[:FOLD_BULLET_CHARS]}")
    return bullets


def _compact_turns(turns: list[dict[str, Any]], summary: str) -> tuple[list[dict[str, Any]], str]:
    if len(turns) <= MAX_TURNS:
        return turns, summary
    # The first turn usually states the original goal; keep it plus the tail.
    folded = turns[1:-COMPACT_KEEP_RECENT] if len(turns) > COMPACT_KEEP_RECENT + 1 else []
    kept = [turns[0], *turns[-COMPACT_KEEP_RECENT:]] if folded else turns[-MAX_TURNS:]
    if not folded:
        return kept, summary
    bullets = [line for line in summary.splitlines() if line.strip()]
    bullets.extend(_fold_bullets(folded))
    merged = "\n".join(bullets)
    if len(merged) > MAX_SUMMARY_CHARS:
        merged = "…" + merged[len(merged) - MAX_SUMMARY_CHARS + 1:]
        cut = merged.find("\n")
        if cut != -1:
            merged = "…" + merged[cut + 1:]
    folded_count = len(folded)
    logger.info("nora_context_compacted folded_turns=%s kept_turns=%s", folded_count, len(kept))
    return kept, merged


async def append_conversation_turn(
    user_id: str,
    conversation_id: str,
    user_text: str,
    ai_text: str,
    intent: str | None = None,
) -> dict[str, Any] | None:
    """Persist one turn; returns the snapshot or None when skipped."""
    if valid_conversation_id(conversation_id) is None:
        return None
    user_clean = _clean_text(user_text, MAX_TURN_CHARS)
    ai_clean = _clean_text(ai_text, MAX_TURN_CHARS)
    if not user_clean or not ai_clean:
        return None
    async with context_lock:
        snapshot, writable = await asyncio.to_thread(load_conversation_context, user_id, conversation_id)
        if not writable:
            return None
        turns = list(snapshot.get("turns") or [])
        turns.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "user": user_clean,
            "ai": ai_clean,
            "intent": (str(intent or "")[:40] or None),
        })
        turns, summary = _compact_turns(turns, str(snapshot.get("summary") or ""))
        record = {"version": CONTEXT_VERSION, "summary": summary, "turns": turns}
        try:
            await asyncio.to_thread(write_user_db, user_id, context_db(conversation_id), record)
        except OSError:
            logger.warning("nora_context_write_failed")
            return None
        return record


async def delete_conversation_context(user_id: str, conversation_id: str) -> bool:
    """Remove the server-side log when its conversation is deleted."""
    if valid_conversation_id(conversation_id) is None:
        return False
    async with context_lock:
        try:
            path = await asyncio.to_thread(get_user_db_path, user_id, context_db(conversation_id))
            await asyncio.to_thread(Path(path).unlink, True)
        except OSError:
            logger.warning("nora_context_delete_failed")
            return False
        return True
