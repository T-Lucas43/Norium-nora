"""Idempotencia duravel com lease e conciliacao explicita de resultado incerto."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.core.tenant import read_user_db, write_user_db


DB_NAME = "confiabilidade"
MAX_RECORDS = 500
LEASE_SECONDS = 15 * 60
_lock = asyncio.Lock()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utc_now().isoformat()


def body_digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _load(user_id: str) -> dict[str, Any]:
    raw = read_user_db(user_id, DB_NAME, {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "idempotency": raw.get("idempotency") if isinstance(raw.get("idempotency"), list) else [],
        "outbox": raw.get("outbox") if isinstance(raw.get("outbox"), list) else [],
        "updatedAt": raw.get("updatedAt"),
    }


def _trim(store: dict[str, Any]) -> dict[str, Any]:
    cutoff = utc_now() - timedelta(days=2)

    def retain(item: dict[str, Any]) -> bool:
        created = _parse_timestamp(item.get("createdAt"))
        if created is None:
            return True
        return created >= cutoff or item.get("status") in {"processing", "uncertain", "needs_reconciliation"}

    store["idempotency"] = [item for item in store["idempotency"] if retain(item)][:MAX_RECORDS]
    store["outbox"] = [item for item in store["outbox"] if retain(item)][:MAX_RECORDS]
    store["updatedAt"] = now_iso()
    return store


def _outbox_for(store: dict[str, Any], key: str) -> dict[str, Any] | None:
    return next((item for item in store["outbox"] if item.get("idempotencyKey") == key), None)


def _lease_fields(attempt: int) -> dict[str, Any]:
    issued = utc_now()
    return {
        "status": "processing",
        "attempt": attempt,
        "leaseId": uuid.uuid4().hex,
        "leaseStartedAt": issued.isoformat(),
        "leaseExpiresAt": (issued + timedelta(seconds=LEASE_SECONDS)).isoformat(),
        "updatedAt": issued.isoformat(),
    }


async def begin_request(
    user_id: str,
    key: str,
    method: str,
    path: str,
    digest: str,
) -> dict[str, Any]:
    async with _lock:
        store = await asyncio.to_thread(_load, user_id)
        existing = next((item for item in store["idempotency"] if item.get("key") == key), None)
        if existing:
            if existing.get("digest") != digest or existing.get("path") != path or existing.get("method") != method:
                return {"state": "conflict"}
            status = existing.get("status")
            if status == "completed":
                return {"state": "completed", "record": existing}
            if status == "retryable":
                existing.update(_lease_fields(int(existing.get("attempt") or 1) + 1))
                item = _outbox_for(store, key)
                if item is not None:
                    item.update({"status": "pending", "updatedAt": now_iso(), "reconciledAt": None})
                await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))
                return {"state": "started", "record": existing}
            if status == "uncertain":
                return {"state": "uncertain", "record": existing}
            expires_at = _parse_timestamp(existing.get("leaseExpiresAt"))
            if expires_at is not None and expires_at > utc_now():
                return {"state": "processing", "record": existing}

            # A mutation may already have changed its domain. An expired lease
            # is blocked until domain/operator evidence reconciles the result.
            stamp = now_iso()
            existing.update({"status": "uncertain", "uncertainAt": stamp, "updatedAt": stamp})
            item = _outbox_for(store, key)
            if item is not None:
                item.update({"status": "needs_reconciliation", "updatedAt": stamp})
            await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))
            return {"state": "uncertain", "record": existing}

        created = now_iso()
        record = {
            "key": key,
            "method": method,
            "path": path,
            "digest": digest,
            "createdAt": created,
            **_lease_fields(1),
        }
        outbox = {
            "id": f"outbox_{hashlib.sha256(f'{user_id}:{key}'.encode()).hexdigest()[:20]}",
            "idempotencyKey": key,
            "eventType": "http_mutation",
            "path": path,
            "method": method,
            "status": "pending",
            "attempts": 0,
            "createdAt": created,
            "updatedAt": created,
        }
        store["idempotency"].insert(0, record)
        store["outbox"].insert(0, outbox)
        await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))
        return {"state": "started", "record": record}


async def complete_request(
    user_id: str,
    key: str,
    status_code: int,
    payload: Any,
    headers: dict[str, str],
    *,
    lease_id: str,
) -> bool:
    """Finalize only the active lease; stale workers cannot rewrite evidence."""
    async with _lock:
        store = await asyncio.to_thread(_load, user_id)
        record = next((item for item in store["idempotency"] if item.get("key") == key), None)
        if not record or record.get("status") != "processing" or record.get("leaseId") != lease_id:
            return False
        stamp = now_iso()
        uncertain = status_code >= 500
        record.update({
            "status": "uncertain" if uncertain else "completed",
            "statusCode": status_code,
            "payload": payload,
            "headers": headers,
            "updatedAt": stamp,
            "completedAt": None if uncertain else stamp,
            "uncertainAt": stamp if uncertain else None,
        })
        item = _outbox_for(store, key)
        if item is not None:
            item.update({
                "status": "needs_reconciliation" if uncertain else "published",
                "attempts": int(item.get("attempts") or 0) + 1,
                "lastStatusCode": status_code,
                "updatedAt": stamp,
                "publishedAt": None if uncertain else stamp,
            })
        await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))
        return True


async def reconcile_request(
    user_id: str,
    key: str,
    outcome: Literal["no_effect", "completed"],
    *,
    status_code: int = 200,
    payload: Any = None,
    headers: dict[str, str] | None = None,
    actor: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Record evidence before a retry or cached replay is released."""
    async with _lock:
        store = await asyncio.to_thread(_load, user_id)
        record = next((item for item in store["idempotency"] if item.get("key") == key), None)
        if record is None:
            raise KeyError(key)
        if record.get("status") != "uncertain":
            raise ValueError("A operacao nao esta aguardando conciliacao.")
        stamp = now_iso()
        evidence: dict[str, Any] = {
            "reconciledAt": stamp, "reconciliation": outcome, "updatedAt": stamp,
        }
        if actor is not None:
            evidence["reconciledBy"] = actor
        if note is not None:
            evidence["reconciliationNote"] = note
        if outcome == "no_effect":
            record.update({"status": "retryable", **evidence})
        else:
            record.update({
                "status": "completed", "statusCode": status_code, "payload": payload,
                "headers": headers or {}, "completedAt": stamp, **evidence,
            })
        item = _outbox_for(store, key)
        if item is not None:
            item.update({
                "status": "reconciled_no_effect" if outcome == "no_effect" else "published",
                "reconciledAt": stamp, "updatedAt": stamp,
                "publishedAt": stamp if outcome == "completed" else None,
            })
        await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))
        return record


async def reliability_snapshot(user_id: str) -> dict[str, Any]:
    store = await asyncio.to_thread(_load, user_id)
    return {
        "outbox": store["outbox"][:100],
        "pending": len([item for item in store["outbox"] if item.get("status") == "pending"]),
        "failed": len([item for item in store["outbox"] if item.get("status") == "failed"]),
        "needsReconciliation": len([
            item for item in store["outbox"] if item.get("status") == "needs_reconciliation"
        ]),
        "idempotencyRecords": len(store["idempotency"]),
        "updatedAt": store.get("updatedAt"),
    }
