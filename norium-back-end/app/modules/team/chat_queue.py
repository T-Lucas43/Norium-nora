"""Internal chat outbox: message and delivery state commit in one document.

Uses the application's single writer topology and existing authoritative store.
The queue index contains references and due times only, never message bodies.
"""
from __future__ import annotations
import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
from fastapi import Depends, HTTPException
from pydantic import Field
from app.shared.schemas import StrictModel
from app.core.tenant import get_system_db_path, read_json_file, write_json_file
from app.core.request_context import current_workspace_id, set_request_context, reset_request_context
from app.routers.auth_router import current_user
from app.modules.team.chat_features import router, domain, authorized_message

queue_lock = asyncio.Lock()
_wake = asyncio.Event()
log = logging.getLogger(__name__)


def enabled() -> bool:
    return os.getenv("NORIUM_TEAM_CHAT_QUEUE_ENABLED", "0").lower() in {"1", "true", "yes"}


def read_index() -> dict:
    return read_json_file(get_system_db_path("team_chat_queue"), {"groups": {}})


def write_index(index: dict) -> None:
    write_json_file(get_system_db_path("team_chat_queue"), index)


async def register_due(team_id: str, due_at: str) -> None:
    index = await asyncio.to_thread(read_index)
    key = f"{team_id}:{current_workspace_id()}"
    group = index.setdefault("groups", {}).get(key, {})
    index["groups"][key] = {"teamId": team_id, "workspaceId": current_workspace_id(), "dueAt": min(due_at, group.get("dueAt") or due_at)}
    await asyncio.to_thread(write_index, index)
    _wake.set()


def valid_due(value: str) -> datetime:
    due = domain().parse_iso_datetime(value)
    now = datetime.now(timezone.utc)
    if not due or due < now+timedelta(seconds=60) or due > now+timedelta(days=365):
        raise HTTPException(400, "Escolha uma data entre um minuto e um ano a partir de agora.")
    return due


class QueueAttachment(StrictModel):
    fileName: str = Field(min_length=1, max_length=180)
    mimeType: str = Field(default="application/octet-stream", max_length=150)
    dataUrl: str = Field(min_length=16, max_length=22_000_000)


class ScheduledMessage(StrictModel):
    requestId: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    dueAt: str = Field(min_length=10, max_length=50)
    scope: Literal["team", "direct", "subteam"] = "team"
    recipientId: str | None = Field(default=None, max_length=150)
    subteamId: str | None = Field(default=None, max_length=150)
    text: str = Field(default="", max_length=2000)
    attachments: list[QueueAttachment] = Field(default_factory=list, max_length=8)
    mentionedUserIds: list[str] = Field(default_factory=list, max_length=100)


class ScheduleEdit(StrictModel):
    text: str = Field(min_length=1, max_length=2000)
    dueAt: str = Field(min_length=10, max_length=50)


class Reminder(StrictModel):
    dueAt: str = Field(min_length=10, max_length=50)


@router.get("/collaboration-capabilities")
async def capabilities(user: dict = Depends(current_user)):
    domain().require_team_chat(user)
    return {"scheduledMessages": enabled(), "reminders": enabled()}


@router.post("/scheduled-messages")
async def schedule_message(payload: ScheduledMessage, user: dict = Depends(current_user)):
    if not enabled():
        raise HTTPException(503, "O agendamento interno ainda não está ativado pelo administrador.")
    d = domain(); d.require_team_chat(user)
    due = valid_due(payload.dueAt).isoformat()
    team_id, user_id = d.team_id_for(user), str(user["id"])
    identifier = "scheduled_"+uuid.uuid5(uuid.NAMESPACE_URL, f"{team_id}:{current_workspace_id()}:{user_id}:{payload.requestId}").hex
    async with queue_lock, d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        existing = next((job for job in store.get("chatScheduled", []) if job["id"] == identifier), None)
        if existing:
            return {"scheduled": existing}
        participants = await d.thread_participant_ids(user, store, payload.scope, payload.recipientId, payload.subteamId)
        if not payload.text.strip() and not payload.attachments:
            raise HTTPException(400, "Digite uma mensagem ou anexe um arquivo.")
        if sum(job.get("authorId") == user_id and job.get("state") == "pending" for job in store.get("chatScheduled", [])) >= 100:
            raise HTTPException(409, "Você já tem 100 mensagens agendadas.")
        mentions = await d.validated_mentions(payload.text, payload.mentionedUserIds, participants, user)
        attachments = await asyncio.to_thread(d.save_attachments, [d.AttachmentPayload.model_validate(item.model_dump()) for item in payload.attachments], owner_id=team_id)
        message = {"id": "team_msg_"+uuid.uuid5(uuid.NAMESPACE_URL, identifier).hex,
                   "threadId": d.normalize_thread_id(payload.scope, user_id, payload.recipientId, payload.subteamId),
                   "scope": payload.scope, "senderId": user_id, "senderName": user.get("nome") or "Membro",
                   "senderAvatar": d.user_avatar_url(user_id), "recipientId": payload.recipientId, "subteamId": payload.subteamId,
                   "memberIds": sorted(participants) if payload.scope == "subteam" else [], "text": payload.text.strip(),
                   "attachments": attachments, "metadata": {"readBy": {}, "mentions": mentions,
                   "mentionedUserIds": [m["userId"] for m in mentions if m["userId"] != user_id]}, "createdAt": due}
        job = {"id": identifier, "authorId": user_id, "dueAt": due, "state": "pending", "message": message, "createdAt": d.now_iso()}
        # Index first. A crash before the document write leaves only an empty group.
        await register_due(team_id, due)
        store.setdefault("chatScheduled", []).append(job)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    return {"scheduled": job}


@router.get("/scheduled-messages")
async def scheduled_messages(threadId: str | None = None, user: dict = Depends(current_user)):
    d = domain(); d.require_team_chat(user)
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    allowed = {item["id"] for item in await d.accessible_threads(user, store)}
    return {"scheduled": [job for job in store.get("chatScheduled", []) if job.get("authorId") == user["id"] and job.get("state") == "pending" and job["message"]["threadId"] in allowed and (not threadId or job["message"]["threadId"] == threadId)]}


async def change_schedule(identifier: str, user: dict, payload: ScheduleEdit | None):
    d = domain(); d.require_team_chat(user)
    team_id = d.team_id_for(user)
    async with queue_lock, d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        job = next((item for item in store.get("chatScheduled", []) if item.get("id") == identifier and item.get("authorId") == user["id"]), None)
        if not job:
            raise HTTPException(404, "Agendamento não encontrado.")
        if job["state"] != "pending":
            raise HTTPException(409, "Esta mensagem já foi enviada ou cancelada.")
        if payload:
            due = valid_due(payload.dueAt).isoformat()
            await register_due(team_id, due)
            job.update(dueAt=due)
            job["message"].update(text=payload.text.strip(), createdAt=due)
            job["message"]["metadata"].update(mentions=[], mentionedUserIds=[])
        else:
            job.update(state="cancelled", cancelledAt=d.now_iso())
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    return {"scheduled": job}


@router.patch("/scheduled-messages/{identifier}")
async def edit_schedule(identifier: str, payload: ScheduleEdit, user: dict = Depends(current_user)):
    return await change_schedule(identifier, user, payload)


@router.delete("/scheduled-messages/{identifier}")
async def cancel_schedule(identifier: str, user: dict = Depends(current_user)):
    return await change_schedule(identifier, user, None)


@router.post("/messages/{message_id}/reminder")
async def remind_message(message_id: str, payload: Reminder, user: dict = Depends(current_user)):
    if not enabled():
        raise HTTPException(503, "Os lembretes internos ainda não estão ativados.")
    d = domain(); team_id = d.team_id_for(user)
    due = valid_due(payload.dueAt).isoformat()
    async with queue_lock, d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        source = await authorized_message(user, store, message_id)
        if sum(item.get("userId") == user["id"] and item.get("state") == "pending" for item in store.get("chatReminders", [])) >= 100:
            raise HTTPException(409, "Você já tem 100 lembretes pendentes.")
        item = {"id": "reminder_"+uuid.uuid4().hex, "messageId": source["id"], "threadId": source["threadId"], "userId": user["id"], "dueAt": due, "state": "pending"}
        await register_due(team_id, due)
        store.setdefault("chatReminders", []).append(item)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    return {"reminder": item}


async def dispatch_group(team_id: str, users: dict[str, dict], now: datetime) -> str | None:
    d = domain(); deliveries, reminders = [], []
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        changed = False
        for job in store.get("chatScheduled", []):
            if job.get("state") != "pending" or d.parse_iso_datetime(job["dueAt"]) > now:
                continue
            actor = users.get(job["authorId"])
            try:
                if not actor or actor.get("status") != "ativo" or d.team_id_for(actor) != team_id:
                    raise HTTPException(403, "Acesso revogado.")
                d.require_team_chat(actor)
                msg = job["message"]
                participants = await d.thread_participant_ids(actor, store, msg["scope"], msg.get("recipientId"), msg.get("subteamId"))
            except HTTPException:
                job.update(state="blocked", blockedAt=d.now_iso()); changed = True; continue
            msg.update(createdAt=now.isoformat(), senderName=actor.get("nome") or "Membro", senderAvatar=d.user_avatar_url(actor["id"]))
            if msg["scope"] == "subteam": msg["memberIds"] = sorted(participants)
            if not any(item["id"] == msg["id"] for item in store.get("messages", [])):
                store.setdefault("messages", []).append(msg)
            job.update(state="sent", sentAt=now.isoformat())
            deliveries.append((msg, participants)); changed = True
        for item in store.get("chatReminders", []):
            if item.get("state") != "pending" or d.parse_iso_datetime(item["dueAt"]) > now:
                continue
            actor = users.get(item["userId"])
            try:
                if not actor or actor.get("status") != "ativo" or d.team_id_for(actor) != team_id:
                    raise HTTPException(403, "Acesso revogado.")
                source = await authorized_message(actor, store, item["messageId"])
                if (source.get("metadata") or {}).get("deletedAt"):
                    raise HTTPException(404, "Mensagem apagada.")
                # Stable event identity makes retry after restart idempotent.
                await d.record_event(source="equipe", title="Lembrete da conversa", description=d.short_text(source.get("text", "")),
                    metadata={"userId": item["userId"], "action": "team_chat_reminder", "threadId": item["threadId"], "messageId": source["id"]}, event_id=item["id"])
                item.update(state="delivered", deliveredAt=now.isoformat()); reminders.append(item)
            except HTTPException:
                item.update(state="blocked", blockedAt=d.now_iso())
            changed = True
        if changed:
            # Pending/sent and message bytes share this one authoritative commit.
            await asyncio.to_thread(d.write_chat_store, team_id, store)
        pending = [item["dueAt"] for item in [*store.get("chatScheduled", []), *store.get("chatReminders", [])] if item.get("state") == "pending"]
    for message, participants in deliveries:
        await d.manager.send_to_users(team_id, participants, {"type": "TEAM_CHAT_MESSAGE", "message": message})
        await d.record_team_event(team_id, "Mensagem agendada enviada", d.short_text(message["text"]), {"messageId": message["id"], "threadId": message["threadId"], "action": "team_message_created"}, user_ids=participants-{message["senderId"]})
    for reminder in reminders:
        await d.manager.send_to_users(team_id, {reminder["userId"]}, {"type": "TEAM_REMINDER_DUE", "messageId": reminder["messageId"], "threadId": reminder["threadId"]})
    return min(pending) if pending else None


async def dispatch_due(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    d = domain(); processed = 0
    async with queue_lock:
        index = await asyncio.to_thread(read_index)
        due = [(key, group) for key, group in index.get("groups", {}).items() if d.parse_iso_datetime(group["dueAt"]) <= now][:20]
        if not due: return 0
        directory = await d.read_user_store()
        from app.modules.auth.router import can_participate_team_chat, effective_permissions
        users = {str(user["id"]): {**user, "teamChatEnabled": can_participate_team_chat(user, directory), "permissions": effective_permissions(user)} for user in directory.get("users", [])}
        for key, group in due:
            context = set_request_context("team-chat-queue", group["workspaceId"])
            try:
                next_due = await dispatch_group(group["teamId"], users, now)
                if next_due: index["groups"][key]["dueAt"] = next_due
                else: index["groups"].pop(key, None)
                processed += 1
            finally:
                reset_request_context(context)
        await asyncio.to_thread(write_index, index)
    return processed


async def worker() -> None:
    if not enabled(): return
    while True:
        try:
            await dispatch_due()
        except Exception:
            log.warning("Fila interna do chat indisponível; nova tentativa em 60 segundos.")
        _wake.clear()
        # A new item wakes the worker only after the minimum quiet interval.
        await asyncio.sleep(60)
        try: await asyncio.wait_for(_wake.wait(), timeout=60)
        except asyncio.TimeoutError: pass
