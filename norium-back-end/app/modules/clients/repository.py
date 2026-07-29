from __future__ import annotations

import asyncio
from typing import Any

from app.core.tenant import read_user_db, write_user_db


DB_NAME = "clientes"


def list_clients(user_id: str) -> list[dict[str, Any]]:
    payload = read_user_db(user_id, DB_NAME, [])
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


async def save_clients(user_id: str, items: list[dict[str, Any]]) -> None:
    await asyncio.to_thread(write_user_db, user_id, DB_NAME, items)
