"""Use the existing Evolution database for bounded history and old references."""
from __future__ import annotations

import asyncio
from fastapi import HTTPException
from app.services import evolution_data, evolution_history
from app.services.evolution_client import _message_record
from . import message_state


def _aliases(conversation_id: str, conversation: dict | None) -> list[str]:
    from app.services.whatsapp_identity import record_aliases
    values = record_aliases({**(conversation or {}), "id": conversation_id})
    return [conversation_id, *sorted(values - {conversation_id})][:32]


def _page_aliases(owner, instance, aliases, *, before, before_id, limit):
    messages, more = {}, False
    for alias in aliases:
        result = evolution_history.page(owner, instance, alias, before=before, before_id=before_id, limit=limit)
        more = more or result["hasMore"]
        for row in result["records"]:
            messages[str((row.get("key") or {}).get("id"))] = row
    rows = sorted(messages.values(), key=lambda row: (int(row.get("messageTimestamp") or 0), str((row.get("key") or {}).get("id"))), reverse=True)
    return {"records": rows[:limit], "hasMore": more or len(rows) > limit}


def _binding(runtime, owner: str):
    if not getattr(runtime, "is_evolution", lambda: False)() or not evolution_data.database_configured():
        return None
    binding = runtime.wapi_owned_binding(owner)
    return binding if binding is not None and binding.exists else None


def _same_binding(runtime, owner: str, expected) -> None:
    latest = runtime.wapi_owned_binding(owner)
    if latest is None or not latest.exists or latest.instance_id != expected.instance_id or latest.created_at != expected.created_at:
        raise HTTPException(404, "O vínculo do WhatsApp mudou. Atualize a conversa.")


def _conversation(runtime, conversation_id: str, records: list[dict]) -> dict:
    row = runtime.new_conversation(conversation_id, channel="whatsapp", is_group=runtime.is_group_chat(conversation_id))
    cleaned = [{**record, "messageType": "conversation", "message": {"conversation": "[Mensagem apagada]"}}
               if (record.get("key") or {}).get("deleted") or record.get("status") == "DELETED" else record for record in records]
    runtime.sync_catalog_messages(row, {"id": conversation_id, "messages": [_message_record(record) for record in cleaned]})
    return row


async def page(runtime, owner: str, conversation_id: str, conversation: dict | None, *, before: int, before_id: str | None, limit: int) -> dict | None:
    binding = _binding(runtime, owner)
    if binding is None:
        return None
    try:
        result = await asyncio.to_thread(_page_aliases, owner, binding.instance_id, _aliases(conversation_id, conversation),
                                        before=before, before_id=before_id, limit=limit)
    except RuntimeError:
        raise HTTPException(503, "O histórico está temporariamente indisponível. Tente novamente.") from None
    _same_binding(runtime, owner, binding)
    normalized = _conversation(runtime, conversation_id, result["records"])
    merged = {str(message.get("id")): message for message in normalized.get("mensagens", [])}
    deleted = {str((record.get("key") or {}).get("id")) for record in result["records"]
               if (record.get("key") or {}).get("deleted") or record.get("status") == "DELETED"}
    merged.update({str(message.get("id")): message for message in (conversation or {}).get("mensagens", []) if str(message.get("id")) not in deleted})
    normalized["mensagens"] = list(merged.values())
    response = runtime.whatsapp_history_page(normalized, before=before, before_id=before_id, limit=limit)
    response["hasMore"] = response["hasMore"] or result["hasMore"]
    state = await asyncio.to_thread(message_state.snapshot, runtime, owner)
    _same_binding(runtime, owner, binding)
    response["items"] = message_state.apply(state, conversation_id, response["items"], _aliases(conversation_id, conversation))
    return response


async def reference(runtime, owner: str, message_id: str, conversation_id: str | None = None) -> tuple[str, dict] | None:
    binding = _binding(runtime, owner)
    if binding is None:
        return None
    known = (await runtime.load_conversations(owner)).get(conversation_id) if conversation_id else None
    aliases = _aliases(conversation_id, known) if conversation_id else [None]
    try:
        raw = None
        for alias in aliases:
            raw = await asyncio.to_thread(evolution_history.reference, owner, binding.instance_id, message_id, alias)
            if raw is not None:
                break
    except RuntimeError:
        raise HTTPException(503, "A mensagem antiga está temporariamente indisponível. Tente novamente.") from None
    _same_binding(runtime, owner, binding)
    if raw is None:
        return None
    if (raw.get("key") or {}).get("deleted") or raw.get("status") == "DELETED":
        return None
    key = raw.get("key") or {}
    cid = conversation_id or key.get("remoteJid") or key.get("remoteJidAlt")
    if not isinstance(cid, str) or not cid or (conversation_id and not set(aliases).intersection({key.get("remoteJid"), key.get("remoteJidAlt")})):
        return None
    if not conversation_id:
        known = (await runtime.load_conversations(owner)).get(cid)
        aliases = _aliases(cid, known)
    normalized = _conversation(runtime, cid, [raw])
    message = next((row for row in normalized.get("mensagens", []) if row.get("id") == message_id), None)
    state = await asyncio.to_thread(message_state.snapshot, runtime, owner)
    _same_binding(runtime, owner, binding)
    visible = message_state.apply(state, cid, [message], aliases) if message is not None else []
    return (cid, visible[0]) if visible else None
