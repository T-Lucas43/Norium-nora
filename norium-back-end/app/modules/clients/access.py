from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException

from app.modules.clients.repository import list_clients


def client_owner_id(client: dict[str, Any], store_id: str) -> str:
    return str(client.get("createdBy") or store_id)


def client_access_role(client: dict[str, Any], user: dict[str, Any], store_id: str) -> str | None:
    user_id = str(user.get("id") or "")
    if user_id and client_owner_id(client, store_id) == user_id:
        return "owner"
    access = client.get("access") if isinstance(client.get("access"), dict) else {}
    team_permission = str(access.get("teamPermission") or "none")
    person_permission = next(
        (
            str(item.get("permission") or "")
            for item in access.get("people", [])
            if isinstance(item, dict) and str(item.get("userId") or "") == user_id
        ),
        "",
    )
    if person_permission == "edit" or team_permission == "edit":
        return "edit"
    if person_permission == "view" or team_permission == "view":
        return "view"
    return None


def require_client_access(
    client: dict[str, Any],
    user: dict[str, Any],
    store_id: str,
    minimum: str = "view",
) -> str:
    role = client_access_role(client, user, store_id)
    allowed = {
        "view": {"owner", "edit", "view"},
        "edit": {"owner", "edit"},
        "owner": {"owner"},
    }
    if role not in allowed[minimum]:
        if minimum == "view":
            raise HTTPException(404, "Cliente não encontrado.")
        detail = (
            "Somente o proprietário pode alterar o compartilhamento."
            if minimum == "owner"
            else "Você não tem permissão para editar este cliente."
        )
        raise HTTPException(403, detail)
    return role


async def client_store_ids_for_user(user: dict[str, Any]) -> list[str]:
    from app.modules.team.router import visible_team_members

    current_id = str(user.get("id") or "")
    try:
        member_ids = [
            str(item.get("id") or "")
            for item in await visible_team_members(user)
            if item.get("status") == "ativo"
        ]
    except Exception:
        member_ids = []
    return list(dict.fromkeys(item for item in [current_id, *member_ids] if item))


async def find_accessible_client(
    user: dict[str, Any],
    client_id: str,
    minimum: str = "view",
) -> tuple[str, list[dict[str, Any]], int, dict[str, Any]]:
    for store_id in await client_store_ids_for_user(user):
        items = await asyncio.to_thread(list_clients, store_id)
        for index, client in enumerate(items):
            if str(client.get("id") or "") != client_id:
                continue
            require_client_access(client, user, store_id, minimum)
            return store_id, items, index, client
    raise HTTPException(404, "Cliente não encontrado.")


async def list_accessible_clients(
    user: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    stores = await client_store_ids_for_user(user)
    payloads = await asyncio.gather(
        *(asyncio.to_thread(list_clients, store_id) for store_id in stores)
    )
    result: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    for store_id, items in zip(stores, payloads):
        for client in items:
            client_id = str(client.get("id") or "")
            if not client_id or client_id in seen:
                continue
            if client_access_role(client, user, store_id):
                seen.add(client_id)
                result.append((store_id, client))
    return result
