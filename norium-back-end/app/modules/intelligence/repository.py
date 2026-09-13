from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

from app.core.tenant import read_user_db, write_user_db


DB_NAME = "intelligence"
_lock = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_store() -> dict[str, Any]:
    return {
        "browserProfiles": [],
        "browserRuns": [],
        "knowledgeBases": [],
        "knowledgeSources": [],
        "installations": [],
        "modelProviders": [],
        "modelPolicies": [],
        "modelUsage": [],
        "audit": [],
        "updatedAt": None,
    }


def normalize_store(raw: Any) -> dict[str, Any]:
    store = empty_store()
    if isinstance(raw, dict):
        for key, default in store.items():
            value = raw.get(key)
            store[key] = value if isinstance(value, type(default)) else default
    return store


def read_store(user_id: str) -> dict[str, Any]:
    return normalize_store(read_user_db(user_id, DB_NAME, {}))


def write_store(user_id: str, store: dict[str, Any]) -> None:
    store["updatedAt"] = now_iso()
    write_user_db(user_id, DB_NAME, store)


async def mutate_store(user_id: str, mutation: Callable[[dict[str, Any]], Any]) -> Any:
    async with _lock:
        store = await asyncio.to_thread(read_store, user_id)
        result = mutation(store)
        await asyncio.to_thread(write_store, user_id, store)
        return result
