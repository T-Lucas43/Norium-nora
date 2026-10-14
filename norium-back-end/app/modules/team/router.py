"""Dominio de equipe extraido para concentrar membros, chat e permissoes."""

from __future__ import annotations

import asyncio
import logging
import base64
import contextlib
import json
import mimetypes
import os
import re
import secrets
import time
import uuid
import weakref
import zlib
from weakref import WeakKeyDictionary
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import Field

from app.core.identity import require_team_id, require_user_id
from app.shared.schemas import StrictModel
from app.modules.team.chat_resources import ResourceRef, link_references, resolve_card
from app.core.request_context import current_workspace_id

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, read_profile_db, write_json_file
from app.infrastructure.persistence import files as persistent_files
from app.infrastructure.persistence import postgres_store
from app.infrastructure import auth_sessions as sessions
from app.infrastructure.async_session_validation import FreshSessionValidator
from app.modules.team.call_adapters import CallbackCallPublisher, CallbackTeamDirectory, JsonCallStateStore
from app.modules.team.call_configuration import mesh_max_participants_from_environment
from app.modules.team.call_release import CallReleasePolicy
from app.modules.team.call_observability import CLIENT_EVENTS, EventBudget, call_metrics
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
logger = logging.getLogger(__name__)
from app.modules.team.chat_features import router as chat_features_router, message_page
from app.modules.team import chat_queue as _chat_queue
from app.modules.team import chat_presence as _chat_presence
from app.modules.team import chat_nora as _chat_nora
router.include_router(chat_features_router)
router.include_router(_chat_nora.router)
chat_lock = asyncio.Lock()
_team_chat_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


def team_chat_lock(team_id: str) -> asyncio.Lock:
    # Called on the application event loop, without an await between lookup
    # and insertion. Holders/waiters retain the lock; inactive teams do not
    # accumulate entries. All writers to a team's document share this lock.
    key = str(Path(team_chat_path(team_id)).resolve())
    lock = _team_chat_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _team_chat_locks[key] = lock
    return lock
UPLOAD_DIR = get_data_root() / "team_chat_uploads"
if not (postgres_store.configured() or postgres_store.required()):
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
# Abaixo do tempo limite de presença na chamada (30 s).
CALL_IDLE_RECONCILE_INTERVAL_SECONDS = 25
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
    quotedMessageId: str | None = Field(default=None, max_length=150)
    replyThreadId: str | None = Field(default=None, max_length=150)
    alsoInChannel: bool = False
    resourceRefs: list[ResourceRef] = Field(default_factory=list, max_length=6)
    urgentMention: bool = False


class SendSubteamMessagePayload(StrictModel):
    text: str = Field(default="", max_length=2000)
    attachments: list[AttachmentPayload] = Field(default=[], max_length=MAX_ATTACHMENTS_PER_MESSAGE)
    mentionedUserIds: list[str] = Field(default_factory=list, max_length=100)
    quotedMessageId: str | None = Field(default=None, max_length=150)
    replyThreadId: str | None = Field(default=None, max_length=150)
    alsoInChannel: bool = False
    resourceRefs: list[ResourceRef] = Field(default_factory=list, max_length=6)
    urgentMention: bool = False


class PinThreadPayload(StrictModel):
    threadId: str = Field(min_length=1, max_length=250)
    pinned: bool


class SendMeetingMessagePayload(SendSubteamMessagePayload):
    clientId: str = Field(min_length=1, max_length=100)


class SfuTokenPayload(StrictModel):
    clientId: str = Field(min_length=1, max_length=100)


class MarkMessagesReadPayload(StrictModel):
    messageIds: list[str] = Field(default_factory=list, max_length=100)


class MessageReactionPayload(StrictModel):
    emoji: str = Field(min_length=1, max_length=24)


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
        self.socket_session_version: dict[WebSocket, int | None] = {}
        self.socket_session_id: dict[WebSocket, str] = {}
        self._connect_lock = asyncio.Lock()
        self._session_validators = WeakKeyDictionary()

    async def connect(
        self,
        team_id: str,
        user_id: str,
        websocket: WebSocket,
        connection_id: str | None = None,
        session_version: int | None = None,
        session_id: str = "",
    ) -> str:
        async with self._connect_lock:
            policy = CallReleasePolicy.from_env()
            if (len(self.socket_user) >= policy.max_sockets
                or len(self.connections.get(team_id, [])) >= policy.max_team_sockets
                or sum(value == user_id for value in self.socket_user.values()) >= policy.max_user_sockets):
                call_metrics.increment("socket_quota_errors")
                raise HTTPException(429, "Limite de conexoes da equipe atingido.")
            await websocket.accept()
            self.connections.setdefault(team_id, []).append(websocket)
            self.user_team[user_id] = team_id
            self.socket_user[websocket] = user_id
            resolved_connection_id = connection_id or uuid.uuid4().hex
            self.socket_connection[websocket] = resolved_connection_id
            self.socket_session_version[websocket] = session_version
            self.socket_session_id[websocket] = session_id
        await self.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": self.online_users(team_id)})
        return resolved_connection_id

    def disconnect(self, websocket: WebSocket, user_id: str) -> None:
        connected_user_id = self.socket_user.pop(websocket, user_id)
        self.socket_connection.pop(websocket, None)
        self.socket_session_version.pop(websocket, None)
        self.socket_session_id.pop(websocket, None)
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

    def socket_authorized(self, websocket: WebSocket, user: dict[str, Any] | None, team_id: str) -> bool:
        version = self.socket_session_version.get(websocket)
        return bool(user and user.get("status") == "ativo" and team_id_for(user) == team_id
                    and has_team_chat_access(user)
                    and (version is None or int(user.get("sessionVersion") or 0) == version))

    async def session_authorized(self, websocket: WebSocket, user: dict[str, Any] | None, team_id: str) -> bool:
        if not self.socket_authorized(websocket, user, team_id):
            return False
        try:
            binding = self.session_binding(websocket, user)
            return binding in await self.fresh_session_bindings([binding])
        except (sessions.SessionError, postgres_store.PostgresStoreError):
            return False

    async def fresh_session_bindings(self, bindings: list[tuple[str, str, int]]) -> set[tuple[str, str, int]]:
        loop = asyncio.get_running_loop()
        validator = self._session_validators.get(loop)
        if validator is None:
            validator = FreshSessionValidator(lambda requested: sessions.valid_bindings(requested))
            self._session_validators[loop] = validator
        return await validator.validate(bindings)

    def session_binding(self, websocket: WebSocket, user: dict[str, Any]) -> tuple[str, str, int]:
        return (self.socket_session_id.get(websocket, ""), str(user["id"]), int(user.get("sessionVersion") or 0))

    async def authorized_sockets(self, sockets: list[WebSocket], users: dict[str, dict], team_id: str) -> set[WebSocket]:
        candidates = {websocket: self.session_binding(websocket, users[self.socket_user[websocket]])
                      for websocket in sockets
                      if self.socket_authorized(websocket, users.get(self.socket_user.get(websocket, "")), team_id)}
        try:
            # One fresh database snapshot for this send, with full sub/SID/SV
            # binding; permission checks remain mandatory for every transport.
            valid = await self.fresh_session_bindings(list(candidates.values()))
        except (sessions.SessionError, postgres_store.PostgresStoreError):
            return set()
        return {websocket for websocket, binding in candidates.items() if binding in valid}

    async def broadcast(self, team_id: str, payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        store = await read_user_store()
        users_by_id = {
            str(item.get("id") or ""): item
            for item in store.get("users", [])
            if isinstance(item, dict)
        }
        transports = list(self.connections.get(team_id, []))
        authorized = await self.authorized_sockets(transports, users_by_id, team_id)
        for websocket in transports:
            if websocket not in authorized:
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
        store = await read_user_store()
        users_by_id = {str(item.get("id") or ""): item for item in store.get("users", []) if isinstance(item, dict)}
        transports = [websocket for websocket in list(self.connections.get(team_id, []))
                      if websocket is not exclude_websocket and self.socket_user.get(websocket, "") in user_ids]
        authorized = await self.authorized_sockets(transports, users_by_id, team_id)
        for websocket in transports:
            if websocket not in authorized:
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


def has_team_chat_access(user: dict[str, Any]) -> bool:
    # Auth resolves this from the live directory for HTTP, websocket tickets,
    # fanout and call membership. Missing capability is never an authorization.
    if not user.get("teamChatEnabled", False):
        return False
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    return bool(user.get("systemAdmin") or permissions.get("chat") or permissions.get("equipe"))


def require_team_chat(user: dict[str, Any]) -> None:
    if has_team_chat_access(user):
        return
    raise HTTPException(status_code=403, detail="Chat interno nao liberado para esta conta.")


def can_use_nora(user: dict[str, Any]) -> bool:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    return bool(user.get("systemAdmin") or permissions.get("nora"))


def team_id_for(user: dict[str, Any]) -> str:
    return require_team_id(user)


async def team_id_for_user_id(user_id: str) -> str:
    store = await read_user_store()
    user = next((item for item in store.get("users", []) if str(item.get("id")) == str(user_id)), None)
    if not user:
        return require_user_id({"id": user_id})
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
    path = Path(team_chat_path(team_id))
    postgres_enabled = postgres_store.configured() or postgres_store.required()
    if not postgres_enabled:
        try:
            path.stat()
        except FileNotFoundError:
            return empty_store()
        except PermissionError as exc:
            raise OSError("Armazenamento de chamadas inacessivel; limpeza suspensa.") from exc
        except OSError as exc:
            raise OSError("Armazenamento de chamadas indisponivel; limpeza suspensa.") from exc
    # The general repository falls back on read errors. Destructive retention
    # must distinguish a missing new store from an unreadable existing store.
    payload = read_json_file(path, None)
    if payload is None:
        return empty_store()
    if not isinstance(payload, dict):
        raise OSError("Armazenamento de chamadas ilegivel; limpeza suspensa.")
    for field in ("messages", "subteams", "recordings", "activeCalls", "scheduledMeetings"):
        items = payload.get(field, [])
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise OSError("Armazenamento de chamadas invalido; limpeza suspensa.")
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
                from app.infrastructure.storage_limits import upload_candidates
                for path in upload_candidates(UPLOAD_DIR, name, attachment.get("storageKey")):
                    persistent_files.delete(path)
async def read_pruned_chat_store(team_id: str) -> dict[str, Any]:
    async with team_chat_lock(team_id):
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


def message_visible(message: dict[str, Any], user_id: str, *, activity_check: Callable[[dict[str, Any]], bool] | None = None) -> bool:
    from app.services.task_activity import activity_visible
    metadata = message.get("metadata") or {}
    if not (activity_check(metadata) if activity_check else activity_visible(metadata, user_id)):
        return False
    if "activityRecipientIds" in message and user_id not in message["activityRecipientIds"]:
        return False
    if "privateRecipientIds" in message and user_id not in message["privateRecipientIds"]:
        return False
    if message.get("scope") == "team":
        return True
    if message.get("scope") == "subteam":
        return user_id in {str(item) for item in message.get("memberIds", [])}
    if message.get("senderId") == "nora" and metadata.get("action") == "nora_team_mention_response":
        return user_id in {str(item) for item in message.get("memberIds", [])}
    return user_id in {str(message.get("senderId")), str(message.get("recipientId"))}


def visible_messages(messages: list[dict[str, Any]], user_id: str) -> list[dict[str, Any]]:
    from app.services.task_activity import activity_visibility
    activity_check = activity_visibility(user_id)
    return [message for message in messages if isinstance(message, dict) and message_visible(message, user_id, activity_check=activity_check)]


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
    if "privateRecipientIds" in message:
        return set(message["privateRecipientIds"]) & await valid_team_member_ids(user)
    if "activityRecipientIds" in message:
        return {uid for uid in message["activityRecipientIds"] if message_visible(message, uid)} & await valid_team_member_ids(user)
    scope = str(message.get("scope") or "team")
    if scope == "team":
        return await valid_team_member_ids(user)
    if scope == "subteam":
        return {str(item) for item in message.get("memberIds", [])}
    if message.get("senderId") == "nora" and (message.get("metadata") or {}).get("action") == "nora_team_mention_response":
        return set(message.get("memberIds", [])) & await valid_team_member_ids(user)
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
        thread.update(pinned=thread["id"] in pins, unreadCount=0, mentionCount=0, lastMessage=None)
        preferences = store.get("chatNotifications", {}).get(user_id, {}).get(thread["id"], {})
        thread.update(notificationMode=preferences.get("mode", "all"), mutedUntil=preferences.get("mutedUntil"))
    visible_counts: dict[str, int] = {}
    for message in reversed(visible_messages(store.get("messages", []), user_id)):
        if message.get("replyThreadId") and user_id not in message.get("replyParticipantIds", []):
            continue
        thread = by_id.get(message.get("threadId"))
        if not thread:
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
            if user_id in (message.get("metadata") or {}).get("mentionedUserIds", []):
                thread["mentionCount"] += 1
    return {"threads": threads}


@router.patch("/threads/pin")
async def pin_thread(payload: PinThreadPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    team_id, user_id = team_id_for(user), str(user["id"])
    async with team_chat_lock(team_id):
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


def team_inbox_event_id(team_id: str, metadata: dict[str, Any] | None) -> str | None:
    message_id = str((metadata or {}).get("messageId") or "").strip()
    if not message_id:
        return None
    return f"team_{team_id}_{message_id}"


async def record_team_event(team_id: str, title: str, description: str, metadata: dict[str, Any] | None = None, *, user_ids: set[str] | None = None) -> None:
    try:
        from app.modules.team.chat_presence import notification_allowed
        settings = await asyncio.to_thread(read_chat_store, team_id) if (metadata or {}).get("action") in {"team_message_created", "team_member_mentioned"} else None
        for participant_id in sorted(user_ids if user_ids is not None else {team_id}):
            if settings is not None and not notification_allowed(settings, participant_id, metadata or {}):
                continue
            await record_event(
                source="equipe",
                title=title,
                description=description,
                metadata={**(metadata or {}), "userId": participant_id},
                event_id=team_inbox_event_id(participant_id, metadata),
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
    from app.services.task_activity import activity_projects, is_task_activity, project_visible
    metadata = dict(metadata or {})
    recipients = None
    if is_task_activity(metadata):
        references = activity_projects(user_id, metadata)
        if references is None:
            raise HTTPException(status_code=403, detail="Atividade sem projeto autorizado.")
        metadata["taskProjects"] = references
        users = (await read_user_store()).get("users", [])
        recipients = {str(item["id"]) for item in users
                      if item.get("status") == "ativo"
                      and str(item.get("teamOwnerId") or item.get("id")) == team_id
                      and all(project_visible(reference, str(item.get("id") or "")) for reference in references)}
    stored_attachments = save_attachments([
        AttachmentPayload.model_validate(item)
        for item in (attachments or [])
    ], owner_id=team_id)
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
    if recipients is not None:
        message["activityRecipientIds"] = sorted(recipients)
    async with team_chat_lock(team_id):
        store = await asyncio.to_thread(read_chat_store, team_id)
        store.setdefault("messages", []).append(message)
        await asyncio.to_thread(write_chat_store, team_id, store)
    if recipients is None:
        await manager.broadcast(team_id, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    else:
        recipients = {uid for uid in recipients if message_visible(message, uid)}
        await manager.send_to_users(team_id, recipients, {"type": "TEAM_CHAT_MESSAGE", "message": message})
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
        user_ids=recipients,
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
    raw = None
    try:
        directory = await read_user_store()
        raw = next((item for item in directory.get("users", []) if str(item.get("id")) == requester_id), None)
        if not raw or team_id_for(raw) != team_id:
            return
        await _chat_nora.respond(sanitize_user(raw), source_message["id"])
    except Exception:
        # Do not leak a private failure into the general channel or return provider details.
        try:
            if raw:
                await _chat_nora.emit_reply(sanitize_user(raw), source_message["id"],
                    "Não consegui analisar este trecho agora. Confira sua franquia de tokens ou tente novamente em instantes.", [], private=True)
        except Exception:
            logger.warning("Resposta contextual da Nora indisponível.")


@router.get("/members")
async def list_members(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    members = await visible_team_members(user)
    online_user_ids = [str(member["id"]) for member in members if member.get("online")]
    return {"teamId": team_id_for(user), "members": members, "onlineUserIds": online_user_ids}


def _shared_with_member(item: dict[str, Any], member_id: str) -> bool:
    if str(item.get("createdBy") or item.get("ownerId") or "") == member_id:
        return True
    access = item.get("access") if isinstance(item.get("access"), dict) else {}
    return any(
        isinstance(person, dict) and str(person.get("userId") or "") == member_id
        for person in access.get("people", [])
    )


@router.get("/members/{member_id}/profile")
async def member_profile(member_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Perfil colaborativo limitado ao que o solicitante ja pode visualizar."""
    members = await visible_team_members(user)
    member = next((item for item in members if str(item.get("id") or "") == member_id), None)
    if not member:
        raise HTTPException(404, "Membro nao encontrado nesta equipe.")

    from app.modules.auth.router import find_team, sanitize_team, team_id_for_user
    from app.modules.clients.access import list_accessible_clients
    from app.modules.commercial.service import list_commercial_data
    from app.modules.tasks.router import member_matches_task, tenant_id
    from app.services.task_store import list_tasks

    store = await read_user_store()
    team = find_team(store, team_id_for_user(user))
    tasks = list_tasks(tenant_id(user), status="todas").get("tasks", [])
    pending_tasks = [
        {
            "id": item.get("id"), "title": item.get("title") or "Tarefa",
            "status": item.get("status") or "pendente", "priority": item.get("priority") or "media",
            "dueDate": item.get("dueDate"), "projectId": item.get("projectId"),
        }
        for item in tasks
        if item.get("status") != "concluida" and member_matches_task(member, item)
    ][:20]

    accessible_clients = await list_accessible_clients(user)
    clients = [
        {
            "id": item.get("id"), "name": item.get("name") or item.get("company") or "Cliente",
            "company": item.get("company") or "", "access": item.get("access") or {},
        }
        for _store_id, item in accessible_clients
        if _shared_with_member(item, member_id)
    ][:20]

    commercial = await list_commercial_data(user)
    proposals = [item for item in commercial.get("proposals", []) if _shared_with_member(item, member_id)][:20]
    documents = [
        item for item in [*commercial.get("contracts", []), *commercial.get("uploadedDocuments", [])]
        if _shared_with_member(item, member_id)
    ][:20]

    return {
        "member": member,
        "team": sanitize_team(store, team) if team else None,
        "pendingTasks": pending_tasks,
        "sharedClients": clients,
        "sharedProposals": proposals,
        "sharedDocuments": documents,
        "counts": {
            "pendingTasks": len(pending_tasks), "clients": len(clients),
            "proposals": len(proposals), "documents": len(documents),
        },
    }


async def _call_active_member_ids(actor: CallActor) -> set[str]:
    store = await read_user_store()
    return {
        str(item.get("id") or "")
        for item in store.get("users", [])
        if isinstance(item, dict)
        and item.get("status") == "ativo"
        and team_id_for(item) == actor.team_id
        and has_team_chat_access(item)
        and str(item.get("id") or "")
    }


async def _call_subteam_member_ids(actor: CallActor, subteam_id: str) -> set[str] | None:
    async with team_chat_lock(actor.team_id):
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
    # A permission check may close the last socket before its periodic loop can
    # reconcile. Revocation is immediate; only transport loss gets the grace.
    disconnected_at = time.monotonic()
    await call_coordinator().reconcile(actor)
    remaining_grace = max(
        0.0,
        PARTICIPANT_DISCONNECT_GRACE.total_seconds() - (time.monotonic() - disconnected_at),
    )
    if remaining_grace:
        await asyncio.sleep(remaining_grace)
    await call_coordinator().reconcile(actor)


def call_coordinator() -> CallCoordinator:
    require_call_workspace()
    global _call_coordinator_instance
    if _call_coordinator_instance is None:
        store = JsonCallStateStore(
            read_document=lambda team_id: read_chat_store(team_id),
            write_document=lambda team_id, document: write_chat_store(team_id, document),
            lock=chat_lock,
            lock_for_team=team_chat_lock,
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
            release_policy=CallReleasePolicy.from_env,
        )
    return _call_coordinator_instance


def require_call_workspace() -> None:
    # Signaling and cached state use primary; secondary HTTP must not replace it.
    if current_workspace_id() != "primary":
        raise HTTPException(409, "Chamadas disponiveis somente no workspace principal.")


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
    if current_workspace_id() != "primary":
        return []
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
    require_call_workspace()
    no_store_headers = {"Cache-Control": "no-store, private", "Pragma": "no-cache"}
    try:
        document = turn_credential_provider().issue(
            TurnSubject(team_id=team_id_for(user), user_id=str(user["id"]))
        )
    except TurnUnavailableError as exc:
        call_metrics.increment("turn_errors")
        raise HTTPException(
            status_code=503,
            detail="O serviço TURN está temporariamente indisponível.",
            headers=no_store_headers,
        ) from exc
    response.headers.update(no_store_headers)
    call_metrics.increment("turn_issued")
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
        call_metrics.increment("sfu_errors")
        raise HTTPException(
            status_code=503,
            detail="O transporte de mídia está temporariamente indisponível.",
            headers=no_store_headers,
        ) from exc
    response.headers.update(no_store_headers)
    call_metrics.increment("sfu_token_issued")
    return document.as_payload()


def call_resource_gauges() -> dict[str, int]:
    policy = CallReleasePolicy.from_env()
    return {**call_coordinator().resource_counts(), "active_sockets": len(manager.socket_user),
            "call_limit": policy.max_total_calls, "socket_limit": policy.max_sockets}


@router.get("/calls/metrics", include_in_schema=False)
async def get_call_metrics(request: Request) -> Response:
    expected = os.getenv("TEAM_CALL_METRICS_TOKEN", "")
    supplied = request.headers.get("Authorization", "")
    if request.query_params or not expected or not secrets.compare_digest(supplied.encode(), ("Bearer " + expected).encode()):
        raise HTTPException(404, "Nao encontrado.", headers={"Cache-Control": "no-store"})
    return Response(call_metrics.prometheus(call_resource_gauges()),
                    media_type="text/plain; version=0.0.4", headers={"Cache-Control": "no-store"})


@router.get("/calls/configuration")
async def get_call_configuration(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    policy = CallReleasePolicy.from_env()
    primary = current_workspace_id() == "primary"
    return {"newCallsEnabled": primary and policy.allows_new_call(team_id_for(user)),
            "recordingEnabled": primary and policy.recording_enabled,
            "mediaTransport": "mesh", "maxParticipants": mesh_max_participants_from_environment()}


@router.delete("/calls/{call_id}")
async def delete_active_call(call_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    try:
        return await call_coordinator().end_call(call_actor(user), call_id)
    except CallError as exc:
        raise _as_http_error(exc) from exc


def require_joined_call(store: dict[str, Any], call_id: str, user_id: str, client_id: str) -> dict[str, Any]:
    require_call_workspace()
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
    async with team_chat_lock(team_id):
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
    async with team_chat_lock(team_id):
        store = await asyncio.to_thread(read_chat_store, team_id)
        call = require_joined_call(store, call_id, user_id, payload.clientId)
        messages = call.setdefault("meetingMessages", [])
        if len(messages) >= 500:
            raise HTTPException(status_code=409, detail="O chat desta reunião atingiu o limite de 500 mensagens.")
        message = {"id": f"meeting_msg_{uuid.uuid4().hex}", "callId": call_id,
                   "senderId": user_id, "senderName": str(user.get("nome") or "Membro"),
                   "text": payload.text.strip(), "createdAt": now_iso(),
                   "attachments": await asyncio.to_thread(save_attachments, payload.attachments, owner_id=team_id)}
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
    async with team_chat_lock(team_id):
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
    async with team_chat_lock(team_id):
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
    limit: int | None = None,
    before: str | None = None,
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    store = await read_pruned_chat_store(team_id_for(user))
    await thread_participant_ids(user, store, scope, recipientId)
    thread_id = normalize_thread_id(scope, user_id, recipientId)
    messages = [
        item for item in visible_messages(store.get("messages", []), user_id)
        if item.get("threadId") == thread_id and (not item.get("replyThreadId") or item.get("alsoInChannel"))
    ]
    return {"threadId": thread_id, **message_page(messages, limit, before)}


@router.get("/subteams/{subteam_id}/messages")
async def list_subteam_messages(subteam_id: str, user: dict[str, Any] = Depends(current_user), limit: int | None = None, before: str | None = None) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    store = await read_pruned_chat_store(team_id_for(user))
    await thread_participant_ids(user, store, "subteam", subteam_id=subteam_id)
    thread_id = normalize_thread_id("subteam", user_id, None, subteam_id)
    messages = [
        item for item in visible_messages(store.get("messages", []), user_id)
        if item.get("threadId") == thread_id and (not item.get("replyThreadId") or item.get("alsoInChannel"))
    ]
    return {"threadId": thread_id, **message_page(messages, limit, before)}


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
    async with team_chat_lock(team_id):
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


@router.post("/messages/{message_id}/reactions")
async def toggle_message_reaction(
    message_id: str,
    payload: MessageReactionPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user.get("id") or "")
    emoji = payload.emoji.strip()
    if not emoji or any(character.isalnum() for character in emoji):
        raise HTTPException(status_code=400, detail="Selecione um emoji valido.")

    team_id = team_id_for(user)
    reactions: list[dict[str, Any]] = []
    recipients: set[str] = set()
    async with team_chat_lock(team_id):
        store = await asyncio.to_thread(read_chat_store, team_id)
        message = next(
            (
                item for item in store.get("messages", [])
                if isinstance(item, dict) and str(item.get("id") or "") == message_id
            ),
            None,
        )
        if not message or not message_visible(message, user_id):
            raise HTTPException(status_code=404, detail="Mensagem nao encontrada.")
        recipients = await message_participant_ids(message, user, store)
        if user_id not in recipients:
            raise HTTPException(status_code=403, detail="Voce nao participa desta conversa.")

        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        stored_reactions = metadata.get("reactions") if isinstance(metadata.get("reactions"), list) else []
        normalized: list[dict[str, Any]] = []
        target_found = False
        for item in stored_reactions:
            if not isinstance(item, dict):
                continue
            item_emoji = str(item.get("emoji") or "").strip()
            user_ids = sorted({str(value) for value in item.get("userIds", []) if str(value) in recipients})
            if not item_emoji:
                continue
            if item_emoji == emoji:
                target_found = True
                if user_id in user_ids:
                    user_ids.remove(user_id)
                else:
                    user_ids.append(user_id)
                    user_ids.sort()
            if user_ids:
                normalized.append({"emoji": item_emoji, "userIds": user_ids})
        if not target_found:
            normalized.append({"emoji": emoji, "userIds": [user_id]})
        reactions = normalized
        message["metadata"] = {**metadata, "reactions": reactions}
        await asyncio.to_thread(write_chat_store, team_id, store)

    await manager.send_to_users(
        team_id,
        recipients,
        {"type": "TEAM_MESSAGE_REACTION", "messageId": message_id, "reactions": reactions},
    )
    return {"messageId": message_id, "reactions": reactions}


async def persist_message(
    *,
    scope: str,
    recipient_id: str | None,
    subteam_id: str | None,
    text: str,
    attachment_payloads: list[AttachmentPayload],
    user: dict[str, Any],
    mentioned_user_ids: list[str] | None = None,
    activity_metadata: dict[str, Any] | None = None,
    quoted_message_id: str | None = None,
    reply_thread_id: str | None = None,
    also_in_channel: bool = False,
    resource_refs: list[dict] | None = None,
    poll_data: dict | None = None,
    forwarded_message_id: str | None = None,
    urgent_mention: bool = False,
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    if not text.strip() and not attachment_payloads:
        raise HTTPException(status_code=400, detail="Digite uma mensagem ou anexe um arquivo.")

    team_id = team_id_for(user)
    store = await asyncio.to_thread(read_chat_store, team_id)
    participant_ids = await thread_participant_ids(user, store, scope, recipient_id, subteam_id)
    activity_metadata = dict(activity_metadata or {})
    if activity_metadata:
        from app.services.task_activity import activity_projects, project_visible
        references = activity_projects(user_id, activity_metadata)
        if not references or not all(project_visible(reference, participant)
                                     for participant in participant_ids for reference in references):
            raise HTTPException(status_code=403, detail="Atividade sem projeto autorizado para os participantes.")
        activity_metadata["taskProjects"] = references
    mentions = await validated_mentions(text, mentioned_user_ids or [], participant_ids, user)
    mentioned_ids = {item["userId"] for item in mentions} - {user_id}
    thread_id = normalize_thread_id(scope, user_id, recipient_id, subteam_id)
    quote = None
    refs = list(resource_refs or []) + link_references(text)
    refs = [ref for i, ref in enumerate(refs) if ref not in refs[:i]][:6]
    for ref in refs:
        if (await resolve_card(ref, user)).get("restricted"):
            raise HTTPException(400, "Um item compartilhado não está disponível para sua conta.")
    if quoted_message_id:
        from app.modules.team.chat_features import authorized_message
        original = await authorized_message(user, store, quoted_message_id)
        if original.get("threadId") != thread_id or (original.get("metadata") or {}).get("deletedAt"):
            raise HTTPException(400, "Cite uma mensagem disponível nesta conversa.")
        quote = original["id"]
    attachments = save_attachments(attachment_payloads, owner_id=team_id)
    nora_mentioned = has_nora_mention(text)
    nora_triggered = nora_mentioned and can_use_nora(user) and _chat_nora.enabled(store, {"scope": scope, "subteamId": subteam_id})
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
        "quotedMessageId": quote,
        "resourceRefs": refs,
        "metadata": {
            **activity_metadata,
            "noraMentioned": nora_mentioned,
            "noraTriggered": nora_triggered,
            "readBy": {},
            "mentions": mentions,
            "mentionedUserIds": sorted(mentioned_ids),
            "urgentMention": urgent_mention,
        },
        "createdAt": now_iso(),
    }
    async with team_chat_lock(team_id):
        store = await asyncio.to_thread(read_chat_store, team_id)
        # Revalidate membership and source under the same mutation lock.
        participant_ids = await thread_participant_ids(user, store, scope, recipient_id, subteam_id)
        if poll_data is not None:
            message["metadata"]["poll"] = poll_data
        if forwarded_message_id:
            from app.modules.team.chat_features import authorized_message
            source = await authorized_message(user, store, forwarded_message_id)
            if (source.get("metadata") or {}).get("deletedAt"):
                raise HTTPException(404, "Mensagem indisponível.")
            # References to the same authenticated blobs become visible through
            # the newly authorized conversation, without a public URL or copy.
            message["attachments"] = list(source.get("attachments") or [])
            message["metadata"]["forwardedFromMessageId"] = source["id"]
        notification_ids = participant_ids
        if quoted_message_id or reply_thread_id:
            from app.modules.team.chat_features import authorized_message, reply_participants
            for source_id in {quoted_message_id, reply_thread_id} - {None}:
                source = await authorized_message(user, store, source_id)
                if source.get("threadId") != thread_id or (source.get("metadata") or {}).get("deletedAt"):
                    raise HTTPException(400, "Mensagem de origem indisponível nesta conversa.")
            if reply_thread_id:
                root = await authorized_message(user, store, reply_thread_id)
                if root.get("replyThreadId"):
                    raise HTTPException(400, "Responda ao fio original.")
                replies = [item for item in store["messages"] if item.get("replyThreadId") == reply_thread_id]
                participant_ids &= await message_participant_ids(root, user, store)
                if "activityRecipientIds" in root or "privateRecipientIds" in root:
                    message["privateRecipientIds"] = sorted(participant_ids)
                notification_ids = reply_participants(root, replies, mentioned_ids, user_id) & participant_ids
                message.update(replyThreadId=reply_thread_id, alsoInChannel=also_in_channel, replyParticipantIds=sorted(notification_ids))
                # A caller-only Nora reply must not appear in counters/avatars
                # broadcast to participants who cannot read it.
                shared_replies = [item for item in replies if all(message_visible(item, uid) for uid in participant_ids)]
                root.setdefault("metadata", {}).update(replyCount=len(shared_replies)+1, lastReplyAt=message["createdAt"], replyUserIds=sorted({user_id} | {str(item.get("senderId")) for item in shared_replies}))
        store.setdefault("messages", []).append(message)
        await asyncio.to_thread(write_chat_store, team_id, store)

    if reply_thread_id:
        await manager.send_to_users(team_id, await message_participant_ids(root, user, store), {"type": "TEAM_CHAT_MESSAGE", "message": root})

    if activity_metadata:
        participant_ids = {participant for participant in participant_ids if message_visible(message, participant)}
    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await record_team_event(
        team_id,
        "Mensagem no chat interno" if scope == "team" else "Mensagem na subequipe" if scope == "subteam" else "Mensagem direta no chat interno",
        (
            f"{message['senderName']}: {short_text(message['text'])}. "
            f"Anexos: {len(attachments)}."
        ),
        {
            **activity_metadata,
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
            "urgentMention": urgent_mention,
        },
        user_ids=notification_ids - mentioned_ids,
    )
    if mentioned_ids:
        await record_team_event(
            team_id, f"{message['senderName']} mencionou você", short_text(message["text"], 300),
            {**activity_metadata, "action": "team_member_mentioned", "messageId": message["id"], "senderId": user_id,
             "senderName": message["senderName"], "threadId": thread_id, "scope": scope,
             "recipientId": recipient_id, "subteamId": subteam_id, "mentionedUserIds": sorted(mentioned_ids), "urgentMention": urgent_mention},
            user_ids=mentioned_ids,
        )
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
        quoted_message_id=payload.quotedMessageId,
        reply_thread_id=payload.replyThreadId,
        also_in_channel=payload.alsoInChannel,
        resource_refs=[ref.model_dump() for ref in payload.resourceRefs],
        urgent_mention=payload.urgentMention,
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
        quoted_message_id=payload.quotedMessageId,
        reply_thread_id=payload.replyThreadId,
        also_in_channel=payload.alsoInChannel,
        resource_refs=[ref.model_dump() for ref in payload.resourceRefs],
        urgent_mention=payload.urgentMention,
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
    async with team_chat_lock(team_id):
        current_store = await asyncio.to_thread(read_chat_store, team_id)
        current_store.setdefault("scheduledMeetings", []).append(meeting)
        current_store["scheduledMeetings"] = current_store["scheduledMeetings"][-500:]
        current_store.setdefault("messages", []).append(message)
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
    async with team_chat_lock(team_id):
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
    async with team_chat_lock(team_id):
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
    if action in titles:
        call_metrics.increment(action)
    # Private-call audits must not expose call identifiers to the whole team.
    document = await read_pruned_chat_store(team_id)
    recording = next((item for item in document.get("recordings", [])
                      if item.get("id") == metadata.get("recordingId")), {})
    recipients = {str(item) for item in recording.get("participantIds", [])}
    if not recipients:
        recipients = {str(metadata.get("actorId") or "")} - {""}
    await record_team_event(
        team_id,
        titles.get(action, "Evento de gravacao de reuniao"),
        "Evento de ciclo de vida da gravacao, sem conteudo de audio ou video.",
        {"action": action, **metadata},
        user_ids=recipients,
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
    require_call_workspace()
    global _recording_coordinator_instance
    if _recording_coordinator_instance is None:
        _recording_coordinator_instance = RecordingCoordinator(
            store=JsonRecordingStore(
                read_document=read_chat_store,
                write_document=write_chat_store,
                lock=chat_lock,
                lock_for_team=team_chat_lock,
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
    call_metrics.increment("recording_http_errors")
    if error.status_code in {413, 429}:
        call_metrics.increment("recording_quota_errors")
    return HTTPException(status_code=error.status_code, detail=error.detail)


async def _recording_team_ids() -> list[str]:
    store = await read_user_store()
    teams = {
        team_id_for(user)
        for user in store.get("users", [])
        if isinstance(user, dict) and str(user.get("id") or "")
    }
    # Retention must continue after the last account of a team is removed. The
    # inventory must use the same authoritative backend as the document store.
    if postgres_store.configured() or postgres_store.required():
        keys = await asyncio.to_thread(postgres_store.list_document_keys, "user_")
        persisted = {
            parts[0].removeprefix("user_")
            for key in keys
            if (parts := Path(key).parts) and len(parts) == 2 and parts[1] == "team_chat_db.json"
        }
    else:
        persisted = await asyncio.to_thread(lambda: {
            path.parent.name.removeprefix("user_")
            for path in get_data_root().glob("user_*/team_chat_db.json")
            if path.is_file() and not path.is_symlink() and not path.parent.is_symlink()
        })
    return sorted(teams | persisted)


async def _recording_inventory_complete() -> bool:
    if postgres_store.configured() or postgres_store.required():
        keys = await asyncio.to_thread(postgres_store.list_document_keys, "user_")
        return not any(
            len(parts := Path(key).parts) == 3
            and parts[1].startswith("workspace_")
            and parts[2] == "team_chat_db.json"
            for key in keys
        )
    return not await asyncio.to_thread(lambda: any(
        get_data_root().glob("user_*/workspace_*/team_chat_db.json")))


async def _recording_maintenance_loop() -> None:
    while True:
        try:
            inventory_complete = await _recording_inventory_complete()
            result = await recording_coordinator().maintain(
                await _recording_team_ids(), inventory_complete=inventory_complete)
            call_metrics.increment("cleanup_runs")
            for field, metric in (("expiredActive", "cleanup_expired_active"),
                                  ("deletedCompleted", "cleanup_deleted_completed"),
                                  ("deletedOrphans", "cleanup_deleted_orphans")):
                call_metrics.increment(metric, result[field])
        except asyncio.CancelledError:
            raise
        except Exception:
            call_metrics.increment("cleanup_errors")
        call_metrics.log_snapshot(call_resource_gauges())
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
    if not CallReleasePolicy.from_env().recording_enabled:
        raise HTTPException(503, "Novas gravacoes estao temporariamente indisponiveis.")
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
async def download_attachment(file_name: str, user: dict[str, Any] = Depends(current_user), preview: bool = False) -> Response:
    require_team_chat(user)
    safe_file_name = Path(file_name).name
    await active_calls_snapshot(team_id_for(user))
    store = await read_pruned_chat_store(team_id_for(user))
    user_id = str(user.get("id") or "")
    recording = next((item for item in store.get("recordings", [])
                      if item.get("storedName") == safe_file_name), None)
    recording_attachment = any(
        isinstance(attachment, dict) and attachment.get("storedName") == safe_file_name
        and attachment.get("recordingId")
        for message in store.get("messages", []) if isinstance(message, dict)
        for attachment in message.get("attachments", [])
    )
    if recording is None and (recording_attachment or safe_file_name.startswith("team-recording-")):
        # Legacy pruning may have discarded the authority/retention record.
        # A visible chat attachment cannot substitute for that authorization.
        raise HTTPException(404, "Anexo nao encontrado.")
    if recording is not None:
        require_call_workspace()
        expires_at = parse_iso_datetime(recording.get("expiresAt"))
        if (recording.get("status") != "completed" or expires_at is None
            or expires_at <= datetime.now(timezone.utc)
            or user_id not in recording.get("participantIds", [])):
            raise HTTPException(404, "Anexo nao encontrado.")
        if recording.get("subteamId"):
            subteam = subteam_or_404(store, str(recording["subteamId"]))
            require_subteam_member(subteam, user_id)
    allowed_threads = {item["id"] for item in await accessible_threads(user, store)}
    visible_file = any(
        message_visible(message, user_id)
        and message.get("threadId") in allowed_threads
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
    pending_attachments = [attachment for job in store.get("chatScheduled", []) if job.get("authorId") == user_id and job.get("state") == "pending" for attachment in job.get("message", {}).get("attachments", [])]
    visible_file = visible_file or any(attachment.get("storedName") == safe_file_name for attachment in pending_attachments)
    if not visible_file:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    from app.infrastructure.storage_limits import resolve_upload_path
    records = [attachment for message in store.get("messages", []) for attachment in message.get("attachments", [])]
    records += pending_attachments
    records += [attachment for call in store.get("activeCalls", []) for message in call.get("meetingMessages", []) for attachment in message.get("attachments", [])]
    metadata = next((item for item in records if item.get("storedName") == safe_file_name), {})
    path = resolve_upload_path(UPLOAD_DIR, safe_file_name, metadata.get("storageKey"))
    if path is None:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    if not persistent_files.exists(path):
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    headers = {"Content-Disposition": f'attachment; filename="{path.name}"', "Cache-Control": "no-store, private"}
    if preview:
        from app.modules.team.chat_thumbnails import thumbnail
        data = await asyncio.to_thread(persistent_files.read, path)
        return Response(await asyncio.to_thread(thumbnail, data), media_type="image/webp", headers={"Cache-Control": "no-store, private"})
    if not (postgres_store.configured() or postgres_store.required()):
        return FileResponse(path, media_type="application/octet-stream", headers=headers)
    return Response(persistent_files.read(path), media_type="application/octet-stream",
                    headers=headers)


async def send_actor_payload(websocket: WebSocket, user: dict[str, Any], payload: dict[str, Any]) -> None:
    """Check the authoritative identity again after awaited call processing."""
    directory = await read_user_store()
    live_user = next((item for item in directory.get("users", []) if str(item.get("id")) == str(user["id"])), None)
    bound_user_id = manager.socket_user.get(websocket, str(user["id"]))
    bound_team = manager.user_team.get(bound_user_id, team_id_for(user))
    permitted = bool(bound_user_id == str(user["id"]) and manager.socket_authorized(websocket, live_user, bound_team))
    if permitted:
        try:
            binding = (manager.socket_session_id.get(websocket, str(user.get("_authSession") or "")),
                       str(live_user["id"]), int(live_user.get("sessionVersion") or 0))
            permitted = binding in await manager.fresh_session_bindings([binding])
        except (sessions.SessionError, postgres_store.PostgresStoreError):
            permitted = False
    if not permitted:
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=4403)
        raise WebSocketDisconnect(code=4403)
    await websocket.send_json(payload)


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
        await send_actor_payload(websocket, user, message)


@router.websocket("/ws")
async def team_chat_ws(websocket: WebSocket, ticket: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_websocket_ticket(ticket or "")
        require_team_chat(user)
        team_id, user_id = team_id_for(user), str(user["id"])
    except Exception:
        await websocket.close(code=4401)
        return
    try:
        connection_id = await manager.connect(team_id, user_id, websocket,
                                              session_version=int(user.get("sessionVersion") or 0),
                                              session_id=str(user.get("_authSession") or ""))
    except HTTPException:
        await websocket.close(code=1013)
        return
    actor = call_actor(user, connection_id)
    message_budget = EventBudget(240, 60)
    telemetry_budget = EventBudget(20, 1 / 3)
    # Conexoes abertas em lote nao devem disputar o mesmo lock e gravar o
    # estado persistente no mesmo instante. Espalhar o primeiro keepalive pelo
    # intervalo preserva a janela de heartbeat e evita starvation da tarefa que
    # remove uma conexao encerrada depois da tolerancia definida.
    reconcile_window_ms = max(1, int(CALL_RECONCILE_INTERVAL_SECONDS * 1000))
    reconcile_phase = (zlib.crc32(connection_id.encode("utf-8")) % reconcile_window_ms) / 1000
    next_reconcile = time.monotonic() + CALL_RECONCILE_INTERVAL_SECONDS + reconcile_phase
    try:
        await send_actor_payload(websocket, user, {"type": "CONNECTED", "onlineUserIds": manager.online_users(team_id)})
        await emit_due_meeting_reminders(team_id)
        # Reconectar sincroniza a lista, nunca dispara novamente o convite/toque.
        calls = await call_coordinator().active_calls_for(actor)
        await send_actor_payload(websocket, user, {
            "type": "CALLS_STATE",
            "calls": calls,
        })
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=min(5, max(0.01, next_reconcile - time.monotonic())),
                )
            except asyncio.TimeoutError:
                await emit_due_meeting_reminders(team_id)
                live_directory = await read_user_store()
                live_user = next((item for item in live_directory.get("users", []) if str(item.get("id")) == user_id), None)
                if not await manager.session_authorized(websocket, live_user, team_id):
                    # A broadcast may already have closed this transport after
                    # revocation. Closing again must not turn normal cleanup
                    # into an ASGI application error.
                    with contextlib.suppress(RuntimeError):
                        await websocket.close(code=4403)
                    return
                # O socket vivo tambem comprova presenca. Timers do navegador
                # podem ser reduzidos em abas em segundo plano e nao devem
                # encerrar uma reuniao ainda conectada.
                await call_coordinator().keepalive_connection(actor)
                await call_coordinator().reconcile(actor)
                # Cada conexao reconcilia seu estado; nao multiplica snapshots
                # para toda a equipe a cada timeout de cada aba aberta.
                calls = await call_coordinator().active_calls_for(actor)
                await send_actor_payload(websocket, user, {
                    "type": "CALLS_STATE",
                    "calls": calls,
                })
                # Sem chamada ativa, a reconciliação espaça para poupar banco e CPU;
                # convites e revogações continuam chegando na hora por broadcast.
                next_reconcile = time.monotonic() + (CALL_RECONCILE_INTERVAL_SECONDS if calls else CALL_IDLE_RECONCILE_INTERVAL_SECONDS)
                continue
            if not raw:
                continue
            live_directory = await read_user_store()
            live_user = next((item for item in live_directory.get("users", []) if str(item.get("id")) == user_id), None)
            if not await manager.session_authorized(websocket, live_user, team_id):
                with contextlib.suppress(RuntimeError):
                    await websocket.close(code=4403)
                return
            user = live_user
            if not message_budget.take():
                call_metrics.increment("socket_rate_errors")
                await websocket.close(code=1008)
                return
            if len(raw) > 120_000:
                await send_actor_payload(websocket, user, {
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
            if event_type.startswith("CALL_"):
                # Atividade de chamada volta a reconciliação ao ritmo curto imediatamente.
                next_reconcile = min(next_reconcile, time.monotonic() + CALL_RECONCILE_INTERVAL_SECONDS)
            if event_type == "CALL_TELEMETRY":
                try:
                    if (not telemetry_budget.take()
                        or set(payload) - {"type", "callId", "clientId", "event", "durationMs"}
                        or payload.get("event") not in CLIENT_EVENTS
                        or not isinstance(payload.get("clientId"), str)
                        or not 1 <= len(payload["clientId"]) <= 100):
                        raise ValueError("Invalid telemetry")
                    context = await call_coordinator().recording_context(
                        actor, str(payload.get("callId") or ""), payload["clientId"], require_host=False,
                    )
                    if context["participantSessions"][user_id].get("connectionId") != connection_id:
                        raise ValueError("Stale connection")
                    call_metrics.client_event(payload["event"], payload.get("durationMs"))
                except (ValueError, TypeError, CallError):
                    call_metrics.increment("telemetry_rejected")
                continue
            if event_type not in CALL_EVENT_TYPES:
                await send_actor_payload(websocket, user, {"type": "ACK", "timestamp": now_iso()})
                continue
            try:
                await handle_call_event(websocket, user, payload, connection_id)
            except HTTPException as exc:
                await send_actor_payload(websocket, user, {
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


def save_attachments(payloads: list[AttachmentPayload], *, owner_id: str = "") -> list[dict[str, Any]]:
    if len(payloads) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(status_code=400, detail=f"Envie no maximo {MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem.")
    decoded = [(payload, *decode_data_url(payload.dataUrl, payload.mimeType)) for payload in payloads]
    if sum(len(file_bytes) for _, file_bytes, _ in decoded) > MAX_ATTACHMENT_TOTAL_BYTES:
        raise HTTPException(status_code=413, detail="Os anexos da mensagem ultrapassam o limite total de 24 MB.")
    return [save_attachment_bytes(payload, file_bytes, mime_type, owner_id=owner_id) for payload, file_bytes, mime_type in decoded]


def save_attachment_bytes(payload: AttachmentPayload, file_bytes: bytes, mime_type: str, *, owner_id: str = "") -> dict[str, Any]:
    safe_name = safe_upload_name(payload.fileName, mime_type)
    from app.infrastructure.storage_limits import owned_upload_path, upload_storage_key
    path = owned_upload_path(UPLOAD_DIR, owner_id, safe_name) if owner_id else UPLOAD_DIR / safe_name
    persistent_files.write(path, file_bytes, content_type=mime_type)
    return {
        "id": f"team_att_{uuid.uuid4().hex}",
        "name": Path(payload.fileName).name or safe_name,
        "mimeType": mime_type,
        "size": len(file_bytes),
        "url": public_api_url(f"/api/team-chat/attachments/{quote(safe_name)}"),
        "storedName": safe_name,
        "storageKey": upload_storage_key(UPLOAD_DIR, path),
        "createdAt": now_iso(),
    }


def append_file_bytes(path: Path, content: bytes) -> None:
    try:
        current = persistent_files.read(path)
    except FileNotFoundError:
        current = b""
    persistent_files.write(path, current + content)


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
