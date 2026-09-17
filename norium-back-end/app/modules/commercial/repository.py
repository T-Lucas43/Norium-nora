from __future__ import annotations

import asyncio
from typing import Any

from app.core.tenant import read_user_db, write_user_db
from app.core.tenant import get_user_db_path
from app.infrastructure.persistence.json_repository import PersistenceError


DB_NAME = "comercial"
STORE_LOCK = asyncio.Lock()
DEFAULT_STORE: dict[str, list[dict[str, Any]]] = {
    "proposals": [],
    "contracts": [],
    "brandProfiles": [],
    "templates": [],
    "uploadedDocuments": [],
    "processingJobs": [],
    "publicLinks": [],
}


def read_store(tenant_id: str) -> dict[str, list[dict[str, Any]]]:
    payload = read_user_db(tenant_id, DB_NAME, DEFAULT_STORE)
    path = get_user_db_path(tenant_id, DB_NAME)
    if not isinstance(payload, dict):
        raise PersistenceError(path, "schema")
    for key in DEFAULT_STORE:
        items = payload.get(key, [])
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise PersistenceError(path, "schema")
    # Keep unknown historical fields so a later write does not erase them.
    return {**payload, **{key: payload.get(key, []) for key in DEFAULT_STORE}}


async def write_store(tenant_id: str, store: dict[str, list[dict[str, Any]]]) -> None:
    await asyncio.to_thread(write_user_db, tenant_id, DB_NAME, store)
