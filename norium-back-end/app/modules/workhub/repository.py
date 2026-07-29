from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

from app.core.tenant import read_user_db, write_user_db


SHARED_INBOX_DB = "workhub_inbox"
GOALS_DB = "workhub_metas"
FOCUS_DB = "workhub_foco"
PUSH_DB = "workhub_push"
BACKUP_DB = "workhub_backups"
USAGE_DB = "workhub_uso"
MAX_ITEMS = 2000

_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def _read_items(user_id: str, db_name: str) -> list[dict[str, Any]]:
    payload = read_user_db(user_id, db_name, [])
    return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []


async def list_records(user_id: str, db_name: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_read_items, user_id, db_name)


async def upsert_record(
    user_id: str,
    db_name: str,
    item: dict[str, Any],
    *,
    max_items: int = MAX_ITEMS,
) -> dict[str, Any]:
    record_id = str(item.get("id") or "")
    async with _locks[db_name]:
        items = await list_records(user_id, db_name)
        updated = False
        for index, current in enumerate(items):
            if str(current.get("id") or "") != record_id:
                continue
            items[index] = {**current, **item}
            item = items[index]
            updated = True
            break
        if not updated:
            items.insert(0, item)
        await asyncio.to_thread(write_user_db, user_id, db_name, items[:max_items])
    return item


async def remove_record(user_id: str, db_name: str, record_id: str) -> bool:
    async with _locks[db_name]:
        items = await list_records(user_id, db_name)
        remaining = [item for item in items if str(item.get("id") or "") != record_id]
        if len(remaining) == len(items):
            return False
        await asyncio.to_thread(write_user_db, user_id, db_name, remaining)
    return True
