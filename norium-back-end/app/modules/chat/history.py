"""Read older Evolution pages without replacing messages delivered by webhooks."""
from __future__ import annotations

from typing import Any
import hashlib

from app.services.wapi_client import WapiError


def binding_signature(instance_id: str, created_at: Any) -> str:
    return hashlib.sha256(f"{instance_id}:{created_at}".encode()).hexdigest()


async def backfill_older(runtime: Any, owner_id: str, conversation_id: str,
                         *, before: int, before_id: str | None, limit: int) -> dict:
    async with runtime.whatsapp_history_sync_lock(owner_id, conversation_id):
        database = await runtime.load_conversations(owner_id)
        conversation = database.get(conversation_id)
        page = runtime.whatsapp_history_page(conversation, before=before, before_id=before_id, limit=limit)
        metadata = (conversation or {}).get("metadados") or {}
        boundary = (before, before_id) if before_id is not None else (before, "")
        local_count = sum(1 for message in (conversation or {}).get("mensagens", [])
                          if isinstance(message, dict)
                          and (int(message.get("timestamp") or 0), str(message.get("id") or "")) < boundary)
        if local_count > limit:
            return page
        credentials = runtime.wapi_creds(owner_id)
        binding = runtime.wapi_owned_binding(owner_id)
        if not credentials or binding is None or not metadata.get("historicoTemMais"):
            return page
        if metadata.get("historicoVinculo") != binding_signature(credentials[0], binding.created_at):
            return {**page, "hasMore": local_count > limit}
        if runtime.whatsapp_history_error_backoff_active(owner_id, conversation_id, credentials[0]):
            return {**page, "hasMore": True}
        created_at = binding.created_at
        next_page = metadata.get("historicoProximaPagina", 2)
        if type(next_page) is not int or not 2 <= next_page <= 10000:
            raise WapiError("Cursor do histórico indisponível. Atualize a conversa.", code="invalid_response")
        try:
            incoming = await runtime.wapi_client.fetch_history_page(credentials[0], credentials[1], conversation_id,
                                                                    page=next_page, limit=100, until=metadata.get("historicoAte"))
        except WapiError:
            runtime.remember_whatsapp_history_error(owner_id, conversation_id, credentials[0])
            raise
        async with runtime.whatsapp_conversation_mutation_lock(owner_id):
            latest_db = await runtime.load_conversations(owner_id)
            latest_binding = runtime.wapi_owned_binding(owner_id)
            latest = latest_db.get(conversation_id)
            if (runtime.wapi_creds(owner_id) != credentials or latest_binding is None
                    or latest_binding.created_at != created_at or latest is None):
                return runtime.whatsapp_history_page(latest, before=before, before_id=before_id, limit=limit)
            runtime.sync_catalog_messages(latest, runtime.whatsapp_history_chat_record(incoming, conversation_id))
            latest_meta = latest.setdefault("metadados", {})
            latest_meta["historicoTemMais"] = bool(incoming.get("hasMore"))
            latest_meta["historicoProximaPagina"] = next_page + 1
            latest_db[conversation_id] = runtime.normalize_conversation(conversation_id, latest)
            await runtime.save_conversations(latest_db, owner_id)
            page = runtime.whatsapp_history_page(latest_db[conversation_id], before=before, before_id=before_id, limit=limit)
            page["hasMore"] = page["hasMore"] or latest_meta["historicoTemMais"]
            return page
