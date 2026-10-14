"""Resource references carry identifiers; titles are resolved for each reader."""
from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import parse_qs, urlparse
from typing import Literal
from fastapi import HTTPException
from pydantic import Field
from app.shared.schemas import StrictModel
from app.modules.auth.router import assert_route_permissions


class ResourceRef(StrictModel):
    type: Literal["task", "client", "proposal", "contract", "budget", "meeting", "finance"]
    id: str = Field(min_length=1, max_length=150, pattern=r"^[A-Za-z0-9_.:-]+$")


def link_references(text: str) -> list[dict]:
    # Only the configured product origin and its official homologation origin.
    origins = {urlparse(os.getenv("FRONTEND_URL", "")).netloc.casefold(), "homologacao.norium-ai.com", "norium-ai.com"} - {""}
    result = []
    for match in re.finditer(r"https?://[^\s<>]+", text):
        url = urlparse(match.group().rstrip(".,)"))
        if url.netloc.casefold() not in origins or not url.path.startswith("/app"):
            continue
        params = parse_qs(url.query)
        try:
            ref = ResourceRef(type=params.get("resourceType", [""])[0], id=params.get("resourceId", [""])[0]).model_dump()
        except ValueError:
            continue
        if ref not in result:
            result.append(ref)
    return result[:6]


async def resolve_card(ref: dict, user: dict) -> dict:
    kind, identifier = ref.get("type"), str(ref.get("id") or "")
    restricted = {"type": kind, "id": identifier, "restricted": True, "title": "Item restrito"}
    try:
        if kind == "task":
            assert_route_permissions(user, "/api/tarefas")
            from app.modules.tasks.router import require_task_access
            item = await require_task_access(user, identifier)
            tab, label = "Tarefas", "Tarefa"
        elif kind == "client":
            assert_route_permissions(user, "/api/clientes")
            from app.modules.clients.access import find_accessible_client
            _, _, _, item = await find_accessible_client(user, identifier)
            tab, label = "Clientes", "Cliente"
        elif kind in {"proposal", "contract", "budget"}:
            assert_route_permissions(user, "/api/comercial")
            from app.modules.commercial import service as commercial
            field = "contracts" if kind == "contract" else "proposals"
            item = None
            for store_id in await commercial.document_store_ids_for_user(user):
                store = await asyncio.to_thread(commercial.read_store, store_id)
                candidate = next((row for row in store.get(field, []) if str(row.get("id")) == identifier), None)
                if candidate and commercial.document_access_role(candidate, user) and (kind == "contract" or commercial.can_view_proposal(user, candidate)):
                    item = candidate
                    break
            if item is None:
                return restricted
            tab, label = "Documentos", {"proposal": "Proposta", "contract": "Contrato", "budget": "Orçamento"}[kind]
        elif kind == "meeting":
            from app.modules.team import router as team
            store = await asyncio.to_thread(team.read_chat_store, team.team_id_for(user))
            item = team.scheduled_meeting_or_404(store, identifier)
            team.require_scheduled_meeting_participant(item, str(user["id"]))
            tab, label = "Chat da Equipe", "Reunião"
        elif kind == "finance":
            assert_route_permissions(user, "/api/financeiro")
            from app.services.finance_store import list_finance
            from app.core.identity import require_user_id
            store = await asyncio.to_thread(list_finance, require_user_id(user))
            item = next((row for row in store.get("lancamentos", []) if str(row.get("id")) == identifier), None)
            if not item:
                return restricted
            tab, label = "Financeiro", "Lançamento"
        else:
            return restricted
    except HTTPException as error:
        if error.status_code in {403, 404}:
            return restricted
        raise
    return {"type": kind, "id": identifier, "restricted": False, "label": label,
            "title": str(item.get("title") or item.get("name") or item.get("description") or label)[:160],
            "status": str(item.get("status") or ""), "dueDate": item.get("dueDate") or item.get("startsAt"),
            "deepLink": {"tab": tab, "entityType": kind, "entityId": identifier}}


def message_refs(message: dict) -> list[dict]:
    refs = list(message.get("resourceRefs") or [])
    meta = message.get("metadata") or {}
    deep_link = meta.get("deepLink") if isinstance(meta.get("deepLink"), dict) else {}
    if deep_link.get("entityType") in {"task", "client", "proposal", "contract", "budget", "meeting", "finance"} and deep_link.get("entityId"):
        refs.append({"type": deep_link["entityType"], "id": str(deep_link["entityId"])})
    for kind, key in (("client", "clientId"), ("finance", "entryId")):
        if meta.get(key): refs.append({"type": kind, "id": str(meta[key])})
    if meta.get("taskId"):
        refs.append({"type": "task", "id": str(meta["taskId"])})
    if meta.get("documentId") and meta.get("documentType") in {"proposal", "contract", "budget"}:
        refs.append({"type": meta["documentType"], "id": str(meta["documentId"])})
    if meta.get("meetingId"):
        refs.append({"type": "meeting", "id": str(meta["meetingId"])})
    return [ref for index, ref in enumerate(refs) if ref not in refs[:index]][:6]


async def publish_resource_change(metadata: dict) -> None:
    from app.modules.team import router as team
    if not team.manager.connections:
        return
    refs = [{"type": kind, "id": str(metadata[key])} for kind, key in
            (("task", "taskId"), ("client", "clientId"), ("proposal", "proposalId"), ("contract", "contractId"), ("finance", "entryId")) if metadata.get(key)]
    entity_type, entity_id = metadata.get("entityType"), metadata.get("entityId")
    if entity_id and entity_type in {"task", "client", "proposal", "contract", "finance_entry"}:
        refs.append({"type": "finance" if entity_type == "finance_entry" else entity_type, "id": str(entity_id)})
    if entity_id and entity_type == "commercial_document":
        refs.extend({"type": kind, "id": str(entity_id)} for kind in ("proposal", "contract", "budget"))
    if not refs or not metadata.get("userId"):
        return
    team_id = await team.team_id_for_user_id(str(metadata["userId"]))
    directory = await team.read_user_store()
    users = {str(item["id"]): item for item in directory.get("users", [])}
    from app.services.task_activity import activity_visible, is_task_activity
    for reader_id in team.manager.online_users(team_id):
        reader = users.get(reader_id)
        if not reader or reader.get("status") != "ativo": continue
        visible_refs = []
        for ref in refs:
            if ref["type"] == "task" and is_task_activity(metadata) and metadata.get("taskProject"):
                allowed = activity_visible(metadata, reader_id)
            else:
                allowed = not (await resolve_card(ref, reader)).get("restricted")
            if allowed and ref not in visible_refs: visible_refs.append(ref)
        if visible_refs:
            # Even identifiers go only to resource readers. Each recipient still
            # refetches the card with its live permissions after receiving it.
            await team.manager.send_to_users(team_id, {reader_id}, {"type": "TEAM_RESOURCE_CHANGED", "resourceRefs": visible_refs})
