"""WhatsApp views in the existing personal/team saved-view documents."""
from __future__ import annotations

import asyncio
import uuid
from datetime import date
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field, StrictBool, StrictInt, field_validator
from app.core.identity import require_user_id
from app.modules.auth.router import assert_route_permissions, current_user
from app.shared.schemas import StrictModel
from .store import mutate, snapshot, require_room
from .router import now

router = APIRouter(prefix="/api/business/whatsapp-views", tags=["Visões do WhatsApp"])


class Filters(StrictModel):
    unread: StrictBool = False
    kind: Literal["all", "individual", "group"] = "all"
    fromDate: str = ""
    toDate: str = ""
    tagIds: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(default_factory=list, max_length=20)
    responsavel: Literal["all", "me", "none", "nora"] = "all"
    estado: Literal["", "open", "waiting_customer", "resolved"] = ""

    @field_validator("fromDate", "toDate")
    @classmethod
    def valid_date(cls, value):
        if value:
            try:
                parsed = date.fromisoformat(value)
                if parsed.isoformat() != value or not 1970 <= parsed.year <= 2100:
                    raise ValueError()
            except (ValueError, TypeError):
                raise ValueError("Informe uma data válida entre 1970 e 2100.") from None
        return value


class View(StrictModel):
    name: str = Field(min_length=2, max_length=80)
    scope: Literal["personal", "team"] = "personal"
    filters: Filters
    inboxId: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ViewUpdate(View):
    expectedVersion: StrictInt = Field(ge=1)


async def context(user, inbox_id):
    assert_route_permissions(user, "/api/chat")
    if inbox_id:
        from app.modules.whatsapp_team.context import authorized
        grant, _, _ = await authorized(user, inbox_id)
        return inbox_id, grant.manager
    return "personal:" + require_user_id(user), False


@router.get("")
async def views(inboxId: str | None = Query(None, pattern=r"^[a-f0-9]{64}$"), user: dict = Depends(current_user)):
    key, manager = await context(user, inboxId)
    personal, team = await asyncio.gather(asyncio.to_thread(snapshot, user, "saved_views"), asyncio.to_thread(snapshot, user, "team_views"))
    items = [{**row, "canEdit": row.get("createdBy") == require_user_id(user) or manager}
             for row in [*personal["items"], *team["items"]] if row.get("kind") == "whatsapp" and row.get("contextKey") == key]
    await context(user, inboxId)
    return {"items": items, "canShare": manager}


def validate_payload(payload):
    if len(payload.name.strip()) < 2:
        raise HTTPException(422, "Dê um nome à visão.")
    if payload.filters.fromDate and payload.filters.toDate and payload.filters.fromDate > payload.filters.toDate:
        raise HTTPException(422, "O início do período deve ser anterior ao fim.")


@router.post("", status_code=201)
async def create(payload: View, user: dict = Depends(current_user)):
    key, manager = await context(user, payload.inboxId)
    validate_payload(payload)
    if payload.scope == "team" and not manager:
        raise HTTPException(403, "Somente gestores podem compartilhar visões da caixa da equipe.")
    row = {"id": "view_" + uuid.uuid4().hex, "kind": "whatsapp", "contextKey": key,
           "name": payload.name.strip(), "scope": payload.scope, "filters": payload.filters.model_dump(),
           "createdBy": require_user_id(user), "createdAt": now(), "version": 1}
    def operation(value):
        require_room(value["items"], 100)
        value["items"].append(row)
        return row
    return {"item": await asyncio.to_thread(mutate, user, "saved_views" if payload.scope == "personal" else "team_views", operation)}


def find(value, identifier, key, actor, manager, expected):
    row = next((item for item in value["items"] if item.get("id") == identifier and item.get("kind") == "whatsapp"
                and item.get("contextKey") == key), None)
    if row is None:
        raise HTTPException(404, "Visão indisponível.")
    if row.get("createdBy") != actor and not manager:
        raise HTTPException(403, "Somente o autor ou gestor pode alterar esta visão.")
    if row.get("version", 1) != expected:
        raise HTTPException(409, "A visão mudou. Atualize antes de continuar.")
    return row


@router.put("/{scope}/{identifier}")
async def update(scope: Literal["personal", "team"], identifier: str, payload: ViewUpdate, user: dict = Depends(current_user)):
    key, manager = await context(user, payload.inboxId)
    validate_payload(payload)
    if scope != payload.scope:
        raise HTTPException(422, "Crie outra visão para alterar o compartilhamento.")
    def operation(value):
        row = find(value, identifier, key, require_user_id(user), manager, payload.expectedVersion)
        row.update(name=payload.name.strip(), filters=payload.filters.model_dump(), updatedAt=now(), version=payload.expectedVersion + 1)
        return row
    return {"item": await asyncio.to_thread(mutate, user, "saved_views" if scope == "personal" else "team_views", operation)}


@router.delete("/{scope}/{identifier}")
async def remove(scope: Literal["personal", "team"], identifier: str, expectedVersion: int = Query(ge=1),
                 inboxId: str | None = Query(None, pattern=r"^[a-f0-9]{64}$"), user: dict = Depends(current_user)):
    key, manager = await context(user, inboxId)
    def operation(value):
        row = find(value, identifier, key, require_user_id(user), manager, expectedVersion)
        value["items"].remove(row)
        return {"ok": True}
    return await asyncio.to_thread(mutate, user, "saved_views" if scope == "personal" else "team_views", operation)
