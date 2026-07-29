"""Idempotencia duravel e outbox recuperavel para o armazenamento JSON."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.tenant import read_user_db, write_user_db


DB_NAME = "confiabilidade"
MAX_RECORDS = 500
_lock = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def body_digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


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
    cutoff = datetime.now(timezone.utc) - timedelta(days=2)

    def recent(item: dict[str, Any]) -> bool:
        try:
            return datetime.fromisoformat(str(item.get("createdAt"))) >= cutoff
        except (TypeError, ValueError):
            return True

    store["idempotency"] = [item for item in store["idempotency"] if recent(item)][:MAX_RECORDS]
    store["outbox"] = store["outbox"][:MAX_RECORDS]
    store["updatedAt"] = now_iso()
    return store


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
            if existing.get("status") == "completed":
                return {"state": "completed", "record": existing}
            return {"state": "processing", "record": existing}

        created = now_iso()
        record = {
            "key": key,
            "method": method,
            "path": path,
            "digest": digest,
            "status": "processing",
            "createdAt": created,
            "updatedAt": created,
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
) -> None:
    async with _lock:
        store = await asyncio.to_thread(_load, user_id)
        updated_at = now_iso()
        for record in store["idempotency"]:
            if record.get("key") == key:
                record.update(
                    {
                        "status": "completed",
                        "statusCode": status_code,
                        "payload": payload,
                        "headers": headers,
                        "updatedAt": updated_at,
                    }
                )
                break
        for item in store["outbox"]:
            if item.get("idempotencyKey") == key:
                item.update(
                    {
                        "status": "published" if status_code < 500 else "failed",
                        "attempts": int(item.get("attempts") or 0) + 1,
                        "lastStatusCode": status_code,
                        "updatedAt": updated_at,
                        "publishedAt": updated_at if status_code < 500 else None,
                    }
                )
                break
        await asyncio.to_thread(write_user_db, user_id, DB_NAME, _trim(store))


async def reliability_snapshot(user_id: str) -> dict[str, Any]:
    store = await asyncio.to_thread(_load, user_id)
    return {
        "outbox": store["outbox"][:100],
        "pending": len([item for item in store["outbox"] if item.get("status") == "pending"]),
        "failed": len([item for item in store["outbox"] if item.get("status") == "failed"]),
        "idempotencyRecords": len(store["idempotency"]),
        "updatedAt": store.get("updatedAt"),
    }
