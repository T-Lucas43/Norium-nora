"""Use the existing team presence, projected through WhatsApp conversation ACL."""
from __future__ import annotations

import asyncio
from fastapi import HTTPException
from app.core.request_context import current_workspace_id
from app.modules.auth.router import effective_permissions
from . import access, context


async def available_assignees(grant):
    from app.modules.team import router as team
    from app.modules.team.chat_presence import active_preferences, live_contexts
    online = set(team.manager.online_users(grant.scope.tenant_id))
    store = await asyncio.to_thread(team.read_chat_store, grant.scope.tenant_id)
    active = live_contexts(grant.scope.tenant_id, grant.scope.workspace_id)
    return tuple(member["id"] for member in grant.roster if member["id"] in online
                 and active.get(member["id"], {}).get("state", "away") in {"online", "service"}
                 and not active_preferences(store, member["id"]).get("focus"))


async def roster(grant):
    from app.modules.team import router as team
    from app.modules.team.chat_presence import active_preferences, live_contexts
    store = await asyncio.to_thread(team.read_chat_store, grant.scope.tenant_id)
    online = set(team.manager.online_users(grant.scope.tenant_id))
    contexts = live_contexts(grant.scope.tenant_id, current_workspace_id())
    result = []
    for member in grant.roster:
        profile = await asyncio.to_thread(team.read_profile_db, member["id"], {})
        prefs = active_preferences(store, member["id"])
        state = contexts.get(member["id"], {}).get("state", "online")
        result.append({**access.public_member({**member, "fotoUrl": profile.get("fotoUrl") or member.get("fotoUrl")}),
                       "online": member["id"] in online and state not in {"away", "offline"} and not prefs.get("focus"),
                       "canManage": member["id"] == grant.scope.owner_id or bool(effective_permissions(member).get("whatsapp.ver_todas"))})
    return result


async def title(user: dict, resource_id: str):
    parts = resource_id.split(":")
    if len(parts) != 2 or any(len(part) != 64 or any(char not in "0123456789abcdef" for char in part) for part in parts):
        return None
    inbox_id, reference = parts
    try:
        grant, _, _ = await context.authorized(user, inbox_id)
        chat = context.runtime()
        database = await chat.load_conversations(grant.scope.owner_id)
        catalog = await chat.load_whatsapp_catalog_cache(grant.scope.owner_id)
        from app.modules.chat.conversation_projection import list_page
        for conversation in list_page(chat, database, catalog, offset=0, limit=50000, search="")["items"]:
            if context.conversation_ref(inbox_id, conversation["id"]) != reference:
                continue
            await context.authorized(user, inbox_id, conversation["id"])
            return "Atendendo " + str(conversation.get("contato") or "contato")[:120] + " no WhatsApp"
    except HTTPException:
        return None
    return None


async def viewers(grant, conversation_id: str, value: dict):
    from app.modules.team import router as team
    from app.modules.team.chat_presence import active_preferences, live_contexts
    online = set(team.manager.online_users(grant.scope.tenant_id))
    store = await asyncio.to_thread(team.read_chat_store, grant.scope.tenant_id)
    resource = {"type": "whatsapp", "id": grant.scope.inbox_id + ":" + context.conversation_ref(grant.scope.inbox_id, conversation_id)}
    active = live_contexts(grant.scope.tenant_id, grant.scope.workspace_id)
    result = []
    for member in grant.roster:
        try:
            access.assert_conversation(access.Access(member, grant.owner, grant.scope, grant.roster), value, conversation_id)
        except HTTPException:
            continue
        if (member["id"] != grant.actor_id and member["id"] in online
                and active.get(member["id"], {}).get("resource") == resource
                and active_preferences(store, member["id"]).get("shareContext", True)
                and not active_preferences(store, member["id"]).get("focus")):
            result.append(member["id"])
    return result
