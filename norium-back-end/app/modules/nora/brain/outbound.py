"""Outbound send receipts keyed by operationId, in the brain's transactional store.

A receipt is written (status "enviando") before the provider is called and
updated after the provider answers. It only holds digests, never the recipient
or the message text. Digests and actor identifiers still require tenant access
controls and the same privacy lifecycle as the associated job.
"""
from __future__ import annotations

import os
import time

from .contracts import fingerprint

SENDING, SENT, REJECTED = "enviando", "concluido", "recusado"


def settle_seconds() -> float:
    """Minimum age of an operation intent before absence can be trusted."""
    try:
        return max(0.0, float(os.getenv("NORA_BRAIN_RECONCILE_SETTLE_SECONDS", "300")))
    except ValueError:
        return 300.0


def target_digest(channel: str, conversation_id: str, text: str) -> str:
    return fingerprint({"channel": channel, "conversationId": conversation_id, "text": text})


def begin(repo, scope: dict, operation_id: str, channel: str, digest: str) -> tuple[dict | None, bool]:
    """Persist intent before the provider call.

    Returns (receipt, armed). ``armed`` is True only when this attempt created the
    receipt or re-armed one whose earlier attempt was definitively rejected. An
    existing "enviando" receipt is never re-armed: its outcome is unknown.
    """
    now = repo.clock()
    with repo.transaction() as connection:
        cursor = repo.sql(connection, """INSERT INTO nora_outbound_receipts
            (operation_id,tenant,actor,workspace,channel,status,target_digest,provider_id,created,updated)
            VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING""",
            (operation_id, scope["tenant"], scope["user"], scope["workspace"], channel, SENDING, digest, "", now, now))
        armed = cursor.rowcount == 1
        if not armed:
            cursor = repo.sql(connection, """UPDATE nora_outbound_receipts SET status=?,updated=?
                WHERE operation_id=? AND tenant=? AND actor=? AND workspace=? AND status=? AND target_digest=?""",
                (SENDING, now, operation_id, scope["tenant"], scope["user"], scope["workspace"], REJECTED, digest))
            armed = cursor.rowcount == 1
        return _row(repo, connection, scope, operation_id), armed


def finish(repo, scope: dict, operation_id: str, status: str, provider_id: str = "") -> None:
    if status not in {SENT, REJECTED} or (status == SENT and not str(provider_id).strip()):
        raise ValueError("A completed send requires a provider receipt")
    with repo.transaction() as connection:
        repo.sql(connection, """UPDATE nora_outbound_receipts SET status=?,provider_id=?,updated=?
            WHERE operation_id=? AND tenant=? AND actor=? AND workspace=? AND status=?""",
            (status, provider_id or "", repo.clock(), operation_id, scope["tenant"], scope["user"],
             scope["workspace"], SENDING))


def read(repo, scope: dict, operation_id: str) -> dict | None:
    with repo.transaction() as connection:
        return _row(repo, connection, scope, operation_id)


def _row(repo, connection, scope, operation_id):
    row = repo.sql(connection, """SELECT operation_id,channel,status,target_digest,provider_id,created,updated
        FROM nora_outbound_receipts WHERE operation_id=? AND tenant=? AND actor=? AND workspace=?""",
        (operation_id, scope["tenant"], scope["user"], scope["workspace"])).fetchone()
    return dict(row) if row is not None else None


def intent_time(job: dict, operation_id: str) -> float | None:
    """When the approved operation was consumed (intent recorded by the engine)."""
    step = next((s for s in job.get("steps", []) if s.get("id") == operation_id), None)
    if step is None:
        return None
    for value in (step.get("intentAt"), (step.get("approval") or {}).get("consumedAt")):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def settled(job: dict, operation_id: str, now: float | None = None) -> bool:
    started = intent_time(job, operation_id)
    current = time.time() if now is None else now
    return started is not None and current - started >= settle_seconds()
