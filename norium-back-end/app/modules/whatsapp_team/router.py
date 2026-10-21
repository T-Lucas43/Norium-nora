"""Explicit opt-in and metadata API, separate from personal WhatsApp routes."""
from __future__ import annotations

import asyncio
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, StrictBool, StrictInt

from app.shared.schemas import StrictModel
from app.modules.auth.router import current_user
from . import access, context, repository, service
from .reads import router as read_router
from .actions import router as action_router
from .notifications import changed

router = APIRouter(tags=["WhatsApp da equipe"])
router.include_router(read_router)
router.include_router(action_router)


class SharingPayload(StrictModel):
    enabled: StrictBool
    expectedRevision: StrictInt = Field(ge=0)
    autoAssignOnSend: StrictBool = True
    autoDistribute: StrictBool = False


class AssignmentPayload(StrictModel):
    expectedVersion: StrictInt = Field(ge=0)
    assigneeUserId: str | None = Field(None, min_length=1, max_length=180)
    assigneeKind: Literal["user", "none"] | None = None
    status: Literal["open", "waiting_customer", "resolved"] | None = None


class NotePayload(StrictModel):
    body: str = Field(min_length=1, max_length=8000)
    mentions: list[str] = Field(default_factory=list, max_length=20)


class NoteEditPayload(StrictModel):
    expectedVersion: StrictInt = Field(ge=1)
    body: str = Field(min_length=1, max_length=8000)


class VersionPayload(StrictModel):
    expectedVersion: StrictInt = Field(ge=1)


@router.get("/api/chat/caixas")
async def inboxes(user: dict = Depends(current_user)):
    try:
        grant = await access.resolve(context.runtime(), user)
    except HTTPException as error:
        if error.status_code in {403, 404, 409}:
            return {"items": [], "configuration": None}
        raise
    value = await asyncio.to_thread(repository.snapshot, grant.scope)
    configuration = {key: value["inbox"].get(key, False) for key in ("enabled", "revision", "autoAssignOnSend", "autoDistribute")} if grant.actor_id == grant.scope.owner_id else None
    if configuration is not None:
        configuration["id"] = grant.scope.inbox_id
    items = [{"id": grant.scope.inbox_id, "name": "WhatsApp da equipe", "canManage": grant.manager}]
    return {"items": items if value["inbox"].get("enabled") is True else [], "configuration": configuration}


@router.patch("/api/chat/caixas/configuracao")
async def configure(payload: SharingPayload, user: dict = Depends(current_user)):
    grant = await access.resolve(context.runtime(), user, owner_only=True)
    result = await asyncio.to_thread(service.sharing, grant, enabled=payload.enabled,
                                    expected_revision=payload.expectedRevision, auto_assign_on_send=payload.autoAssignOnSend, auto_distribute=payload.autoDistribute)
    return {"id": grant.scope.inbox_id, **{key: result[key] for key in ("enabled", "revision", "autoAssignOnSend", "autoDistribute")}}


@router.get("/api/chat/caixas/{inbox_id}/membros")
async def members(inbox_id: str, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id)
    from .presence import roster
    result = await roster(grant)
    await context.authorized(user, inbox_id)
    return {"items": result, "canManage": grant.manager}


@router.patch("/api/chat/caixas/{inbox_id}/conversas/{conversation_id}/atendimento")
async def assignment(inbox_id: str, conversation_id: str, payload: AssignmentPayload, user: dict = Depends(current_user)):
    grant, before, _ = await context.authorized(user, inbox_id, conversation_id)
    previous_actor = before["assignments"].get(conversation_id, {}).get("assigneeUserId")
    changes = payload.model_dump(exclude_unset=True, exclude={"expectedVersion"})
    result = await asyncio.to_thread(service.update_assignment, grant, conversation_id,
                                     expected_version=payload.expectedVersion, changes=changes)
    await changed(user, inbox_id, conversation_id, recipients={result["assigneeUserId"]} if result.get("assigneeUserId") else set(),
                  invalidate={previous_actor} if previous_actor else set())
    return result


@router.get("/api/chat/caixas/{inbox_id}/conversas/{conversation_id}/atendimento")
async def attendance_context(inbox_id: str, conversation_id: str, user: dict = Depends(current_user)):
    grant, value, _ = await context.authorized(user, inbox_id, conversation_id)
    from .presence import roster, viewers
    members = await roster(grant)
    active_viewers = await viewers(grant, conversation_id, value)
    await context.authorized(user, inbox_id, conversation_id)
    return {"assignment": {**service.default_assignment(conversation_id), **value["assignments"].get(conversation_id, {})},
            "members": members, "canManage": grant.manager, "viewers": active_viewers,
            "notes": service.page(value, conversation_id, "notes"), "events": service.page(value, conversation_id, "events")}


@router.post("/api/chat/caixas/{inbox_id}/conversas/{conversation_id}/notas", status_code=201)
async def create_note(inbox_id: str, conversation_id: str, payload: NotePayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, conversation_id)
    result = await asyncio.to_thread(service.create_note, grant, conversation_id, body=payload.body, mentions=payload.mentions)
    await changed(user, inbox_id, conversation_id, recipients=set(result["mentions"]), note_id=result["id"])
    return result


@router.patch("/api/chat/caixas/{inbox_id}/conversas/{conversation_id}/notas/{note_id}")
async def edit_note(inbox_id: str, conversation_id: str, note_id: str, payload: NoteEditPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, conversation_id)
    result = await asyncio.to_thread(service.change_note, grant, conversation_id, note_id, expected_version=payload.expectedVersion, body=payload.body)
    await changed(user, inbox_id, conversation_id)
    return result


@router.delete("/api/chat/caixas/{inbox_id}/conversas/{conversation_id}/notas/{note_id}")
async def delete_note(inbox_id: str, conversation_id: str, note_id: str, payload: VersionPayload, user: dict = Depends(current_user)):
    grant, _, _ = await context.authorized(user, inbox_id, conversation_id)
    result = await asyncio.to_thread(service.change_note, grant, conversation_id, note_id, expected_version=payload.expectedVersion, body=None)
    await changed(user, inbox_id, conversation_id)
    return result
