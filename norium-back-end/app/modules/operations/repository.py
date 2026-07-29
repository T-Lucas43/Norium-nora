from __future__ import annotations

import asyncio
from typing import Any

from app.core.tenant import read_user_db, write_user_db


AUDIT_DB = "operacao_auditoria"
APPROVAL_DB = "operacao_aprovacoes"
RECEIPT_DB = "operacao_comprovantes"
MEMORY_DB = "nora_memoria"
TEMPLATE_DB = "operacao_modelos"
FOLLOWUP_DB = "operacao_acompanhamentos"
SETTINGS_DB = "operacao_configuracoes"
MAX_ITEMS = 1000

_locks = {
    AUDIT_DB: asyncio.Lock(),
    APPROVAL_DB: asyncio.Lock(),
    RECEIPT_DB: asyncio.Lock(),
    MEMORY_DB: asyncio.Lock(),
    TEMPLATE_DB: asyncio.Lock(),
    FOLLOWUP_DB: asyncio.Lock(),
    SETTINGS_DB: asyncio.Lock(),
}


def _load(user_id: str, db_name: str) -> list[dict[str, Any]]:
    payload = read_user_db(user_id, db_name, [])
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


async def list_items(user_id: str, db_name: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_load, user_id, db_name)


async def prepend_item(user_id: str, db_name: str, item: dict[str, Any]) -> dict[str, Any]:
    async with _locks[db_name]:
        items = await list_items(user_id, db_name)
        items = [item, *[current for current in items if current.get("id") != item.get("id")]][:MAX_ITEMS]
        await asyncio.to_thread(write_user_db, user_id, db_name, items)
    return item


async def replace_item(
    user_id: str,
    db_name: str,
    item_id: str,
    update: dict[str, Any],
) -> dict[str, Any] | None:
    async with _locks[db_name]:
        items = await list_items(user_id, db_name)
        found: dict[str, Any] | None = None
        for index, current in enumerate(items):
            if str(current.get("id")) != item_id:
                continue
            found = {**current, **update}
            items[index] = found
            break
        if found is not None:
            await asyncio.to_thread(write_user_db, user_id, db_name, items[:MAX_ITEMS])
        return found


async def delete_item(user_id: str, db_name: str, item_id: str) -> bool:
    async with _locks[db_name]:
        items = await list_items(user_id, db_name)
        remaining = [item for item in items if str(item.get("id")) != item_id]
        if len(remaining) == len(items):
            return False
        await asyncio.to_thread(write_user_db, user_id, db_name, remaining[:MAX_ITEMS])
        return True
