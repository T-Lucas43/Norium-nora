from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from app.core.tenant import read_account_db, read_user_db, write_account_db, write_user_db


DB_NAME = "plataforma"
_lock = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_store() -> dict[str, Any]:
    return {
        "workspaces": [],
        "absences": [],
        "portalInvites": [],
        "portalRequests": [],
        "forms": [],
        "submissions": [],
        "knowledge": [],
        "signatures": [],
        "approvalRules": [],
        "vault": [],
        "slaPolicies": [],
        "slaCases": [],
        "captures": [],
        "meetings": [],
        "handoffs": [],
        "updatedAt": None,
    }


def _normalize(raw: Any) -> dict[str, Any]:
    store = empty_store()
    if isinstance(raw, dict):
        for key, default in store.items():
            value = raw.get(key)
            store[key] = value if isinstance(value, type(default)) else default
    return store


async def load_store(user_id: str, *, account_level: bool = False) -> dict[str, Any]:
    reader = read_account_db if account_level else read_user_db
    return await asyncio.to_thread(lambda: _normalize(reader(user_id, DB_NAME, {})))


async def save_store(user_id: str, store: dict[str, Any], *, account_level: bool = False) -> None:
    writer = write_account_db if account_level else write_user_db
    store["updatedAt"] = now_iso()
    await asyncio.to_thread(writer, user_id, DB_NAME, store)


async def mutate_store(user_id: str, mutation, *, account_level: bool = False) -> Any:
    async with _lock:
        store = await load_store(user_id, account_level=account_level)
        result = mutation(store)
        await save_store(user_id, store, account_level=account_level)
        return result

