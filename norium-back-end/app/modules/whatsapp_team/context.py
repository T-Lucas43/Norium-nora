"""Resolve team resources without changing the personal storage tenant."""
from __future__ import annotations

import asyncio
import hashlib
from fastapi import HTTPException
from . import access, repository


def runtime():
    from app.modules.chat import router
    return router


async def authorized(user: dict, inbox_id: str, conversation_id: str | None = None):
    chat = runtime()
    grant = await access.resolve(chat, user, inbox_id)
    value = await asyncio.to_thread(repository.snapshot, grant.scope)
    access.assert_enabled(value)
    conversation = None
    if conversation_id is not None:
        access.assert_conversation(grant, value, conversation_id)
        database = await chat.load_conversations(grant.scope.owner_id)
        conversation = database.get(conversation_id)
        if conversation is None:
            catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
            known = any(isinstance(row, dict) and chat._contact_primary_id(row) == conversation_id for row in catalog.get("chats", []))
            if not known:
                raise HTTPException(404, "Conversa indisponível.")
        # A binding may have changed while the document was being read.
        grant = await access.resolve(chat, user, inbox_id)
        value = await asyncio.to_thread(repository.snapshot, grant.scope)
        access.assert_conversation(grant, value, conversation_id)
    return grant, value, conversation


def resource_url(inbox_id: str, conversation_id: str, suffix: str) -> str:
    from urllib.parse import quote
    return f"/api/chat/caixas/{inbox_id}/conversas/{quote(conversation_id, safe='')}/{suffix}"


def conversation_ref(inbox_id: str, conversation_id: str) -> str:
    return hashlib.sha256(f"{inbox_id}:{conversation_id}".encode()).hexdigest()


def message_projection(message: dict, inbox_id: str, conversation_id: str) -> dict:
    from urllib.parse import quote
    result = {key: value for key, value in message.items() if key not in {"midiaMeta", "mediaMeta"}}
    identifier = quote(str(message.get("id") or ""), safe="")
    if message.get("arquivoUrl") or message.get("tipo") in {"midia", "audio", "documento", "sticker"}:
        result["arquivoUrl"] = resource_url(inbox_id, conversation_id, f"mensagens/{identifier}/midia")
    if message.get("miniaturaUrl"):
        result["miniaturaUrl"] = resource_url(inbox_id, conversation_id, f"mensagens/{identifier}/miniatura")
    return result


async def message(user: dict, inbox_id: str, conversation_id: str, message_id: str):
    grant, value, conversation = await authorized(user, inbox_id, conversation_id)
    row = next((row for row in (conversation or {}).get("mensagens", []) if row.get("id") == message_id), None)
    if row is None:
        from app.modules.chat.private_history import reference
        found = await reference(runtime(), grant.scope.owner_id, message_id, conversation_id)
        row = found[1] if found else None
    if row is None:
        raise HTTPException(404, "Mensagem indisponível.")
    await authorized(user, inbox_id, conversation_id)
    return grant, value, row
