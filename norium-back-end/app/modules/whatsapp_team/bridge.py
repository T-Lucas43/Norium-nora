"""Metadata after confirmed human sends or verified incoming webhooks; no retry."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import logging
from fastapi import HTTPException
from app.core.identity import require_team_id
from app.core.request_context import current_request_id, reset_request_context, set_request_context
from app.core.tenant import read_account_db
from app.modules.chat.history import binding_signature
from . import access, repository, service

logger = logging.getLogger(__name__)
manual_actor: ContextVar[str] = ContextVar("whatsapp_team_manual_actor", default="")


async def outgoing(runtime, owner_user: dict, conversation_id: str) -> None:
    try:
        actor_id = manual_actor.get() or owner_user.get("id")
        directory = (await runtime.read_user_store()).get("users", [])
        actor = next((row for row in directory if row.get("id") == actor_id), None)
        if not actor or require_team_id(actor) != owner_user.get("id"):
            return
        try:
            grant = await access.resolve(runtime, actor)
        except HTTPException:
            return
        if (await asyncio.to_thread(repository.snapshot, grant.scope))["inbox"].get("enabled") is not True:
            return
        result = await asyncio.to_thread(service.record_outgoing, grant, conversation_id)
        if result is not None:
            from .notifications import changed
            await changed(actor, grant.scope.inbox_id, conversation_id)
    except Exception:
        # Sending was already confirmed. Metadata errors cannot replay it.
        logger.warning("Envio confirmado; atualização do atendimento pendente.")


async def incoming(runtime, owner_id: str, conversation_id: str, message_id: str, timestamp: int) -> None:
    try:
        directory = (await runtime.read_user_store()).get("users", [])
        owner = next((row for row in directory if row.get("id") == owner_id), None)
        if (not owner or owner.get("role") != "owner" or require_team_id(owner) != owner_id
                or owner.get("plan") not in {"equipe", "enterprise"} or not access.can_attend(owner)):
            return
        binding = runtime.wapi_owned_binding(owner_id)
        if binding is None or not binding.exists:
            return
        fingerprint = binding_signature(binding.instance_id, binding.created_at)
        scopes = await asyncio.to_thread(repository.enabled_scopes, owner_id, fingerprint)
        platform = await asyncio.to_thread(read_account_db, owner_id, "plataforma", {}) if any(row.workspace_id != "primary" for row in scopes) else {}
        active_workspaces = {"primary", *(str(row.get("id")) for row in platform.get("workspaces", []) if row.get("active", True))}
        roster = tuple(row for row in directory if row.get("id") and require_team_id(row) == owner_id and access.can_attend(row))
        for scope in scopes:
            if scope.workspace_id not in active_workspaces:
                continue
            tokens = set_request_context(current_request_id(), scope.workspace_id)
            try:
                latest = runtime.wapi_owned_binding(owner_id)
                if latest is None or latest.created_at != binding.created_at or latest.instance_id != binding.instance_id:
                    return
                from .presence import available_assignees
                metadata = await asyncio.to_thread(repository.snapshot, scope)
                online = ()
                if metadata["inbox"].get("autoDistribute") is True:
                    try:
                        online = await available_assignees(access.Access(owner, owner, scope, roster))
                    except Exception:
                        logger.warning("Presença indisponível; nova conversa ficará sem responsável.")
                result = await asyncio.to_thread(service.received, scope, conversation_id, message_id=message_id, timestamp=timestamp, online_assignees=online)
                if result is not None:
                    from .notifications import emit
                    value = await asyncio.to_thread(repository.snapshot, scope)
                    await emit(access.Access(owner, owner, scope, roster), value, conversation_id)
                    if result.get("assigneeUserId") and result["version"] == 1:
                        from .notifications import changed
                        await changed(owner, scope.inbox_id, conversation_id, recipients={result["assigneeUserId"]})
            finally:
                reset_request_context(tokens)
    except Exception:
        logger.warning("Mensagem recebida; atualização do atendimento pendente.")
