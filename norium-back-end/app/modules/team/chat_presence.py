"""Shared, bounded presence. Context labels are projected for each reader."""
from __future__ import annotations
import asyncio
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Literal
from fastapi import Depends, HTTPException
from pydantic import Field
from app.shared.schemas import StrictModel
from app.core.request_context import current_workspace_id
from app.routers.auth_router import current_user
from app.modules.team.chat_features import router, domain
from app.modules.team.chat_resources import resolve_card

_contexts: dict[tuple[str, str, str, str], dict] = {}
_history: dict[tuple[str, str, str], list[dict]] = {}
MAX_CONTEXTS = 2000
TTL_SECONDS = 180
STATES = {"online": "Disponível", "away": "Ausente", "call": "Em chamada", "meeting": "Em reunião", "service": "Em atendimento", "focus": "Em foco", "offline": "Offline"}


class ContextRef(StrictModel):
    type: Literal["task", "client", "project", "conversation", "meeting", "whatsapp"]
    id: str = Field(min_length=1, max_length=250)


class ContextUpdate(StrictModel):
    clientId: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    state: Literal["online", "away", "call", "meeting", "service"] = "online"
    resource: ContextRef | None = None


class PresencePreferences(StrictModel):
    emoji: str = Field(default="", max_length=12)
    text: str = Field(default="", max_length=80)
    expiresAt: str | None = Field(default=None, max_length=50)
    focus: bool = False
    allowUrgentMentions: bool = True
    shareContext: bool = True


class ChannelNotifications(StrictModel):
    mode: Literal["all", "mentions", "none"] = "all"
    mutedUntil: str | None = Field(default=None, max_length=50)


async def context_title(resource: dict | None, user: dict, store: dict) -> str | None:
    if not resource: return None
    if resource["type"] == "whatsapp":
        from app.modules.whatsapp_team.presence import title
        return await title(user, resource["id"])
    d = domain()
    if resource["type"] == "conversation":
        if resource["id"] == "team": return "Time todo"
        if resource["id"].startswith("subteam:"):
            try:
                subteam = d.subteam_or_404(store, resource["id"].removeprefix("subteam:"))
                d.require_subteam_member(subteam, str(user["id"]))
                return subteam.get("name")
            except HTTPException: return None
        if resource["id"].startswith("direct:"):
            return "Conversa privada" if str(user["id"]) in resource["id"].split(":")[1:] else None
        thread = next((item for item in await d.accessible_threads(user, store) if item["id"] == resource["id"]), None)
        if not thread: return None
        if thread["scope"] == "team": return "Time todo"
        if thread["scope"] == "subteam": return d.subteam_or_404(store, thread["subteamId"]).get("name")
        return "Conversa privada"
    if resource["type"] == "project":
        from app.modules.auth.router import assert_route_permissions
        from app.modules.tasks.router import accessible_team_projects
        from app.services.task_activity import project_visible
        try: assert_route_permissions(user, "/api/tarefas")
        except HTTPException: return None
        project = next((item for item in await accessible_team_projects(user) if item["id"] == resource["id"]), None)
        if not project or not project_visible({"ownerId": project.get("ownerUserId") or user["id"], "projectId": project["id"]}, str(user["id"])): return None
        return str(project.get("name") or "Projeto")
    card = await resolve_card(resource, user)
    return None if card.get("restricted") else card["title"]


def active_preferences(store: dict, user_id: str, now: datetime | None = None) -> dict:
    prefs = dict(store.get("chatPresence", {}).get(user_id, {}))
    expiration = domain().parse_iso_datetime(prefs.get("expiresAt"))
    if expiration and expiration <= (now or datetime.now(timezone.utc)):
        prefs.update(text="", emoji="", focus=False)
    return prefs


def live_contexts(team_id: str, workspace: str, now: float | None = None) -> dict[str, dict]:
    timestamp = time.monotonic() if now is None else now
    result = {}
    for key, item in list(_contexts.items()):
        if timestamp - item["updatedAt"] >= TTL_SECONDS:
            _contexts.pop(key, None); continue
        if key[:2] != (team_id, workspace): continue
        actor = key[2]
        if actor not in result or item["updatedAt"] > result[actor]["updatedAt"]:
            result[actor] = item
    return result


async def presence_view(user: dict, store: dict | None = None, members: list[dict] | None = None) -> dict:
    d = domain(); d.require_team_chat(user)
    team_id = d.team_id_for(user)
    store = store if store is not None else await asyncio.to_thread(d.read_chat_store, team_id)
    contexts = live_contexts(team_id, current_workspace_id())
    online = set(d.manager.online_users(team_id))
    try: timezone_view = ZoneInfo(str(user.get("timezone") or "America/Sao_Paulo"))
    except ZoneInfoNotFoundError: timezone_view = ZoneInfo("America/Sao_Paulo")
    result = {}
    for member in members if members is not None else await d.visible_team_members(user):
        identifier = str(member["id"])
        if member.get("status") != "ativo": continue
        prefs = active_preferences(store, identifier)
        context = contexts.get(identifier)
        state = "offline" if identifier not in online else context.get("state", "online") if context else "away"
        # The existing call authority supplies real membership; a presence claim
        # neither grants call access nor changes the transport.
        if identifier in online and any(identifier in call.get("joinedClients", {}) for call in store.get("activeCalls", [])):
            state = "call"
        if prefs.get("focus") and identifier in online: state = "focus"
        sharing = prefs.get("shareContext", True) and not prefs.get("focus")
        title = await context_title(context.get("resource"), user, store) if context and sharing and state != "offline" else None
        history = []
        if sharing:
            for item in _history.get((team_id, current_workspace_id(), identifier), [])[-6:]:
                when = d.parse_iso_datetime(item.get("timestamp"))
                if not when or when.astimezone(timezone_view).date() != datetime.now(timezone_view).date(): continue
                label = await context_title(item.get("resource"), user, store)
                history.append({"state": item["state"], "label": STATES[item["state"]], "context": label, "timestamp": item["timestamp"]})
        result[identifier] = {"state": state, "label": STATES[state], "context": title, "emoji": prefs.get("emoji", ""), "text": prefs.get("text", ""), "updatedAt": context.get("timestamp") if context else None, "timeline": history}
    return {"states": result, "preferences": active_preferences(store, str(user["id"]))}


async def publish_presence(user: dict, store: dict) -> None:
    d = domain(); team_id = d.team_id_for(user)
    members = await d.visible_team_members(user)
    for member in members:
        if member.get("status") != "ativo" or member["id"] not in d.manager.online_users(team_id): continue
        # Project separately. No private resource label enters a shared event.
        view = await presence_view(member, store, [user])
        await d.manager.send_to_users(team_id, {member["id"]}, {"type": "TEAM_PRESENCE_CONTEXT", "partial": True, **view})


@router.get("/presence/context")
async def get_presence(user: dict = Depends(current_user)):
    return await presence_view(user)


@router.put("/presence/context")
async def put_context(payload: ContextUpdate, user: dict = Depends(current_user)):
    d = domain(); d.require_team_chat(user)
    team_id = d.team_id_for(user)
    store = await asyncio.to_thread(d.read_chat_store, team_id)
    resource = payload.resource.model_dump() if payload.resource else None
    if resource and resource["type"] == "conversation" and resource["id"] not in {item["id"] for item in await d.accessible_threads(user, store)}:
        raise HTTPException(404, "Contexto não disponível para sua conta.")
    if resource and not await context_title(resource, user, store):
        raise HTTPException(404, "Contexto não disponível para sua conta.")
    prefs = active_preferences(store, str(user["id"]))
    if not prefs.get("shareContext", True) or prefs.get("focus"): resource = None
    key = (team_id, current_workspace_id(), str(user["id"]), payload.clientId)
    live_contexts(team_id, current_workspace_id())
    if key not in _contexts and len(_contexts) >= MAX_CONTEXTS:
        oldest = min(_contexts, key=lambda item: _contexts[item]["updatedAt"])
        _contexts.pop(oldest, None)
    _contexts[key] = {"state": payload.state, "resource": resource, "updatedAt": time.monotonic(), "timestamp": d.now_iso()}
    history_key = key[:3]
    history = _history.setdefault(history_key, [])
    if not history or history[-1]["state"] != payload.state or history[-1]["resource"] != resource:
        history.append(dict(_contexts[key])); del history[:-6]
    if len(_history) > MAX_CONTEXTS:
        _history.pop(next(iter(_history)), None)
    await publish_presence(user, store)
    return await presence_view(user, store)


@router.patch("/presence/preferences")
async def update_preferences(payload: PresencePreferences, user: dict = Depends(current_user)):
    from app.modules.workhub.service import set_focus_mode
    from app.modules.workhub.schemas import FocusModeUpdate
    d = domain(); d.require_team_chat(user); team_id = d.team_id_for(user)
    if payload.expiresAt and not d.parse_iso_datetime(payload.expiresAt):
        raise HTTPException(400, "Escolha uma validade de status válida.")
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        store.setdefault("chatPresence", {})[str(user["id"])] = payload.model_dump()
        if not payload.shareContext or payload.focus:
            for key, item in _contexts.items():
                if key[:3] == (team_id, current_workspace_id(), str(user["id"])): item["resource"] = None
            _history.pop((team_id, current_workspace_id(), str(user["id"])), None)
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    await set_focus_mode(user, FocusModeUpdate(enabled=payload.focus, label=payload.text, sources=["equipe"]))
    await publish_presence(user, store)
    return await presence_view(user, store)


@router.patch("/threads/{thread_id}/notifications")
async def update_notifications(thread_id: str, payload: ChannelNotifications, user: dict = Depends(current_user)):
    d = domain(); d.require_team_chat(user); team_id = d.team_id_for(user)
    if payload.mutedUntil and not d.parse_iso_datetime(payload.mutedUntil): raise HTTPException(400, "Escolha uma data válida.")
    async with d.team_chat_lock(team_id):
        store = await asyncio.to_thread(d.read_chat_store, team_id)
        if thread_id not in {item["id"] for item in await d.accessible_threads(user, store)}:
            raise HTTPException(404, "Conversa indisponível.")
        store.setdefault("chatNotifications", {}).setdefault(str(user["id"]), {})[thread_id] = payload.model_dump()
        await asyncio.to_thread(d.write_chat_store, team_id, store)
    return {"notifications": payload.model_dump()}


def notification_allowed(store: dict, user_id: str, metadata: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    pref = store.get("chatNotifications", {}).get(user_id, {}).get(metadata.get("threadId"), {})
    mentioned = user_id in metadata.get("mentionedUserIds", [])
    urgent = mentioned and bool(metadata.get("urgentMention"))
    presence = active_preferences(store, user_id, now)
    if presence.get("focus") and not (urgent and presence.get("allowUrgentMentions", True)): return False
    muted = domain().parse_iso_datetime(pref.get("mutedUntil"))
    if muted and muted > now: return False
    return pref.get("mode", "all") == "all" or pref.get("mode") == "mentions" and mentioned
