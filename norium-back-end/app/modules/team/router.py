"""Dominio de equipe extraido para concentrar membros, chat e permissoes."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import Field

from app.shared.schemas import StrictModel

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, read_profile_db, write_json_file
from app.modules.team.call_adapters import CallbackCallPublisher, CallbackTeamDirectory, JsonCallStateStore
from app.modules.team.call_configuration import mesh_max_participants_from_environment
from app.modules.team.call_coordinator import (
    CallActor,
    CallCoordinator,
    CallError,
    CALL_EVENT_TYPES,
    PARTICIPANT_DISCONNECT_GRACE,
    SystemClock,
    TeamCallAuthorizer,
    active_call_for,
    active_call_invite,
    purge_stale_active_calls,
)
from app.modules.team.recording_adapters import (
    CallbackRecordingEvents,
    CallCoordinatorRecordingAccess,
    JsonRecordingStore,
)
from app.modules.team.recording_coordinator import (
    LocalRecordingFiles,
    RecordingAbort,
    RecordingActor,
    RecordingComplete,
    RecordingCoordinator,
    RecordingError,
    RecordingLimits,
    RecordingStart,
    RecordingUpload,
)
from app.modules.team.turn_credentials import (
    TurnCredentialProvider,
    TurnSubject,
    TurnUnavailableError,
    turn_provider_from_environment,
)
from app.modules.team.sfu_tokens import (
    SfuTokenProvider,
    SfuTokenSubject,
    SfuUnavailableError,
    sfu_provider_from_environment,
)
from app.modules.team.nora_mentions import generate_team_reply, has_nora_mention
from app.routers.auth_router import current_user, read_user_store, sanitize_user, user_from_websocket_ticket
from app.routers.inbox_router import record_event
from app.services.calendar_service import CalendarService

router = APIRouter(prefix="/api/team-chat", tags=["Chat interno"])
chat_lock = asyncio.Lock()
UPLOAD_DIR = get_data_root() / "team_chat_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
MAX_ATTACHMENT_TOTAL_BYTES = 24 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 8
MESSAGE_HISTORY_LIMIT = 300
MEETING_REMINDER_MINUTES = 10
CALL_RECONCILE_INTERVAL_SECONDS = 5
RECORDING_MAINTENANCE_INTERVAL_SECONDS = max(
    5, _positive_env_int("TEAM_RECORDING_MAINTENANCE_INTERVAL_SECONDS", 60),
)

MessageScope = Literal["team", "direct"]


class AttachmentPayload(StrictModel):
    fileName: str = Field(min_length=1, max_length=180)
    mimeType: str = "application/octet-stream"
    dataUrl: str = Field(min_length=16)


# Mantém o identificador histórico no OpenAPI quando há schemas homônimos.
AttachmentPayload.__module__ = "app.routers.team_chat_router"
AttachmentPayload.model_rebuild(force=True)


class SendTeamMessagePayload(StrictModel):
    scope: MessageScope = "team"
    recipientId: str | None = None
    text: str = Field(default="", max_length=2000)
    attachments: list[AttachmentPayload] = Field(default=[], max_length=MAX_ATTACHMENTS_PER_MESSAGE)
    mentionedUserIds: list[str] = Field(default_factory=list, max_length=100)


class SendSubteamMessagePayload(StrictModel):
    text: str = Field(default="", max_length=2000)
    attachments: list[AttachmentPayload] = Field(default=[], max_length=MAX_ATTACHMENTS_PER_MESSAGE)
    mentionedUserIds: list[str] = Field(default_factory=list, max_length=100)


class PinThreadPayload(StrictModel):
    threadId: str = Field(min_length=1, max_length=250)
    pinned: bool


class SendMeetingMessagePayload(SendSubteamMessagePayload):
    clientId: str = Field(min_length=1, max_length=100)


class SfuTokenPayload(StrictModel):
    clientId: str = Field(min_length=1, max_length=100)


class MarkMessagesReadPayload(StrictModel):
    messageIds: list[str] = Field(default_factory=list, max_length=100)


class SubteamCreatePayload(StrictModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=500)
    memberIds: list[str] = Field(default_factory=list, max_length=100)


class SubteamUpdatePayload(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    memberIds: list[str] | None = Field(default=None, max_length=100)


class RecordingStartPayload(StrictModel):
    callId: str = Field(min_length=8, max_length=120)
    clientId: str = Field(min_length=1, max_length=120)
    operationId: str = Field(min_length=1, max_length=120)
    scope: Literal["team", "direct", "subteam"] = "team"
    recipientId: str | None = None
    subteamId: str | None = None
    mimeType: str = Field(default="video/webm", max_length=120)


class ScheduleMeetingPayload(StrictModel):
    scope: Literal["team", "direct", "subteam"] = "team"
    recipientId: str | None = None
    subteamId: str | None = None
    title: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1200)
    startsAt: str = Field(min_length=16, max_length=80)
    endsAt: str = Field(min_length=16, max_length=80)
    participantIds: list[str] = Field(default_factory=list, max_length=100)


class PresenceManager:
    def __init__(self) -> None:
        self.connections: dict[str, list[WebSocket]] = {}
        self.user_team: dict[str, str] = {}
        self.socket_user: dict[WebSocket, str] = {}
        self.socket_connection: dict[WebSocket, str] = {}

    async def connect(
        self,
        team_id: str,
        user_id: str,
        websocket: WebSocket,
        connection_id: str | None = None,
    ) -> str:
        await websocket.accept()
        self.connections.setdefault(team_id, []).append(websocket)
        self.user_team[user_id] = team_id
        self.socket_user[websocket] = user_id
        resolved_connection_id = connection_id or uuid.uuid4().hex
        self.socket_connection[websocket] = resolved_connection_id
        await self.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": self.online_users(team_id)})
        return resolved_connection_id

    def disconnect(self, websocket: WebSocket, user_id: str) -> None:
        connected_user_id = self.socket_user.pop(websocket, user_id)
        self.socket_connection.pop(websocket, None)
        team_id = self.user_team.get(connected_user_id)
        if team_id:
            connections = self.connections.get(team_id, [])
            if websocket in connections:
                connections.remove(websocket)
            if not connections:
                self.connections.pop(team_id, None)
        remaining_for_user = any(value == connected_user_id for value in self.socket_user.values())
        if not remaining_for_user:
            self.user_team.pop(connected_user_id, None)

    def online_users(self, team_id: str) -> list[str]:
        return sorted(user_id for user_id, active_team in self.user_team.items() if active_team == team_id)

    async def broadcast(self, team_id: str, payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        store = await read_user_store()
        users_by_id = {
            str(item.get("id") or ""): item
            for item in store.get("users", [])
            if isinstance(item, dict)
        }
        for websocket in list(self.connections.get(team_id, [])):
            connected_user_id = self.socket_user.get(websocket, "")
            connected_user = users_by_id.get(connected_user_id)
            current_team_id = team_id_for(connected_user) if connected_user else ""
            if not connected_user or connected_user.get("status") != "ativo" or current_team_id != team_id:
                try:
                    await websocket.close(code=4403)
                except Exception:
                    pass
                disconnected.append(websocket)
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.disconnect(websocket, self.socket_user.get(websocket, ""))

    async def send_to_users(
        self,
        team_id: str,
        user_ids: set[str],
        payload: dict[str, Any],
        *,
        exclude_websocket: WebSocket | None = None,
    ) -> None:
        disconnected: list[WebSocket] = []
        validate_directory = str(payload.get("type") or "") != "CALL_SIGNAL"
        users_by_id: dict[str, dict[str, Any]] = {}
        if validate_directory:
            store = await read_user_store()
            users_by_id = {
                str(item.get("id") or ""): item
                for item in store.get("users", [])
                if isinstance(item, dict)
            }
        for websocket in list(self.connections.get(team_id, [])):
            if websocket is exclude_websocket:
                continue
            connected_user_id = self.socket_user.get(websocket, "")
            if connected_user_id not in user_ids:
                continue
            connected_user = users_by_id.get(connected_user_id)
            if validate_directory and (
                not connected_user
                or connected_user.get("status") != "ativo"
                or team_id_for(connected_user) != team_id
            ):
                try:
                    await websocket.close(code=4403)
                except Exception:
                    pass
                disconnected.append(websocket)
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.disconnect(websocket, self.socket_user.get(websocket, ""))


manager = PresenceManager()
_turn_provider: TurnCredentialProvider | None = None
_sfu_provider: SfuTokenProvider | None = None


def turn_credential_provider() -> TurnCredentialProvider:
    global _turn_provider
    if _turn_provider is None:
        _turn_provider = turn_provider_from_environment()
    return _turn_provider


def sfu_token_provider() -> SfuTokenProvider:
    global _sfu_provider
    if _sfu_provider is None:
        _sfu_provider = sfu_provider_from_environment()
    return _sfu_provider


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_team_chat(user: dict[str, Any]) -> None:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    if user.get("systemAdmin") or permissions.get("chat") or permissions.get("equipe"):
        return
    raise HTTPException(status_code=403, detail="Chat interno nao liberado para esta conta.")


def can_use_nora(user: dict[str, Any]) -> bool:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    return bool(user.get("systemAdmin") or permissions.get("nora"))


def team_id_for(user: dict[str, Any]) -> str:
    return str(user.get("teamOwnerId") or user.get("id") or "lucas123")


async def team_id_for_user_id(user_id: str) -> str:
    store = await read_user_store()
    user = next((item for item in store.get("users", []) if str(item.get("id")) == str(user_id)), None)
    if not user:
        return str(user_id or "lucas123")
    return str(user.get("teamOwnerId") or user.get("id") or user_id)


def team_chat_path(team_id: str) -> str:
    return get_user_db_path(team_id, "team_chat")


def empty_store() -> dict[str, Any]:
    return {
        "messages": [],
        "subteams": [],
        "recordings": [],
        "activeCalls": [],
        "scheduledMeetings": [],
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


def read_chat_store(team_id: str) -> dict[str, Any]:
    payload = read_json_file(team_chat_path(team_id), empty_store())
    if not isinstance(payload, dict):
        return empty_store()
    payload.setdefault("messages", [])
    payload.setdefault("subteams", [])
    payload.setdefault("recordings", [])
    payload.setdefault("activeCalls", [])
    payload.setdefault("scheduledMeetings", [])
    return payload


def write_chat_store(team_id: str, payload: dict[str, Any]) -> None:
    payload["updatedAt"] = now_iso()
    write_json_file(team_chat_path(team_id), payload)


def parse_iso_datetime(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def clear_meeting_chat(call: dict[str, Any]) -> None:
    for message in call.pop("meetingMessages", []):
        for attachment in message.get("attachments", []):
            name = str(attachment.get("storedName") or "")
            if name and Path(name).name == name:
                (UPLOAD_DIR / name).unlink(missing_ok=True)
async def read_pruned_chat_store(team_id: str) -> dict[str, Any]:
    async with chat_lock:
        return await asyncio.to_thread(read_chat_store, team_id)


async def visible_team_members(user: dict[str, Any]) -> list[dict[str, Any]]:
    store = await read_user_store()
    current_team_id = team_id_for(user)
    online_user_ids = set(manager.online_users(current_team_id))
    members = []
    for item in store.get("users", []):
        if str(item.get("id")) == current_team_id or str(item.get("teamOwnerId") or item.get("id")) == current_team_id:
            safe = sanitize_user(item)
            profile = read_profile_db(str(safe.get("id") or ""), {})
            safe["fotoUrl"] = profile.get("fotoUrl") or ""
            safe["online"] = safe.get("status") == "ativo" and safe["id"] in online_user_ids
            safe["lastLoginAt"] = item.get("lastLoginAt")
            members.append(safe)
    return members


def message_visible(message: dict[str, Any], user_id: str) -> bool:
    if message.get("scope") == "team":
        return True
    if message.get("scope") == "subteam":
        return user_id in {str(item) for item in message.get("memberIds", [])}
    return user_id in {str(message.get("senderId")), str(message.get("recipientId"))}


def normalize_thread_id(scope: str, user_id: str, recipient_id: str | None, subteam_id: str | None = None) -> str:
    if scope == "team":
        return "team"
    if scope == "subteam":
        if not subteam_id:
            raise HTTPException(status_code=400, detail="subteamId obrigatorio para uma subequipe.")
        return f"subteam:{subteam_id}"
    if not recipient_id:
        raise HTTPException(status_code=400, detail="recipientId obrigatorio para mensagem direta.")
    return "direct:" + ":".join(sorted([user_id, recipient_id]))


def subteam_or_404(store: dict[str, Any], subteam_id: str) -> dict[str, Any]:
    subteam = next(
        (item for item in store.get("subteams", []) if isinstance(item, dict) and str(item.get("id")) == subteam_id),
        None,
    )
    if not subteam:
        raise HTTPException(status_code=404, detail="Subequipe nao encontrada.")
    return subteam


def require_subteam_member(subteam: dict[str, Any], user_id: str) -> None:
    if user_id not in {str(item) for item in subteam.get("memberIds", [])}:
        raise HTTPException(status_code=403, detail="Voce nao participa desta subequipe.")


async def valid_team_member_ids(user: dict[str, Any]) -> set[str]:
    return {str(item.get("id") or "") for item in await visible_team_members(user) if item.get("status") == "ativo"}


def message_read_by(message: dict[str, Any]) -> dict[str, dict[str, Any]]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    read_by = metadata.get("readBy") if isinstance(metadata.get("readBy"), dict) else {}
    return {
        str(user_id): value
        for user_id, value in read_by.items()
        if isinstance(value, dict) and str(user_id)
    }


async def message_participant_ids(message: dict[str, Any], user: dict[str, Any], store: dict[str, Any]) -> set[str]:
    scope = str(message.get("scope") or "team")
    if scope == "team":
        return await valid_team_member_ids(user)
    if scope == "subteam":
        return {str(item) for item in message.get("memberIds", [])}
    return {str(message.get("senderId") or ""), str(message.get("recipientId") or "")} - {""}


async def thread_participant_ids(
    user: dict[str, Any],
    store: dict[str, Any],
    scope: str,
    recipient_id: str | None = None,
    subteam_id: str | None = None,
) -> set[str]:
    user_id = str(user.get("id") or "")
    team_members = await valid_team_member_ids(user)
    if scope == "team":
        return team_members
    if scope == "direct":
        if not recipient_id or recipient_id not in team_members:
            raise HTTPException(status_code=404, detail="Membro da equipe nao encontrado.")
        return {user_id, recipient_id}
    if scope == "subteam":
        subteam = subteam_or_404(store, str(subteam_id or ""))
        require_subteam_member(subteam, user_id)
        return {str(item) for item in subteam.get("memberIds", []) if str(item) in team_members}
    raise HTTPException(status_code=400, detail="Conversa invalida.")


async def accessible_threads(user: dict[str, Any], store: dict[str, Any]) -> list[dict[str, Any]]:
    user_id = str(user["id"])
    threads = [{"id": "team", "scope": "team"}]
    threads.extend(
        {"id": normalize_thread_id("direct", user_id, member_id), "scope": "direct", "recipientId": member_id}
        for member_id in sorted(await valid_team_member_ids(user)) if member_id != user_id
    )
    threads.extend(
        {"id": f"subteam:{item['id']}", "scope": "subteam", "subteamId": item["id"]}
        for item in store.get("subteams", []) if user_id in item.get("memberIds", [])
    )
    return threads


@router.get("/threads")
async def list_threads(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    store = await asyncio.to_thread(read_chat_store, team_id_for(user))
    user_id = str(user["id"])
    threads = await accessible_threads(user, store)
    by_id = {thread["id"]: thread for thread in threads}
    pins = store.get("pinnedThreadsByUser", {}).get(user_id, [])
    for thread in threads:
        thread.update(pinned=thread["id"] in pins, unreadCount=0, lastMessage=None)
    visible_counts: dict[str, int] = {}
    for message in reversed(store.get("messages", [])):
        thread = by_id.get(message.get("threadId"))
        if not thread or not message_visible(message, user_id):
            continue
        # O contador acompanha o mesmo histórico disponível ao abrir a conversa.
        count = visible_counts.get(thread["id"], 0)
        if count >= MESSAGE_HISTORY_LIMIT:
            continue
        visible_counts[thread["id"]] = count + 1
        if thread["lastMessage"] is None:
            thread["lastMessage"] = {
                "id": message["id"], "text": short_text(message.get("text") or "Arquivo compartilhado"),
                "senderId": message.get("senderId"), "senderName": message.get("senderName"),
                "createdAt": message.get("createdAt"),
            }
        if message.get("senderId") != user_id and user_id not in message_read_by(message):
            thread["unreadCount"] += 1
    return {"threads": threads}


@router.patch("/threads/pin")
async def pin_thread(payload: PinThreadPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    team_id, user_id = team_id_for(user), str(user["id"])
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        allowed = {thread["id"] for thread in await accessible_threads(user, store)}
        if payload.threadId not in allowed:
            raise HTTPException(status_code=404, detail="Conversa não encontrada.")
        preferences = store.setdefault("pinnedThreadsByUser", {})
        pins = set(preferences.get(user_id, [])) & allowed
        if payload.pinned:
            pins.add(payload.threadId)
        else:
            pins.discard(payload.threadId)
        preferences[user_id] = sorted(pins)
        await asyncio.to_thread(write_chat_store, team_id, store)
    await manager.send_to_users(team_id, {user_id}, {"type": "TEAM_THREADS_UPDATED"})
    return {"threadId": payload.threadId, "pinned": payload.pinned}


async def validated_mentions(text: str, requested_ids: list[str], participants: set[str], user: dict[str, Any]) -> list[dict[str, str]]:
    requested = set(requested_ids)
    if not requested <= participants:
        raise HTTPException(status_code=400, detail="Mencione apenas participantes desta conversa.")
    mentions = []
    for member in await visible_team_members(user) if requested else []:
        member_id = str(member["id"])
        name = str(member.get("nome") or "").strip()
        if member_id in requested and name and re.search(r"(?<!\w)@" + re.escape(name) + r"(?!\w)", text, re.IGNORECASE):
            mentions.append({"userId": member_id, "name": name})
    return mentions


def can_manage_subteam(user: dict[str, Any], subteam: dict[str, Any]) -> bool:
    user_id = str(user.get("id") or "")
    return bool(user.get("systemAdmin") or user_id == team_id_for(user) or user_id == str(subteam.get("createdBy") or ""))


def user_avatar_url(user_id: str) -> str:
    profile = read_profile_db(user_id, {})
    return str(profile.get("fotoUrl") or "")


def short_text(value: str, limit: int = 150) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return "sem texto"
    return text if len(text) <= limit else f"{text[:limit - 3]}..."


async def record_team_event(team_id: str, title: str, description: str, metadata: dict[str, Any] | None = None, *, user_ids: set[str] | None = None) -> None:
    try:
        for participant_id in sorted(user_ids if user_ids is not None else {team_id}):
            await record_event(
                source="equipe",
                title=title,
                description=description,
                metadata={**(metadata or {}), "userId": participant_id},
            )
    except Exception:
        # O chat interno nao deve falhar se a Central estiver temporariamente indisponivel.
        return


async def record_meeting_event_for_users(
    user_ids: set[str],
    *,
    title: str,
    description: str,
    meeting: dict[str, Any],
    action: str,
    event_id_prefix: str,
) -> None:
    for participant_id in sorted(user_ids):
        try:
            await record_event(
                source="equipe",
                title=title,
                description=description,
                metadata={
                    "userId": participant_id,
                    "action": action,
                    "meetingId": meeting.get("id"),
                    "threadId": meeting.get("threadId"),
                    "scope": meeting.get("scope"),
                    "startsAt": meeting.get("startsAt"),
                    "endsAt": meeting.get("endsAt"),
                    "organizerId": meeting.get("createdBy"),
                    "organizerName": meeting.get("createdByName"),
                },
                event_id=f"{event_id_prefix}_{meeting.get('id')}_{participant_id}",
            )
        except Exception:
            # O convite continua salvo no chat mesmo se a Central estiver indisponivel.
            continue


async def append_team_message_for_user(
    user_id: str,
    text: str,
    *,
    sender_id: str = "nora",
    sender_name: str = "Nora",
    sender_avatar: str = "nora",
    metadata: dict[str, Any] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    team_id = await team_id_for_user_id(user_id)
    stored_attachments = save_attachments([
        AttachmentPayload.model_validate(item)
        for item in (attachments or [])
    ])
    message = {
        "id": f"team_msg_{uuid.uuid4().hex}",
        "threadId": "team",
        "scope": "team",
        "senderId": sender_id,
        "senderName": sender_name,
        "senderAvatar": sender_avatar,
        "recipientId": None,
        "text": text.strip(),
        "attachments": stored_attachments,
        "metadata": {"readBy": {}, **(metadata or {})},
        "createdAt": now_iso(),
    }
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        store.setdefault("messages", []).append(message)
        store["messages"] = store["messages"][-2000:]
        await asyncio.to_thread(write_chat_store, team_id, store)
    await manager.broadcast(team_id, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await record_team_event(
        team_id,
        f"{sender_name} enviou mensagem ao time",
        f'{short_text(message["text"])}. Anexos: {len(stored_attachments)}.',
        {
            "action": "team_message_created",
            "messageId": message["id"],
            "senderId": sender_id,
            "senderName": sender_name,
            "threadId": "team",
            **(metadata or {}),
        },
    )
    return message


async def respond_to_nora_mention(
    *,
    team_id: str,
    requester_id: str,
    requester_name: str,
    source_message: dict[str, Any],
) -> None:
    """Responde em segundo plano para nao atrasar o envio da mensagem da equipe."""
    try:
        store = await asyncio.to_thread(read_chat_store, team_id)
        messages = [item for item in store.get("messages", []) if isinstance(item, dict)]
        reply = await generate_team_reply(messages, requester_name, str(source_message.get("text") or ""))
        if not reply:
            reply = "Nao consegui formular uma resposta agora. Pode repetir o pedido com um pouco mais de contexto?"
        await append_team_message_for_user(
            requester_id,
            reply,
            metadata={
                "action": "nora_team_mention_response",
                "replyToMessageId": source_message.get("id"),
                "mentionedByUserId": requester_id,
            },
        )
    except Exception:
        await append_team_message_for_user(
            requester_id,
            "Nao consegui analisar a conversa agora. Tente me mencionar novamente em alguns instantes.",
            metadata={
                "action": "nora_team_mention_error",
                "replyToMessageId": source_message.get("id"),
                "mentionedByUserId": requester_id,
            },
        )


@router.get("/members")
async def list_members(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    members = await visible_team_members(user)
    online_user_ids = [str(member["id"]) for member in members if member.get("online")]
    return {"teamId": team_id_for(user), "members": members, "onlineUserIds": online_user_ids}


async def _call_active_member_ids(actor: CallActor) -> set[str]:
    store = await read_user_store()
    return {
        str(item.get("id") or "")
        for item in store.get("users", [])
        if isinstance(item, dict)
        and item.get("status") == "ativo"
        and team_id_for(item) == actor.team_id
        and str(item.get("id") or "")
    }


async def _call_subteam_member_ids(actor: CallActor, subteam_id: str) -> set[str] | None:
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, actor.team_id)
    subteam = next(
        (
            item for item in store.get("subteams", [])
            if isinstance(item, dict) and str(item.get("id") or "") == subteam_id
        ),
        None,
    )
    if not subteam:
        return None
    return {str(item) for item in subteam.get("memberIds", []) if str(item)}


async def _publish_call_event(team_id: str, user_ids: set[str], payload: dict[str, Any]) -> None:
    await manager.send_to_users(team_id, user_ids, payload)


_call_coordinator_instance: CallCoordinator | None = None
_call_reconcile_tasks: set[asyncio.Task[None]] = set()


async def _reconcile_closed_connection(actor: CallActor) -> None:
    await asyncio.sleep(PARTICIPANT_DISCONNECT_GRACE.total_seconds())
    await call_coordinator().reconcile(actor)


def call_coordinator() -> CallCoordinator:
    global _call_coordinator_instance
    if _call_coordinator_instance is None:
        store = JsonCallStateStore(
            read_document=lambda team_id: read_chat_store(team_id),
            write_document=lambda team_id, document: write_chat_store(team_id, document),
            lock=chat_lock,
            on_call_removed=clear_meeting_chat,
        )
        directory = CallbackTeamDirectory(
            active_members=_call_active_member_ids,
            subteam_members=_call_subteam_member_ids,
        )
        publisher = CallbackCallPublisher(
            send=_publish_call_event,
            online=lambda team_id: manager.online_users(team_id),
        )
        _call_coordinator_instance = CallCoordinator(
            store=store,
            publisher=publisher,
            authorizer=TeamCallAuthorizer(directory),
            max_participants=mesh_max_participants_from_environment(),
        )
    return _call_coordinator_instance


def call_actor(user: dict[str, Any], connection_id: str | None = None) -> CallActor:
    user_id = str(user.get("id") or "")
    attributes = dict(user)
    if connection_id:
        attributes["connectionId"] = connection_id
    return CallActor(
        user_id=user_id,
        team_id=team_id_for(user),
        name=str(user.get("nome") or "Membro"),
        avatar=user_avatar_url(user_id),
        attributes=attributes,
    )


def _as_http_error(error: CallError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail=error.detail,
        headers={"X-Call-Error-Code": error.code},
    )


async def active_calls_snapshot(team_id: str) -> list[dict[str, Any]]:
    """Fachada de compatibilidade para consumidores internos antigos."""
    return await call_coordinator().snapshot(team_id, refresh=True)


async def broadcast_call_state(team_id: str) -> None:
    await call_coordinator().broadcast_state(team_id)


@router.get("/calls/active")
async def list_active_calls(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    try:
        calls = await call_coordinator().active_calls_for(call_actor(user), refresh=True)
    except CallError as exc:
        raise _as_http_error(exc) from exc
    return {"calls": calls}


@router.get("/calls/ice-servers")
async def get_call_ice_servers(
    response: Response,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, object]:
    require_team_chat(user)
    if user.get("status") != "ativo" or not str(user.get("id") or "").strip():
        raise HTTPException(status_code=403, detail="Somente membros ativos podem obter acesso TURN.")
    no_store_headers = {"Cache-Control": "no-store, private", "Pragma": "no-cache"}
    try:
        document = turn_credential_provider().issue(
            TurnSubject(team_id=team_id_for(user), user_id=str(user["id"]))
        )
    except TurnUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="O serviço TURN está temporariamente indisponível.",
            headers=no_store_headers,
        ) from exc
    response.headers.update(no_store_headers)
    return document.as_payload()


@router.post("/calls/{call_id}/media-token")
async def create_call_media_token(
    call_id: str,
    payload: SfuTokenPayload,
    response: Response,
    user: dict[str, Any] = Depends(current_user),
    provider: SfuTokenProvider = Depends(sfu_token_provider),
) -> dict[str, str]:
    require_team_chat(user)
    if user.get("status") != "ativo" or not str(user.get("id") or "").strip():
        raise HTTPException(status_code=403, detail="Somente membros ativos podem acessar a chamada.")
    actor = call_actor(user)
    no_store_headers = {"Cache-Control": "no-store, private", "Pragma": "no-cache"}
    try:
        context = await call_coordinator().media_context(
            actor,
            call_id,
            payload.clientId,
            expected_transport="sfu",
        )
        session = context["participantSessions"][actor.user_id]
        document = provider.issue(SfuTokenSubject(
            team_id=actor.team_id,
            call_id=call_id,
            user_id=actor.user_id,
            media_session_id=str(session["mediaSessionId"]),
        ))
    except CallError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.detail,
            headers={**no_store_headers, "X-Call-Error-Code": exc.code},
        ) from exc
    except SfuUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="O transporte de mídia está temporariamente indisponível.",
            headers=no_store_headers,
        ) from exc
    response.headers.update(no_store_headers)
    return document.as_payload()


@router.delete("/calls/{call_id}")
async def delete_active_call(call_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    try:
        return await call_coordinator().end_call(call_actor(user), call_id)
    except CallError as exc:
        raise _as_http_error(exc) from exc


def require_joined_call(store: dict[str, Any], call_id: str, user_id: str, client_id: str) -> dict[str, Any]:
    call = active_call_for(store, call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Esta reunião já foi encerrada.")
    if call.get("joinedClients", {}).get(user_id) != client_id:
        raise HTTPException(status_code=403, detail="Entre na reunião para usar este chat.")
    return call


@router.get("/calls/{call_id}/messages")
async def list_meeting_messages(call_id: str, clientId: str = Query(min_length=1, max_length=100),
                                user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    team_id = team_id_for(user)
    await active_calls_snapshot(team_id)
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        call = require_joined_call(store, call_id, str(user["id"]), clientId)
        return {"messages": call.get("meetingMessages", [])}


@router.post("/calls/{call_id}/messages")
async def send_meeting_message(call_id: str, payload: SendMeetingMessagePayload,
                               user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    if not payload.text.strip() and not payload.attachments:
        raise HTTPException(status_code=400, detail="Escreva uma mensagem ou anexe um arquivo.")
    team_id, user_id = team_id_for(user), str(user["id"])
    await active_calls_snapshot(team_id)
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        call = require_joined_call(store, call_id, user_id, payload.clientId)
        messages = call.setdefault("meetingMessages", [])
        if len(messages) >= 500:
            raise HTTPException(status_code=409, detail="O chat desta reunião atingiu o limite de 500 mensagens.")
        message = {"id": f"meeting_msg_{uuid.uuid4().hex}", "callId": call_id,
                   "senderId": user_id, "senderName": str(user.get("nome") or "Membro"),
                   "text": payload.text.strip(), "createdAt": now_iso(),
                   "attachments": await asyncio.to_thread(save_attachments, payload.attachments)}
        messages.append(message)
        await asyncio.to_thread(write_chat_store, team_id, store)
        recipients = set(call.get("joinedClients", {}))
    await manager.send_to_users(team_id, recipients, {
        "type": "CALL_CHAT_MESSAGE", "callId": call_id, "message": message,
    })
    return {"message": message}


@router.get("/subteams")
async def list_subteams(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    store = await asyncio.to_thread(read_chat_store, team_id_for(user))
    subteams = [
        item
        for item in store.get("subteams", [])
        if isinstance(item, dict) and user_id in {str(member_id) for member_id in item.get("memberIds", [])}
    ]
    return {"subteams": subteams}


@router.post("/subteams")
async def create_subteam(payload: SubteamCreatePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    team_members = await valid_team_member_ids(user)
    requested_members = {str(item) for item in payload.memberIds}
    if requested_members - team_members:
        raise HTTPException(status_code=400, detail="A subequipe contem usuarios que nao pertencem a esta equipe.")
    now = now_iso()
    subteam = {
        "id": f"subteam_{uuid.uuid4().hex}",
        "name": payload.name.strip(),
        "description": payload.description.strip(),
        "memberIds": sorted((requested_members | {user_id}) & team_members),
        "createdBy": user_id,
        "createdAt": now,
        "updatedAt": now,
    }
    team_id = team_id_for(user)
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        if any(str(item.get("name") or "").casefold() == subteam["name"].casefold() for item in store.get("subteams", []) if isinstance(item, dict)):
            raise HTTPException(status_code=409, detail="Ja existe uma subequipe com este nome.")
        store.setdefault("subteams", []).append(subteam)
        await asyncio.to_thread(write_chat_store, team_id, store)
    await manager.send_to_users(team_id, set(subteam["memberIds"]), {"type": "SUBTEAM_UPDATED", "subteam": subteam})
    return {"subteam": subteam}


@router.patch("/subteams/{subteam_id}")
async def update_subteam(subteam_id: str, payload: SubteamUpdatePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    team_id = team_id_for(user)
    team_members = await valid_team_member_ids(user)
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        current = subteam_or_404(store, subteam_id)
        if not can_manage_subteam(user, current):
            raise HTTPException(status_code=403, detail="Somente o criador ou administrador pode editar esta subequipe.")
        updates = payload.model_dump(exclude_unset=True)
        if "name" in updates:
            updates["name"] = str(updates["name"]).strip()
        if "description" in updates:
            updates["description"] = str(updates["description"]).strip()
        if payload.memberIds is not None:
            requested_members = {str(item) for item in payload.memberIds}
            if requested_members - team_members:
                raise HTTPException(status_code=400, detail="A subequipe contem usuarios que nao pertencem a esta equipe.")
            requested_members.add(str(current.get("createdBy") or user.get("id") or ""))
            updates["memberIds"] = sorted(requested_members & team_members)
        updated = {**current, **updates, "updatedAt": now_iso()}
        store["subteams"] = [updated if item is current else item for item in store.get("subteams", [])]
        await asyncio.to_thread(write_chat_store, team_id, store)
    notified = {str(item) for item in current.get("memberIds", [])} | {str(item) for item in updated.get("memberIds", [])}
    await manager.send_to_users(team_id, notified, {"type": "SUBTEAM_UPDATED", "subteam": updated})
    return {"subteam": updated}


@router.get("/messages")
async def list_messages(
    scope: MessageScope = "team",
    recipientId: str | None = None,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    store = await read_pruned_chat_store(team_id_for(user))
    await thread_participant_ids(user, store, scope, recipientId)
    thread_id = normalize_thread_id(scope, user_id, recipientId)
    messages = [
        item for item in store.get("messages", [])
        if isinstance(item, dict) and item.get("threadId") == thread_id and message_visible(item, user_id)
    ]
    return {"threadId": thread_id, "messages": messages[-MESSAGE_HISTORY_LIMIT:]}


@router.get("/subteams/{subteam_id}/messages")
async def list_subteam_messages(subteam_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    store = await read_pruned_chat_store(team_id_for(user))
    await thread_participant_ids(user, store, "subteam", subteam_id=subteam_id)
    thread_id = normalize_thread_id("subteam", user_id, None, subteam_id)
    messages = [
        item for item in store.get("messages", [])
        if isinstance(item, dict) and item.get("threadId") == thread_id and message_visible(item, user_id)
    ]
    return {"threadId": thread_id, "messages": messages[-MESSAGE_HISTORY_LIMIT:]}


@router.post("/messages/read")
async def mark_messages_read(payload: MarkMessagesReadPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    user_name = str(user.get("nome") or user.get("email") or "Membro")
    requested_ids = {str(item).strip() for item in payload.messageIds if str(item).strip()}
    if not requested_ids:
        return {"updated": []}

    team_id = team_id_for(user)
    changed: list[tuple[str, dict[str, dict[str, Any]], set[str]]] = []
    viewed_at = now_iso()
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        for message in store.get("messages", []):
            if not isinstance(message, dict) or str(message.get("id") or "") not in requested_ids:
                continue
            if not message_visible(message, user_id) or str(message.get("senderId") or "") == user_id:
                continue
            read_by = message_read_by(message)
            if user_id in read_by:
                continue
            read_by[user_id] = {"userId": user_id, "userName": user_name, "viewedAt": viewed_at}
            metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
            message["metadata"] = {**metadata, "readBy": read_by}
            recipients = await message_participant_ids(message, user, store)
            changed.append((str(message["id"]), read_by, recipients))
        if changed:
            await asyncio.to_thread(write_chat_store, team_id, store)

    for message_id, read_by, recipients in changed:
        await manager.send_to_users(
            team_id,
            recipients,
            {"type": "TEAM_MESSAGE_READ", "messageId": message_id, "readBy": read_by},
        )
    return {"updated": [{"messageId": message_id, "readBy": read_by} for message_id, read_by, _ in changed]}


async def persist_message(
    *,
    scope: str,
    recipient_id: str | None,
    subteam_id: str | None,
    text: str,
    attachment_payloads: list[AttachmentPayload],
    user: dict[str, Any],
    mentioned_user_ids: list[str] | None = None,
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    if not text.strip() and not attachment_payloads:
        raise HTTPException(status_code=400, detail="Digite uma mensagem ou anexe um arquivo.")

    team_id = team_id_for(user)
    store = await asyncio.to_thread(read_chat_store, team_id)
    participant_ids = await thread_participant_ids(user, store, scope, recipient_id, subteam_id)
    mentions = await validated_mentions(text, mentioned_user_ids or [], participant_ids, user)
    mentioned_ids = {item["userId"] for item in mentions} - {user_id}
    thread_id = normalize_thread_id(scope, user_id, recipient_id, subteam_id)
    attachments = save_attachments(attachment_payloads)
    nora_mentioned = scope == "team" and has_nora_mention(text)
    nora_triggered = nora_mentioned and can_use_nora(user)
    message = {
        "id": f"team_msg_{uuid.uuid4().hex}",
        "threadId": thread_id,
        "scope": scope,
        "senderId": user_id,
        "senderName": user.get("nome") or user.get("email") or "Membro",
        "senderAvatar": user_avatar_url(user_id),
        "recipientId": recipient_id if scope == "direct" else None,
        "subteamId": subteam_id if scope == "subteam" else None,
        "memberIds": sorted(participant_ids) if scope == "subteam" else [],
        "text": text.strip(),
        "attachments": attachments,
        "metadata": {
            "noraMentioned": nora_mentioned,
            "noraTriggered": nora_triggered,
            "readBy": {},
            "mentions": mentions,
            "mentionedUserIds": sorted(mentioned_ids),
        },
        "createdAt": now_iso(),
    }
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        store.setdefault("messages", []).append(message)
        store["messages"] = store["messages"][-2000:]
        await asyncio.to_thread(write_chat_store, team_id, store)

    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await record_team_event(
        team_id,
        "Mensagem no chat interno" if scope == "team" else "Mensagem na subequipe" if scope == "subteam" else "Mensagem direta no chat interno",
        (
            f"{message['senderName']}: {short_text(message['text'])}. "
            f"Anexos: {len(attachments)}."
        ),
        {
            "action": "team_message_created",
            "messageId": message["id"],
            "senderId": user_id,
            "senderName": message["senderName"],
            "scope": scope,
            "threadId": thread_id,
            "attachments": len(attachments),
            "recipientId": recipient_id,
            "subteamId": subteam_id,
            "mentionedUserIds": sorted(mentioned_ids),
        },
        user_ids=participant_ids - mentioned_ids,
    )
    if mentioned_ids:
        await record_team_event(
            team_id, f"{message['senderName']} mencionou você", short_text(message["text"], 300),
            {"action": "team_member_mentioned", "messageId": message["id"], "senderId": user_id,
             "senderName": message["senderName"], "threadId": thread_id, "scope": scope,
             "recipientId": recipient_id, "subteamId": subteam_id, "mentionedUserIds": sorted(mentioned_ids)},
            user_ids=mentioned_ids,
        )
    from app.services.system_email import notify_team_participants
    await notify_team_participants(participant_ids - {user_id}, message["id"], "Nova mensagem no chat da equipe")
    if nora_triggered:
        asyncio.create_task(
            respond_to_nora_mention(
                team_id=team_id,
                requester_id=user_id,
                requester_name=str(message["senderName"]),
                source_message=message,
            )
        )
    return {"message": message}


@router.post("/messages")
async def send_message(payload: SendTeamMessagePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await persist_message(
        scope=payload.scope,
        recipient_id=payload.recipientId,
        subteam_id=None,
        text=payload.text,
        attachment_payloads=payload.attachments,
        user=user,
        mentioned_user_ids=payload.mentionedUserIds,
    )


@router.post("/subteams/{subteam_id}/messages")
async def send_subteam_message(
    subteam_id: str,
    payload: SendSubteamMessagePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await persist_message(
        scope="subteam",
        recipient_id=None,
        subteam_id=subteam_id,
        text=payload.text,
        attachment_payloads=payload.attachments,
        user=user,
        mentioned_user_ids=payload.mentionedUserIds,
    )


def scheduled_meeting_or_404(store: dict[str, Any], meeting_id: str) -> dict[str, Any]:
    meeting = next(
        (
            item
            for item in store.get("scheduledMeetings", [])
            if isinstance(item, dict) and str(item.get("id") or "") == meeting_id
        ),
        None,
    )
    if not meeting:
        raise HTTPException(status_code=404, detail="Reuniao agendada nao encontrada.")
    return meeting


def require_scheduled_meeting_participant(meeting: dict[str, Any], user_id: str) -> None:
    if user_id not in {str(item) for item in meeting.get("participantIds", [])}:
        raise HTTPException(status_code=403, detail="Voce nao participa desta reuniao.")


def meeting_message(meeting: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    participant_ids = {str(item) for item in meeting.get("participantIds", [])}
    return {
        "id": str(meeting["messageId"]),
        "threadId": meeting.get("threadId"),
        "scope": meeting.get("scope"),
        "senderId": str(user.get("id") or ""),
        "senderName": meeting.get("createdByName") or user.get("nome") or "Membro",
        "senderAvatar": user_avatar_url(str(user.get("id") or "")),
        "recipientId": meeting.get("recipientId"),
        "subteamId": meeting.get("subteamId"),
        "memberIds": sorted(participant_ids) if meeting.get("scope") == "subteam" else [],
        "text": f"Agendou a reuniao: {meeting.get('title')}.",
        "attachments": [],
        "metadata": {
            "action": "meeting_scheduled",
            "meetingId": meeting.get("id"),
            "title": meeting.get("title"),
            "description": meeting.get("description"),
            "startsAt": meeting.get("startsAt"),
            "endsAt": meeting.get("endsAt"),
            "participantIds": sorted(participant_ids),
            "agendaAddedBy": sorted(str(item) for item in meeting.get("calendarEntries", {}).keys()),
            "reminderMinutes": MEETING_REMINDER_MINUTES,
            "readBy": {},
        },
        "createdAt": meeting.get("createdAt"),
    }


@router.post("/meetings")
async def schedule_meeting(payload: ScheduleMeetingPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    team_id = team_id_for(user)
    starts_at = parse_iso_datetime(payload.startsAt)
    ends_at = parse_iso_datetime(payload.endsAt)
    current_time = datetime.now(timezone.utc)
    if not starts_at or not ends_at:
        raise HTTPException(status_code=400, detail="Data ou horario da reuniao invalido.")
    if starts_at <= current_time:
        raise HTTPException(status_code=400, detail="Escolha um horario futuro para a reuniao.")
    if ends_at <= starts_at or ends_at - starts_at > timedelta(hours=8):
        raise HTTPException(status_code=400, detail="A reuniao deve durar entre 1 minuto e 8 horas.")
    if starts_at > current_time + timedelta(days=730):
        raise HTTPException(status_code=400, detail="A reuniao deve ser agendada para os proximos 2 anos.")

    store = await asyncio.to_thread(read_chat_store, team_id)
    allowed_participants = await thread_participant_ids(
        user,
        store,
        payload.scope,
        payload.recipientId,
        payload.subteamId,
    )
    requested_participants = {str(item) for item in payload.participantIds if str(item)} or set(allowed_participants)
    if requested_participants - allowed_participants:
        raise HTTPException(status_code=400, detail="A reuniao contem pessoas que nao pertencem a esta conversa.")
    participant_ids = (requested_participants & allowed_participants) | {user_id}
    if payload.scope == "direct":
        participant_ids = set(allowed_participants)

    meeting_id = f"team_meeting_{uuid.uuid4().hex}"
    thread_id = normalize_thread_id(payload.scope, user_id, payload.recipientId, payload.subteamId)
    meeting = {
        "id": meeting_id,
        "messageId": f"team_msg_{uuid.uuid4().hex}",
        "scope": payload.scope,
        "threadId": thread_id,
        "recipientId": payload.recipientId if payload.scope == "direct" else None,
        "subteamId": payload.subteamId if payload.scope == "subteam" else None,
        "title": payload.title.strip(),
        "description": payload.description.strip(),
        "startsAt": starts_at.astimezone(timezone.utc).isoformat(),
        "endsAt": ends_at.astimezone(timezone.utc).isoformat(),
        "participantIds": sorted(participant_ids),
        "createdBy": user_id,
        "createdByName": user.get("nome") or user.get("email") or "Membro",
        "calendarEntries": {},
        "remindedUserIds": [],
        "status": "scheduled",
        "createdAt": now_iso(),
    }
    message = meeting_message(meeting, user)
    async with chat_lock:
        current_store = await asyncio.to_thread(read_chat_store, team_id)
        current_store.setdefault("scheduledMeetings", []).append(meeting)
        current_store["scheduledMeetings"] = current_store["scheduledMeetings"][-500:]
        current_store.setdefault("messages", []).append(message)
        current_store["messages"] = current_store["messages"][-2000:]
        await asyncio.to_thread(write_chat_store, team_id, current_store)

    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_MEETING_SCHEDULED", "meeting": meeting})
    local_start = starts_at.astimezone(timezone(timedelta(hours=-3)))
    await record_meeting_event_for_users(
        participant_ids,
        title="Reuniao agendada",
        description=f"{meeting['title']} em {local_start.strftime('%d/%m/%Y as %H:%M')}.",
        meeting=meeting,
        action="team_meeting_scheduled",
        event_id_prefix="team_meeting_scheduled",
    )
    return {"meeting": meeting, "message": message}


@router.post("/meetings/{meeting_id}/calendar")
async def add_scheduled_meeting_to_calendar(meeting_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    team_id = team_id_for(user)
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        meeting = scheduled_meeting_or_404(store, meeting_id)
        require_scheduled_meeting_participant(meeting, user_id)
        calendar_entries = meeting.setdefault("calendarEntries", {})
        if user_id in calendar_entries:
            return {"meeting": meeting, "calendarEvent": calendar_entries[user_id], "alreadyAdded": True}

        try:
            result = await asyncio.to_thread(
                CalendarService(user_id).create_event,
                titulo=str(meeting.get("title") or "Reuniao da equipe"),
                inicio=str(meeting.get("startsAt") or ""),
                fim=str(meeting.get("endsAt") or ""),
                descricao=(str(meeting.get("description") or "") + "\n\nReuniao agendada pelo chat da equipe no Norium.").strip(),
                local="Norium - Chat da equipe",
                participantes=[],
                criar_meet=False,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Nao foi possivel adicionar a reuniao a agenda agora.") from exc
        calendar_event = result.get("evento", {}) if isinstance(result, dict) else {}
        calendar_source = calendar_event.get("source")
        if not calendar_source and isinstance(result, dict):
            calendar_source = result.get("source")
        calendar_entries[user_id] = {
            "eventId": calendar_event.get("id"),
            "source": calendar_source or "local",
            "htmlLink": calendar_event.get("htmlLink"),
            "addedAt": now_iso(),
        }
        message = next(
            (item for item in store.get("messages", []) if isinstance(item, dict) and item.get("id") == meeting.get("messageId")),
            None,
        )
        if message:
            message["metadata"] = meeting_message(meeting, user)["metadata"]
        await asyncio.to_thread(write_chat_store, team_id, store)

    participant_ids = {str(item) for item in meeting.get("participantIds", [])}
    if message:
        await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    return {"meeting": meeting, "calendarEvent": calendar_entries[user_id], "alreadyAdded": False}


async def emit_due_meeting_reminders(team_id: str, current_time: datetime | None = None) -> int:
    now = current_time or datetime.now(timezone.utc)
    pending: list[tuple[dict[str, Any], set[str]]] = []
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        changed = False
        for meeting in store.get("scheduledMeetings", []):
            if not isinstance(meeting, dict) or meeting.get("status") != "scheduled":
                continue
            starts_at = parse_iso_datetime(meeting.get("startsAt"))
            if not starts_at:
                continue
            seconds_until_start = (starts_at - now).total_seconds()
            if seconds_until_start < 0 or seconds_until_start > MEETING_REMINDER_MINUTES * 60:
                continue
            participant_ids = {str(item) for item in meeting.get("participantIds", [])}
            reminded = {str(item) for item in meeting.get("remindedUserIds", [])}
            recipients = participant_ids - reminded
            if not recipients:
                continue
            meeting["remindedUserIds"] = sorted(reminded | recipients)
            pending.append((dict(meeting), recipients))
            changed = True
        if changed:
            await asyncio.to_thread(write_chat_store, team_id, store)

    for meeting, recipients in pending:
        starts_at = parse_iso_datetime(meeting.get("startsAt"))
        start_time = starts_at.astimezone(timezone(timedelta(hours=-3))).strftime("%H:%M") if starts_at else "em instantes"
        await record_meeting_event_for_users(
            recipients,
            title="Reuniao em 10 minutos",
            description=f"{meeting.get('title') or 'Reuniao da equipe'} comeca as {start_time}.",
            meeting=meeting,
            action="team_meeting_reminder",
            event_id_prefix="team_meeting_reminder",
        )
        await manager.send_to_users(team_id, recipients, {"type": "TEAM_MEETING_REMINDER", "meeting": meeting})
    return sum(len(recipients) for _, recipients in pending)


_recording_coordinator_instance: RecordingCoordinator | None = None
_recording_maintenance_task: asyncio.Task[None] | None = None


def recording_actor(user: dict[str, Any]) -> RecordingActor:
    return RecordingActor(
        user_id=str(user.get("id") or ""),
        team_id=team_id_for(user),
        name=str(user.get("nome") or user.get("email") or "Membro"),
    )


async def _audit_recording(team_id: str, action: str, metadata: dict[str, Any]) -> None:
    titles = {
        "recording_started": "Gravacao de reuniao iniciada",
        "recording_stopped": "Gravacao de reuniao encerrada",
        "recording_failed": "Falha na gravacao de reuniao",
        "recording_deleted": "Gravacao de reuniao excluida",
    }
    await record_team_event(
        team_id,
        titles.get(action, "Evento de gravacao de reuniao"),
        "Evento de ciclo de vida da gravacao, sem conteudo de audio ou video.",
        {"action": action, **metadata},
    )


async def _publish_recording_event(
    team_id: str,
    recipients: set[str],
    payload: dict[str, Any],
) -> None:
    await manager.send_to_users(team_id, recipients, payload)
    if payload.get("type") != "CALL_RECORDING_AVAILABLE":
        return
    recording_id = str(payload.get("recordingId") or "")
    from app.services.system_email import notify_team_participants

    await notify_team_participants(
        recipients,
        f"recording_{recording_id}",
        "Gravação de reunião disponível",
    )
    await record_team_event(
        team_id,
        "Gravacao de reuniao concluida",
        "A gravacao ficara disponivel por 24 horas.",
        {
            "action": "meeting_recording",
            "callId": payload.get("callId"),
            "recordingId": recording_id,
        },
        user_ids=recipients,
    )


def recording_coordinator() -> RecordingCoordinator:
    global _recording_coordinator_instance
    if _recording_coordinator_instance is None:
        _recording_coordinator_instance = RecordingCoordinator(
            store=JsonRecordingStore(
                read_document=read_chat_store,
                write_document=write_chat_store,
                lock=chat_lock,
            ),
            files=LocalRecordingFiles(UPLOAD_DIR),
            call_access=CallCoordinatorRecordingAccess(call_coordinator),
            events=CallbackRecordingEvents(
                publish=_publish_recording_event,
                audit=_audit_recording,
            ),
            clock=SystemClock(),
            limits=RecordingLimits.from_env(),
            attachment_url=lambda name: public_api_url(
                f"/api/team-chat/attachments/{quote(name)}"
            ),
            avatar_url=user_avatar_url,
        )
    return _recording_coordinator_instance


def _recording_http_error(error: RecordingError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail)


async def _recording_team_ids() -> list[str]:
    store = await read_user_store()
    return sorted({
        team_id_for(user)
        for user in store.get("users", [])
        if isinstance(user, dict) and str(user.get("id") or "")
    })


async def _recording_maintenance_loop() -> None:
    while True:
        try:
            await recording_coordinator().maintain(await _recording_team_ids())
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(RECORDING_MAINTENANCE_INTERVAL_SECONDS)


async def start_recording_maintenance() -> None:
    global _recording_maintenance_task
    if _recording_maintenance_task is None or _recording_maintenance_task.done():
        _recording_maintenance_task = asyncio.create_task(_recording_maintenance_loop())


async def stop_recording_maintenance() -> None:
    global _recording_maintenance_task
    task = _recording_maintenance_task
    _recording_maintenance_task = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@router.post("/recordings/start")
async def start_recording(payload: RecordingStartPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    try:
        return await recording_coordinator().start(
            recording_actor(user),
            RecordingStart(
                call_id=payload.callId,
                client_id=payload.clientId,
                operation_id=payload.operationId,
                mime_type=payload.mimeType,
            ),
        )
    except RecordingError as error:
        raise _recording_http_error(error) from error


@router.put("/recordings/{recording_id}/chunks")
async def append_recording_chunk(recording_id: str, request: Request, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    client_id = str(request.headers.get("X-Call-Client-Id") or "").strip()
    chunk_id = str(request.headers.get("X-Recording-Chunk-Id") or "").strip()
    if not client_id or not chunk_id or len(client_id) > 120 or len(chunk_id) > 120:
        raise HTTPException(status_code=400, detail="Cliente e identificador do trecho sao obrigatorios.")
    try:
        declared_size = int(request.headers.get("content-length") or 0)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Tamanho de trecho invalido.") from error
    coordinator = recording_coordinator()
    actor = recording_actor(user)
    if declared_size > coordinator.limits.max_chunk_bytes:
        try:
            await coordinator.reject_upload(
                actor,
                recording_id,
                client_id,
                status_code=413,
                detail="Trecho da gravacao acima do limite configurado.",
                failure_code="chunk_too_large",
            )
        except RecordingError as error:
            raise _recording_http_error(error) from error
    received = bytearray()
    async for part in request.stream():
        received.extend(part)
        if len(received) > coordinator.limits.max_chunk_bytes:
            try:
                await coordinator.reject_upload(
                    actor,
                    recording_id,
                    client_id,
                    status_code=413,
                    detail="Trecho da gravacao acima do limite configurado.",
                    failure_code="chunk_too_large",
                )
            except RecordingError as error:
                raise _recording_http_error(error) from error
    chunk = bytes(received)
    try:
        return await coordinator.upload(
            actor,
            recording_id,
            RecordingUpload(client_id=client_id, chunk_id=chunk_id, content=chunk),
        )
    except RecordingError as error:
        raise _recording_http_error(error) from error


@router.post("/recordings/{recording_id}/complete")
async def complete_recording(recording_id: str, request: Request, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    client_id = str(request.headers.get("X-Call-Client-Id") or "").strip()
    operation_id = str(request.headers.get("X-Recording-Operation-Id") or "complete").strip()
    if not client_id or not operation_id or len(client_id) > 120 or len(operation_id) > 120:
        raise HTTPException(status_code=400, detail="Cliente da chamada e obrigatorio.")
    try:
        return await recording_coordinator().complete(
            recording_actor(user),
            recording_id,
            RecordingComplete(client_id=client_id, operation_id=operation_id),
        )
    except RecordingError as error:
        raise _recording_http_error(error) from error


@router.delete("/recordings/{recording_id}")
async def abort_recording(recording_id: str, request: Request, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_chat(user)
    client_id = str(request.headers.get("X-Call-Client-Id") or "").strip()
    operation_id = str(request.headers.get("X-Recording-Operation-Id") or "abort").strip()
    if not client_id or not operation_id or len(client_id) > 120 or len(operation_id) > 120:
        raise HTTPException(status_code=400, detail="Cliente da chamada e obrigatorio.")
    try:
        return await recording_coordinator().abort(
            recording_actor(user),
            recording_id,
            RecordingAbort(client_id=client_id, operation_id=operation_id),
        )
    except RecordingError as error:
        raise _recording_http_error(error) from error


@router.get("/attachments/{file_name}")
async def download_attachment(file_name: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    require_team_chat(user)
    safe_file_name = Path(file_name).name
    await active_calls_snapshot(team_id_for(user))
    store = await read_pruned_chat_store(team_id_for(user))
    user_id = str(user.get("id") or "")
    visible_file = any(
        message_visible(message, user_id)
        and any(
            isinstance(attachment, dict) and str(attachment.get("storedName") or "") == safe_file_name
            for attachment in message.get("attachments", [])
        )
        for message in store.get("messages", [])
        if isinstance(message, dict)
    )
    visible_file = visible_file or any(
        user_id in call.get("joinedClients", {}) and any(
            attachment.get("storedName") == safe_file_name
            for message in call.get("meetingMessages", []) for attachment in message.get("attachments", [])
        ) for call in store.get("activeCalls", [])
    )
    if not visible_file:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    path = UPLOAD_DIR / safe_file_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    return FileResponse(path, filename=path.name)


async def handle_call_event(
    websocket: WebSocket,
    user: dict[str, Any],
    payload: dict[str, Any],
    connection_id: str | None = None,
) -> None:
    try:
        result = await call_coordinator().handle_event(call_actor(user, connection_id), payload)
    except CallError as exc:
        raise _as_http_error(exc) from exc
    for message in result.direct_messages:
        await websocket.send_json(message)


@router.websocket("/ws")
async def team_chat_ws(websocket: WebSocket, ticket: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_websocket_ticket(ticket or "")
        require_team_chat(user)
        team_id, user_id = team_id_for(user), str(user["id"])
    except Exception:
        await websocket.close(code=4401)
        return
    connection_id = await manager.connect(team_id, user_id, websocket)
    actor = call_actor(user, connection_id)
    try:
        await websocket.send_json({"type": "CONNECTED", "onlineUserIds": manager.online_users(team_id)})
        await emit_due_meeting_reminders(team_id)
        # Reconectar sincroniza a lista, nunca dispara novamente o convite/toque.
        await call_coordinator().reconcile(actor)
        calls = await call_coordinator().active_calls_for(actor)
        await websocket.send_json({
            "type": "CALLS_STATE",
            "calls": calls,
        })
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=CALL_RECONCILE_INTERVAL_SECONDS,
                )
            except asyncio.TimeoutError:
                await emit_due_meeting_reminders(team_id)
                await call_coordinator().reconcile(actor)
                if user_id not in await _call_active_member_ids(actor):
                    await websocket.close(code=4403)
                    return
                # Cada conexao reconcilia seu estado; nao multiplica snapshots
                # para toda a equipe a cada timeout de cada aba aberta.
                calls = await call_coordinator().active_calls_for(actor)
                await websocket.send_json({
                    "type": "CALLS_STATE",
                    "calls": calls,
                })
                continue
            if not raw:
                continue
            if len(raw) > 120_000:
                await websocket.send_json({
                    "type": "CALL_ERROR",
                    "code": "call_payload_too_large",
                    "status": 413,
                    "detail": "Sinal de chamada acima do limite.",
                })
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {}
            event_type = str(payload.get("type") or "") if isinstance(payload, dict) else ""
            if event_type not in CALL_EVENT_TYPES:
                await websocket.send_json({"type": "ACK", "timestamp": now_iso()})
                continue
            try:
                await handle_call_event(websocket, user, payload, connection_id)
            except HTTPException as exc:
                await websocket.send_json({
                    "type": "CALL_ERROR",
                    "callId": payload.get("callId"),
                    "code": (exc.headers or {}).get("X-Call-Error-Code", "call_error"),
                    "status": exc.status_code,
                    "detail": exc.detail,
                })
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, user_id)
        await call_coordinator().connection_closed(actor, connection_id)
        task = asyncio.create_task(_reconcile_closed_connection(actor))
        _call_reconcile_tasks.add(task)
        task.add_done_callback(_call_reconcile_tasks.discard)
        await manager.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": manager.online_users(team_id)})


def save_attachments(payloads: list[AttachmentPayload]) -> list[dict[str, Any]]:
    if len(payloads) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(status_code=400, detail=f"Envie no maximo {MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem.")
    decoded = [(payload, *decode_data_url(payload.dataUrl, payload.mimeType)) for payload in payloads]
    if sum(len(file_bytes) for _, file_bytes, _ in decoded) > MAX_ATTACHMENT_TOTAL_BYTES:
        raise HTTPException(status_code=413, detail="Os anexos da mensagem ultrapassam o limite total de 24 MB.")
    return [save_attachment_bytes(payload, file_bytes, mime_type) for payload, file_bytes, mime_type in decoded]


def save_attachment_bytes(payload: AttachmentPayload, file_bytes: bytes, mime_type: str) -> dict[str, Any]:
    safe_name = safe_upload_name(payload.fileName, mime_type)
    (UPLOAD_DIR / safe_name).write_bytes(file_bytes)
    return {
        "id": f"team_att_{uuid.uuid4().hex}",
        "name": Path(payload.fileName).name or safe_name,
        "mimeType": mime_type,
        "size": len(file_bytes),
        "url": public_api_url(f"/api/team-chat/attachments/{quote(safe_name)}"),
        "storedName": safe_name,
        "createdAt": now_iso(),
    }


def append_file_bytes(path: Path, content: bytes) -> None:
    with path.open("ab") as output:
        output.write(content)


def decode_data_url(data_url: str, fallback_mime: str) -> tuple[bytes, str]:
    match = re.match(r"^data:([^,]*),(.*)$", data_url, flags=re.DOTALL)
    if not match or "base64" not in match.group(1).lower():
        raise HTTPException(status_code=400, detail="Anexo invalido. Envie data URL base64.")
    metadata = [part for part in match.group(1).split(";") if part and part.lower() != "base64"]
    mime_type = next((part for part in metadata if "/" in part), fallback_mime or "application/octet-stream")
    file_bytes = base64.b64decode(match.group(2), validate=True)
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Anexo vazio.")
    if len(file_bytes) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Anexo acima do limite de 12 MB.")
    return file_bytes, mime_type


def safe_upload_name(file_name: str, mime_type: str) -> str:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if not suffix:
        suffix = (mimetypes.guess_extension(mime_type) or ".bin").lstrip(".")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(file_name).stem or "anexo").strip("._") or "anexo"
    return f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}_{stem[:48]}.{suffix[:12]}"
