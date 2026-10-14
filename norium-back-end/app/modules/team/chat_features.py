"""Additive collaboration features; the existing team transport owns fanout."""
from __future__ import annotations

import asyncio
import unicodedata
from importlib import import_module
from typing import Any
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from app.shared.schemas import StrictModel
from app.routers.auth_router import current_user
from app.modules.team.chat_resources import message_refs, resolve_card

router = APIRouter()


def domain():
    return import_module("app.modules.team.router")


async def authorized_message(user: dict, store: dict, message_id: str) -> dict:
    d = domain()
    d.require_team_chat(user)
    allowed = {item["id"] for item in await d.accessible_threads(user, store)}
    message = next((item for item in store.get("messages", []) if item.get("id") == message_id), None)
    if not message or message.get("threadId") not in allowed or not d.message_visible(message, str(user["id"])):
        raise HTTPException(404, "Mensagem não encontrada nesta conversa.")
    return message


class MessageEdit(StrictModel):
    text: str = Field(min_length=1, max_length=2000)


async def mutate_message(message_id: str, user: dict, text: str | None) -> dict:
    d = domain()
    d.require_team_chat(user)
    team_id = d.team_id_for(user)
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        message = await authorized_message(user, store, message_id)
        if message.get("senderId") != user["id"] or (message.get("metadata") or {}).get("action"):
            raise HTTPException(403, "Você só pode editar ou apagar suas mensagens comuns.")
        metadata = message.setdefault("metadata", {})
        if metadata.get("deletedAt"):
            raise HTTPException(409, "Esta mensagem já foi apagada.")
        if text is None:
            message["text"] = ""
            message["attachments"] = []
            message["resourceRefs"] = []
            metadata.pop("poll", None)
            metadata["deletedAt"] = d.now_iso()
        else:
            if not text.strip():
                raise HTTPException(400, "Digite o texto da mensagem.")
            message["text"] = text.strip()
            if metadata.get("poll"):
                if len(text.strip()) > 200: raise HTTPException(400, "A pergunta da enquete deve ter até 200 caracteres.")
                metadata["poll"]["question"] = text.strip()
            metadata["editedAt"] = d.now_iso()
        recipients = await d.message_participant_ids(message, user, store)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    await d.manager.send_to_users(team_id, recipients, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    return {"message": message}


@router.patch("/messages/{message_id}")
async def edit_message(message_id: str, payload: MessageEdit, user: dict[str, Any] = Depends(current_user)):
    return await mutate_message(message_id, user, payload.text)


@router.delete("/messages/{message_id}")
async def delete_message(message_id: str, user: dict[str, Any] = Depends(current_user)):
    return await mutate_message(message_id, user, None)


def message_page(messages: list[dict], limit: int | None, before: str | None) -> dict:
    count = 300 if limit is None else limit
    if not 1 <= count <= 300 or (limit is not None and count > 100):
        raise HTTPException(400, "Carregue de 1 a 100 mensagens por página.")
    end = len(messages)
    if before:
        end = next((i for i, message in enumerate(messages) if message.get("id") == before), -1)
        if end < 0:
            raise HTTPException(404, "Página da conversa não encontrada.")
    start = max(0, end-count)
    page = messages[start:end]
    return {"messages": page, "hasMore": start > 0, "nextBefore": page[0]["id"] if page and start else None}


async def readable_messages(user: dict, store: dict) -> list[dict]:
    d = domain()
    d.require_team_chat(user)
    allowed = {item["id"] for item in await d.accessible_threads(user, store)}
    return [item for item in d.visible_messages(store.get("messages", []), str(user["id"])) if item.get("threadId") in allowed]


@router.get("/messages/{message_id}/context")
async def message_context(message_id: str, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    message = await authorized_message(user, store, message_id)
    items = [item for item in await readable_messages(user, store) if item.get("threadId") == message["threadId"]]
    index = next(i for i, item in enumerate(items) if item["id"] == message_id)
    return {"message": message, "messages": items[max(0, index-25):index+26], "hasMore": index > 25}


def normalized(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", value.casefold()) if not unicodedata.combining(c))


@router.get("/search")
async def search_messages(q: str = "", threadId: str | None = None, authorId: str | None = None,
                          withFile: bool = False, since: str | None = None, until: str | None = None,
                          offset: int = 0, user: dict[str, Any] = Depends(current_user)):
    if len(q) > 200 or not 0 <= offset <= 100000:
        raise HTTPException(400, "Busca inválida.")
    d = domain()
    start, end = d.parse_iso_datetime(since), d.parse_iso_datetime(until)
    if (since and not start) or (until and not end):
        raise HTTPException(400, "Informe datas válidas.")
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    items = []
    for item in reversed(await readable_messages(user, store)):
        when = d.parse_iso_datetime(item.get("createdAt"))
        if (item.get("metadata") or {}).get("deletedAt") or (threadId and item.get("threadId") != threadId):
            continue
        if authorId and item.get("senderId") != authorId or withFile and not item.get("attachments"):
            continue
        if start and (not when or when < start) or end and (not when or when > end):
            continue
        if normalized(q.strip()) not in normalized(str(item.get("text") or "")):
            continue
        items.append(item)
        if len(items) > offset+50:
            break
    return {"messages": items[offset:offset+50], "hasMore": len(items) > offset+50, "nextOffset": offset+50}


class MessagePin(StrictModel):
    pinned: bool


@router.patch("/messages/{message_id}/pin")
async def pin_message(message_id: str, payload: MessagePin, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    team_id = d.team_id_for(user)
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        message = await authorized_message(user, store, message_id)
        if (message.get("metadata") or {}).get("deletedAt"):
            raise HTTPException(409, "Esta mensagem foi apagada.")
        metadata = message.setdefault("metadata", {})
        metadata["pinnedAt"] = d.now_iso() if payload.pinned else None
        metadata["pinnedBy"] = user["id"] if payload.pinned else None
        recipients = await d.message_participant_ids(message, user, store)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    await d.manager.send_to_users(team_id, recipients, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    return {"message": message}


@router.get("/pinned-messages")
async def pinned_messages(threadId: str, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    return {"messages": [item for item in await readable_messages(user, store) if item.get("threadId") == threadId and (item.get("metadata") or {}).get("pinnedAt") and not (item.get("metadata") or {}).get("deletedAt")][-100:]}


def reply_participants(root: dict, replies: list[dict], mentions: set[str], user_id: str) -> set[str]:
    earlier_mentions = {str(identifier) for item in replies for identifier in (item.get("metadata") or {}).get("mentionedUserIds", [])}
    return ({str(root.get("senderId")), user_id} | {str(item.get("senderId")) for item in replies} | mentions | earlier_mentions) - {"", "None", "nora"}


@router.get("/messages/{message_id}/replies")
async def replies(message_id: str, before: str | None = None, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    root = await authorized_message(user, store, message_id)
    items = [item for item in await readable_messages(user, store) if item.get("replyThreadId") == root["id"]]
    return {"root": root, **message_page(items, 50, before)}


@router.get("/reply-threads")
async def reply_threads(threadId: str, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    items = await readable_messages(user, store)
    roots = {item["replyThreadId"] for item in items if item.get("replyThreadId") and (item.get("senderId") == user["id"] or user["id"] in (item.get("metadata") or {}).get("mentionedUserIds", []))}
    roots |= {item["id"] for item in items if item.get("senderId") == user["id"] and (item.get("metadata") or {}).get("replyCount")}
    by_root = {}
    for item in items:
        if item.get("replyThreadId"):
            by_root.setdefault(item["replyThreadId"], []).append(item)
    result = []
    for item in items:
        if item.get("threadId") != threadId or item["id"] not in roots: continue
        responses = by_root.get(item["id"], [])
        unread = sum(response.get("senderId") != user["id"] and user["id"] not in d.message_read_by(response) for response in responses)
        result.append({**item, "metadata": {**(item.get("metadata") or {}), "replyUnreadCount": unread}})
    result.sort(key=lambda item: (item.get("metadata") or {}).get("lastReplyAt") or item.get("createdAt") or "")
    return {"messages": result[-100:]}


class CardsRequest(StrictModel):
    messageIds: list[str] = Field(default_factory=list, max_length=100)


@router.post("/resource-cards")
async def resource_cards(payload: CardsRequest, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    d.require_team_chat(user)
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    ids = set(payload.messageIds)
    cards, cache = {}, {}
    for message in await readable_messages(user, store):
        if message["id"] not in ids or (message.get("metadata") or {}).get("deletedAt"):
            continue
        result = []
        for ref in message_refs(message):
            key = (ref.get("type"), ref.get("id"))
            if key not in cache:
                cache[key] = await resolve_card(ref, user)
            result.append(cache[key])
        if result:
            cards[message["id"]] = result
    return {"cards": cards}


class MessageTask(StrictModel):
    title: str = Field(min_length=1, max_length=160)
    projectId: str = Field(min_length=1, max_length=150)
    assigneeId: str | None = Field(default=None, max_length=150)
    dueDate: str | None = Field(default=None, max_length=40)


@router.post("/messages/{message_id}/task")
async def message_task(message_id: str, payload: MessageTask, user: dict[str, Any] = Depends(current_user)):
    from app.modules.auth.router import assert_route_permissions
    from app.modules.tasks.router import criar_tarefa, CriarTarefaPayload
    assert_route_permissions(user, "/api/tarefas")
    d = domain()
    team_id = d.team_id_for(user)
    store = await asyncio.to_thread(d.read_chat_store, team_id)
    source = await authorized_message(user, store, message_id)
    if (source.get("metadata") or {}).get("deletedAt"):
        raise HTTPException(409, "Esta mensagem foi apagada.")
    from urllib.parse import urlencode
    result = await criar_tarefa(CriarTarefaPayload(**payload.model_dump(), description=
        f"{source.get('text', '')}\n\nOrigem: {source.get('senderName', 'Membro')}\n/app/chat-equipe?{urlencode({'teamThread': source['threadId'], 'teamMessage': source['id']})}"), user)
    task = result["task"]
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        source = await authorized_message(user, store, message_id)
        refs = source.setdefault("resourceRefs", [])
        refs.append({"type": "task", "id": task["id"]})
        source.setdefault("metadata", {})["chatTaskIds"] = [ref["id"] for ref in refs if ref["type"] == "task"]
        recipients = await d.message_participant_ids(source, user, store)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    await d.manager.send_to_users(team_id, recipients, {"type": "TEAM_CHAT_MESSAGE", "message": source})
    return {"task": task, "message": source}


@router.get("/conversation-tasks")
async def conversation_tasks(threadId: str, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    tasks, seen = [], set()
    for message in await readable_messages(user, store):
        if message.get("threadId") != threadId:
            continue
        for identifier in (message.get("metadata") or {}).get("chatTaskIds", []):
            if identifier in seen:
                continue
            seen.add(identifier)
            tasks.append({**await resolve_card({"type": "task", "id": identifier}, user), "messageId": message["id"]})
    return {"tasks": tasks[-100:]}


@router.get("/task-options")
async def task_options(user: dict[str, Any] = Depends(current_user)):
    from app.modules.auth.router import assert_route_permissions
    from app.modules.tasks.router import accessible_team_projects
    domain().require_team_chat(user)
    assert_route_permissions(user, "/api/tarefas")
    return {"projects": [{"id": item["id"], "name": item.get("name") or "Projeto"} for item in await accessible_team_projects(user)]}


class PollCreate(StrictModel):
    scope: Literal["team", "direct", "subteam"] = "team"
    recipientId: str | None = Field(default=None, max_length=150)
    subteamId: str | None = Field(default=None, max_length=150)
    question: str = Field(min_length=2, max_length=200)
    options: list[str] = Field(min_length=2, max_length=10)
    multiple: bool = False


@router.post("/polls")
async def create_poll(payload: PollCreate, user: dict[str, Any] = Depends(current_user)):
    import uuid
    options = [text.strip() for text in payload.options]
    if any(not text or len(text) > 120 for text in options) or len(set(normalized(text) for text in options)) != len(options):
        raise HTTPException(400, "Informe opções distintas de até 120 caracteres.")
    poll = {"question": payload.question.strip(), "multiple": payload.multiple,
            "options": [{"id": uuid.uuid4().hex, "text": text, "userIds": []} for text in options]}
    return await domain().persist_message(scope=payload.scope, recipient_id=payload.recipientId, subteam_id=payload.subteamId,
                text=payload.question, attachment_payloads=[], user=user, poll_data=poll)


class PollVote(StrictModel):
    optionIds: list[str] = Field(default_factory=list, max_length=10)


@router.post("/messages/{message_id}/vote")
async def vote_poll(message_id: str, payload: PollVote, user: dict[str, Any] = Depends(current_user)):
    d = domain(); team_id = d.team_id_for(user)
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        message = await authorized_message(user, store, message_id)
        poll = (message.get("metadata") or {}).get("poll")
        if not isinstance(poll, dict) or (message.get("metadata") or {}).get("deletedAt"):
            raise HTTPException(404, "Enquete indisponível.")
        choices = set(payload.optionIds)
        if choices - {option["id"] for option in poll["options"]} or not poll.get("multiple") and len(choices) > 1:
            raise HTTPException(400, "Voto inválido.")
        for option in poll["options"]:
            votes = set(option.get("userIds", [])) - {str(user["id"])}
            if option["id"] in choices: votes.add(str(user["id"]))
            option["userIds"] = sorted(votes)
        recipients = await d.message_participant_ids(message, user, store)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    await d.manager.send_to_users(team_id, recipients, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    return {"message": message}


class ForwardMessage(StrictModel):
    threadId: str = Field(min_length=1, max_length=250)


@router.post("/messages/{message_id}/forward")
async def forward_message(message_id: str, payload: ForwardMessage, user: dict[str, Any] = Depends(current_user)):
    d = domain()
    store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    source = await authorized_message(user, store, message_id)
    target = next((item for item in await d.accessible_threads(user, store) if item["id"] == payload.threadId), None)
    if not target or (source.get("metadata") or {}).get("deletedAt"):
        raise HTTPException(404, "Conversa ou mensagem indisponível.")
    return await d.persist_message(scope=target["scope"], recipient_id=target.get("recipientId"), subteam_id=target.get("subteamId"),
                text=source.get("text") or "Arquivo encaminhado", attachment_payloads=[], user=user, forwarded_message_id=source["id"])


@router.get("/shortcuts")
async def shortcuts(user: dict[str, Any] = Depends(current_user)):
    from app.modules.message_templates.router import all_templates
    domain().require_team_chat(user)
    items = await asyncio.to_thread(all_templates, user)
    return {"templates": [{"id": item["id"], "name": item["name"], "shortcut": item.get("shortcut") or item["id"].removeprefix("builtin_").removeprefix("template_").replace("_", "-"), "body": item["body"]} for item in items if item.get("channel") in {"team", "whatsapp"}]}


@router.get("/conversation-attachments")
async def conversation_attachments(threadId: str, q: str = "", photos: bool = False, offset: int = 0, user: dict = Depends(current_user)):
    if len(q) > 150 or not 0 <= offset <= 100000: raise HTTPException(400, "Filtro de arquivos inválido.")
    d = domain(); store = await asyncio.to_thread(d.read_chat_store, d.team_id_for(user))
    attachments, seen = [], set()
    for message in reversed(await readable_messages(user, store)):
        if message.get("threadId") != threadId or (message.get("metadata") or {}).get("deletedAt"): continue
        for attachment in message.get("attachments", []):
            if attachment.get("id") in seen or photos and not attachment.get("mimeType", "").startswith("image/"): continue
            if normalized(q) not in normalized(str(attachment.get("name") or "")): continue
            seen.add(attachment.get("id"))
            attachments.append({key: attachment.get(key) for key in ("id", "name", "mimeType", "size", "url", "expiresAt")})
    return {"attachments": attachments[offset:offset+30], "total": len(attachments), "hasMore": len(attachments) > offset+30}
