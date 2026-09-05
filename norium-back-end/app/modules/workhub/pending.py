"""Independent priority sources: a locked integration cannot hide local work."""
from __future__ import annotations

import asyncio
import logging
from time import perf_counter
from typing import Any, Literal

from fastapi import HTTPException

from app.core.request_context import current_workspace_id
from app.core.tenant import get_data_root
from app.modules.operations.service import read_integration_health
from app.modules.workhub import service

PendingSource = Literal["activity", "tasks", "finance", "messages", "integrations"]
SOURCES: tuple[PendingSource, ...] = ("activity", "tasks", "finance", "messages", "integrations")
LABELS = {
    "activity": "Aprovações e acompanhamentos", "tasks": "Tarefas",
    "finance": "Financeiro", "messages": "Mensagens", "integrations": "Integrações",
}
SOURCE_TIMEOUT_SECONDS = 5
_reads: dict[tuple[int, str, str, str, str], asyncio.Task] = {}
logger = logging.getLogger(__name__)


async def _load(user_id: str, source: PendingSource) -> dict[str, Any]:
    records: dict[str, Any] = {}
    if source == "activity":
        approvals, followups, audits = await asyncio.gather(
            service.list_items(user_id, service.APPROVAL_DB),
            service.list_items(user_id, service.FOLLOWUP_DB),
            service.list_items(user_id, service.AUDIT_DB),
        )
        records = {"approvals": approvals, "followups": followups, "audits": audits}
    elif source == "tasks":
        records["tasks_payload"] = await asyncio.to_thread(service.list_tasks, user_id, status="todas")
    elif source == "finance":
        records["finance"] = await asyncio.to_thread(service.list_finance, user_id)
    elif source == "messages":
        events, overrides = await asyncio.gather(
            service.read_events(user_id), service.list_records(user_id, service.SHARED_INBOX_DB),
        )
        records = {"events": events, "overrides": overrides}
    else:
        # A priority only needs connection state. Event history and failure counts
        # are already read by their own sources, and are not sent to this one.
        records["integrations"] = await read_integration_health(user_id, [], [])
    result = service.pending_from_records(**records)
    # Priority cards need references and short previews, never email bodies,
    # attachment/base64 payloads, or full execution metadata.
    for item in result["items"]:
        item["title"] = str(item.get("title") or "")[:180]
        item["description"] = str(item.get("description") or "")[:1200]
        link = item["deepLink"]
        metadata = link.get("metadata") or {}
        link["metadata"] = {
            key: value for key, value in metadata.items()
            if key in {"emailId", "messageId", "conversationId", "projectId", "taskId", "eventId", "lancamentoId", "channel"}
            and isinstance(value, (str, int, bool)) and len(str(value)) <= 256
        }
    if source != "messages":
        result.pop("inboxOpen", None)
    return {**result, "source": source}


async def pending_source(user: dict[str, Any], source: PendingSource) -> dict[str, Any]:
    # Repeated refreshes reuse in-flight work, with no cached results across
    # accounts/workspaces. Cancellation never starts another copy of a slow read.
    user_id = str(user["id"])
    key = (id(asyncio.get_running_loop()), str(get_data_root()), user_id, current_workspace_id(), source)
    task = _reads.get(key)
    if task is None or task.done():
        task = asyncio.create_task(_load(user_id, source))
        _reads[key] = task

        def finished(completed: asyncio.Task) -> None:
            if _reads.get(key) is completed:
                _reads.pop(key, None)
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(finished)
    started = perf_counter()
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout=SOURCE_TIMEOUT_SECONDS)
        elapsed = perf_counter() - started
        if elapsed >= 1:
            logger.warning("pending_source_slow source=%s elapsed_ms=%d", source, elapsed * 1000)
        return result
    except TimeoutError:
        logger.warning("pending_source_wait source=%s elapsed_ms=%d", source, (perf_counter() - started) * 1000)
        raise HTTPException(503, f"{LABELS[source]} ainda está em atualização. As outras pendências continuam disponíveis.") from None
    except HTTPException:
        raise
    except Exception:
        # Never expose binding credentials, filesystem paths or source records.
        logger.warning("pending_source_failed source=%s", source)
        raise HTTPException(503, f"Não foi possível atualizar {LABELS[source].lower()}. Tente novamente nesta fonte.") from None


async def pending_overview(user: dict[str, Any]) -> dict[str, Any]:
    results = await asyncio.gather(*(pending_source(user, source) for source in SOURCES), return_exceptions=True)
    items: list[dict[str, Any]] = []
    states: dict[str, str] = {}
    inbox_open = None
    for source, result in zip(SOURCES, results):
        if isinstance(result, BaseException):
            states[source] = "unavailable"
            continue
        states[source] = "ready"
        items.extend(result["items"])
        if source == "messages":
            inbox_open = result["inboxOpen"]
    ordered = service._sort_desc(items)
    counts: dict[str, int] = {}
    for item in ordered:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    return {
        "items": ordered, "total": len(ordered), "counts": counts,
        "inboxOpen": inbox_open, "complete": all(value == "ready" for value in states.values()),
        "sources": states, "generatedAt": service.now_iso(),
        "firstRecommended": ordered[0] if ordered else None,
    }
