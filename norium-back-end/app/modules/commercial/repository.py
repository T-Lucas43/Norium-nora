from __future__ import annotations

import asyncio
from typing import Any

from app.core.tenant import read_user_db, write_user_db


DB_NAME = "comercial"
DEFAULT_STORE: dict[str, list[dict[str, Any]]] = {
    "proposals": [],
    "contracts": [],
    "brandProfiles": [],
    "templates": [],
}


def read_store(tenant_id: str) -> dict[str, list[dict[str, Any]]]:
    payload = read_user_db(tenant_id, DB_NAME, DEFAULT_STORE)
    if not isinstance(payload, dict):
        payload = {}
    return {
        key: [item for item in payload.get(key, []) if isinstance(item, dict)]
        if isinstance(payload.get(key), list)
        else []
        for key in DEFAULT_STORE
    }


async def write_store(tenant_id: str, store: dict[str, list[dict[str, Any]]]) -> None:
    await asyncio.to_thread(write_user_db, tenant_id, DB_NAME, store)
