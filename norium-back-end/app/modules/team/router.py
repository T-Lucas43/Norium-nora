"""Dominio de equipe extraido para concentrar membros, chat e permissoes."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import Field

from app.shared.schemas import StrictModel

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, read_profile_db, write_json_file
from app.modules.team.nora_mentions import generate_team_reply, has_nora_mention
from app.routers.auth_router import current_user, read_user_store, sanitize_user, user_from_websocket_ticket
from app.routers.inbox_router import record_event

router = APIRouter(prefix="/api/team-chat", tags=["Chat interno"])
chat_lock = asyncio.Lock()
UPLOAD_DIR = get_data_root() / "team_chat_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
MAX_RECORDING_CHUNK_BYTES = 16 * 1024 * 1024
MAX_RECORDING_BYTES = 512 * 1024 * 1024
RECORDING_RETENTION_HOURS = 24

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
    attachments: list[AttachmentPayload] = []


class SendSubteamMessagePayload(StrictModel):
    text: str = Field(default="", max_length=2000)
    attachments: list[AttachmentPayload] = []


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
    scope: Literal["team", "direct", "subteam"] = "team"
    recipientId: str | None = None
    subteamId: str | None = None
    mimeType: str = Field(default="video/webm", max_length=120)


class PresenceManager:
    def __init__(self) -> None:
        self.connections: dict[str, list[WebSocket]] = {}
        self.user_team: dict[str, str] = {}
        self.socket_user: dict[WebSocket, str] = {}

    async def connect(self, team_id: str, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.setdefault(team_id, []).append(websocket)
        self.user_team[user_id] = team_id
        self.socket_user[websocket] = user_id
        await self.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": self.online_users(team_id)})

    def disconnect(self, websocket: WebSocket, user_id: str) -> None:
        connected_user_id = self.socket_user.pop(websocket, user_id)
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

    async def send_to_users(self, team_id: str, user_ids: set[str], payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        store = await read_user_store()
        users_by_id = {
            str(item.get("id") or ""): item
            for item in store.get("users", [])
            if isinstance(item, dict)
        }
        for websocket in list(self.connections.get(team_id, [])):
            connected_user_id = self.socket_user.get(websocket, "")
            if connected_user_id not in user_ids:
                continue
            connected_user = users_by_id.get(connected_user_id)
            if not connected_user or connected_user.get("status") != "ativo" or team_id_for(connected_user) != team_id:
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


def purge_expired_recordings(store: dict[str, Any]) -> bool:
    """Remove os arquivos vencidos e conserva no chat apenas o aviso de expiracao."""
    changed = False
    current_time = datetime.now(timezone.utc)
    for message in store.get("messages", []):
        if not isinstance(message, dict):
            continue
        kept_attachments: list[dict[str, Any]] = []
        expired_recording = False
        for attachment in message.get("attachments", []):
            if not isinstance(attachment, dict):
                continue
            expires_at = parse_iso_datetime(attachment.get("expiresAt"))
            if expires_at and expires_at <= current_time:
                stored_name = Path(str(attachment.get("storedName") or "")).name
                if stored_name:
                    (UPLOAD_DIR / stored_name).unlink(missing_ok=True)
                expired_recording = True
                changed = True
                continue
            kept_attachments.append(attachment)
        if expired_recording:
            message["attachments"] = kept_attachments
            metadata = message.setdefault("metadata", {})
            if isinstance(metadata, dict):
                metadata["recordingExpired"] = True
            message["text"] = "A gravacao desta reuniao expirou apos 24 horas."

    for recording in store.get("recordings", []):
        if not isinstance(recording, dict) or recording.get("status") != "recording":
            continue
        started_at = parse_iso_datetime(recording.get("startedAt"))
        if started_at and started_at + timedelta(hours=6) <= current_time:
            temp_name = Path(str(recording.get("tempStoredName") or "")).name
            if temp_name:
                (UPLOAD_DIR / temp_name).unlink(missing_ok=True)
            recording["status"] = "aborted"
            recording["abortedAt"] = now_iso()
            changed = True
    return changed


def purge_stale_active_calls(store: dict[str, Any]) -> bool:
    """Evita que uma reuniao abandonada continue aparecendo indefinidamente."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=12)
    active_calls = store.get("activeCalls", [])
    retained = [
        call
        for call in active_calls
        if isinstance(call, dict)
        and (started_at := parse_iso_datetime(call.get("startedAt"))) is not None
        and started_at >= cutoff
    ]
    if len(retained) == len(active_calls):
        return False
    store["activeCalls"] = retained
    return True


def active_call_for(store: dict[str, Any], call_id: str) -> dict[str, Any] | None:
    return next(
        (
            call
            for call in store.get("activeCalls", [])
            if isinstance(call, dict) and str(call.get("callId") or "") == call_id
        ),
        None,
    )


def active_call_invite(call: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "CALL_INVITE",
        "callId": call.get("callId"),
        "scope": call.get("scope"),
        "threadId": call.get("threadId"),
        "recipientId": call.get("recipientId"),
        "subteamId": call.get("subteamId"),
        "fromUserId": call.get("hostUserId"),
        "fromUserName": call.get("hostUserName"),
        "mode": "audio",
        "startedAt": call.get("startedAt"),
        "createdAt": call.get("startedAt"),
    }


async def read_pruned_chat_store(team_id: str) -> dict[str, Any]:
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        if await asyncio.to_thread(purge_expired_recordings, store):
            await asyncio.to_thread(write_chat_store, team_id, store)
        return store


async def visible_team_members(user: dict[str, Any]) -> list[dict[str, Any]]:
    store = await read_user_store()
    current_team_id = team_id_for(user)
    members = []
    for item in store.get("users", []):
        if str(item.get("id")) == current_team_id or str(item.get("teamOwnerId") or item.get("id")) == current_team_id:
            safe = sanitize_user(item)
            profile = read_profile_db(str(safe.get("id") or ""), {})
            safe["fotoUrl"] = profile.get("fotoUrl") or ""
            safe["online"] = safe["id"] in manager.online_users(current_team_id)
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


async def record_team_event(team_id: str, title: str, description: str, metadata: dict[str, Any] | None = None) -> None:
    try:
        await record_event(
            source="equipe",
            title=title,
            description=description,
            metadata={"userId": team_id, **(metadata or {})},
        )
    except Exception:
        # O chat interno nao deve falhar se a Central estiver temporariamente indisponivel.
        return


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
    stored_attachments = [
        save_attachment(AttachmentPayload.model_validate(item))
        for item in (attachments or [])
    ]
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
        "metadata": metadata or {},
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
    return {"teamId": team_id_for(user), "members": await visible_team_members(user), "onlineUserIds": manager.online_users(team_id_for(user))}


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
    return {"threadId": thread_id, "messages": messages[-300:]}


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
    return {"threadId": thread_id, "messages": messages[-300:]}


async def persist_message(
    *,
    scope: str,
    recipient_id: str | None,
    subteam_id: str | None,
    text: str,
    attachment_payloads: list[AttachmentPayload],
    user: dict[str, Any],
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    if not text.strip() and not attachment_payloads:
        raise HTTPException(status_code=400, detail="Digite uma mensagem ou anexe um arquivo.")

    team_id = team_id_for(user)
    store = await asyncio.to_thread(read_chat_store, team_id)
    participant_ids = await thread_participant_ids(user, store, scope, recipient_id, subteam_id)
    thread_id = normalize_thread_id(scope, user_id, recipient_id, subteam_id)
    attachments = [save_attachment(item) for item in attachment_payloads]
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
        },
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
    )


def recording_or_404(store: dict[str, Any], recording_id: str) -> dict[str, Any]:
    recording = next(
        (item for item in store.get("recordings", []) if isinstance(item, dict) and str(item.get("id") or "") == recording_id),
        None,
    )
    if not recording:
        raise HTTPException(status_code=404, detail="Gravacao nao encontrada.")
    return recording


def require_recording_owner(recording: dict[str, Any], user_id: str) -> None:
    if str(recording.get("createdBy") or "") != user_id:
        raise HTTPException(status_code=403, detail="Somente quem iniciou a gravacao pode finaliza-la.")
    if recording.get("status") != "recording":
        raise HTTPException(status_code=409, detail="Esta gravacao ja foi encerrada.")


@router.post("/recordings/start")
async def start_recording(payload: RecordingStartPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    mime_type = payload.mimeType.split(";", 1)[0].strip().lower()
    if mime_type not in {"video/webm", "audio/webm", "video/mp4", "audio/mp4"}:
        raise HTTPException(status_code=400, detail="Formato de gravacao nao suportado.")
    team_id = team_id_for(user)
    user_id = str(user.get("id") or "")
    store = await read_pruned_chat_store(team_id)
    participant_ids = await thread_participant_ids(user, store, payload.scope, payload.recipientId, payload.subteamId)
    thread_id = normalize_thread_id(payload.scope, user_id, payload.recipientId, payload.subteamId)
    recording_id = f"meeting_rec_{uuid.uuid4().hex}"
    extension = "mp4" if "mp4" in mime_type else "webm"
    stored_name = safe_upload_name(f"reuniao-{payload.callId[:32]}.{extension}", mime_type)
    recording = {
        "id": recording_id,
        "callId": payload.callId,
        "scope": payload.scope,
        "threadId": thread_id,
        "recipientId": payload.recipientId if payload.scope == "direct" else None,
        "subteamId": payload.subteamId if payload.scope == "subteam" else None,
        "participantIds": sorted(participant_ids),
        "createdBy": user_id,
        "createdByName": user.get("nome") or user.get("email") or "Membro",
        "mimeType": mime_type,
        "storedName": stored_name,
        "tempStoredName": f"{stored_name}.part",
        "size": 0,
        "status": "recording",
        "startedAt": now_iso(),
    }
    async with chat_lock:
        current_store = await asyncio.to_thread(read_chat_store, team_id)
        duplicate = next(
            (item for item in current_store.get("recordings", []) if isinstance(item, dict) and item.get("callId") == payload.callId and item.get("createdBy") == user_id and item.get("status") == "recording"),
            None,
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="Ja existe uma gravacao ativa nesta reuniao.")
        current_store.setdefault("recordings", []).append(recording)
        current_store["recordings"] = current_store["recordings"][-200:]
        await asyncio.to_thread(write_chat_store, team_id, current_store)
    await manager.send_to_users(team_id, participant_ids, {
        "type": "CALL_RECORDING_STARTED",
        "callId": payload.callId,
        "recordingId": recording_id,
        "fromUserId": user_id,
        "fromUserName": recording["createdByName"],
    })
    return {"recording": {key: value for key, value in recording.items() if key != "tempStoredName"}}


@router.put("/recordings/{recording_id}/chunks")
async def append_recording_chunk(recording_id: str, request: Request, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size > MAX_RECORDING_CHUNK_BYTES:
        raise HTTPException(status_code=413, detail="Trecho da gravacao acima do limite de 16 MB.")
    received = bytearray()
    async for part in request.stream():
        received.extend(part)
        if len(received) > MAX_RECORDING_CHUNK_BYTES:
            raise HTTPException(status_code=413, detail="Trecho da gravacao acima do limite de 16 MB.")
    chunk = bytes(received)
    if not chunk:
        return {"received": 0}
    team_id = team_id_for(user)
    user_id = str(user.get("id") or "")
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        recording = recording_or_404(store, recording_id)
        require_recording_owner(recording, user_id)
        next_size = int(recording.get("size") or 0) + len(chunk)
        if next_size > MAX_RECORDING_BYTES:
            raise HTTPException(status_code=413, detail="Gravacao acima do limite de 512 MB.")
        temp_name = Path(str(recording.get("tempStoredName") or "")).name
        if not temp_name:
            raise HTTPException(status_code=500, detail="Arquivo temporario da gravacao indisponivel.")
        path = UPLOAD_DIR / temp_name
        await asyncio.to_thread(append_file_bytes, path, chunk)
        recording["size"] = next_size
        await asyncio.to_thread(write_chat_store, team_id, store)
    return {"received": len(chunk), "size": next_size}


@router.post("/recordings/{recording_id}/complete")
async def complete_recording(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    team_id = team_id_for(user)
    user_id = str(user.get("id") or "")
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        recording = recording_or_404(store, recording_id)
        require_recording_owner(recording, user_id)
        temp_name = Path(str(recording.get("tempStoredName") or "")).name
        stored_name = Path(str(recording.get("storedName") or "")).name
        temp_path = UPLOAD_DIR / temp_name
        final_path = UPLOAD_DIR / stored_name
        if not temp_path.exists() or int(recording.get("size") or 0) <= 0:
            raise HTTPException(status_code=400, detail="A gravacao nao possui conteudo.")
        await asyncio.to_thread(temp_path.replace, final_path)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=RECORDING_RETENTION_HOURS)
        attachment = {
            "id": f"team_att_{uuid.uuid4().hex}",
            "name": f"gravacao-reuniao.{final_path.suffix.lstrip('.') or 'webm'}",
            "mimeType": recording.get("mimeType") or "video/webm",
            "size": int(recording.get("size") or 0),
            "url": public_api_url(f"/api/team-chat/attachments/{quote(stored_name)}"),
            "storedName": stored_name,
            "recordingId": recording_id,
            "callId": recording.get("callId"),
            "createdAt": now_iso(),
            "expiresAt": expires_at.isoformat(),
        }
        participant_ids = {str(item) for item in recording.get("participantIds", [])}
        message = {
            "id": f"team_msg_{uuid.uuid4().hex}",
            "threadId": recording.get("threadId"),
            "scope": recording.get("scope"),
            "senderId": user_id,
            "senderName": recording.get("createdByName") or user.get("nome") or "Membro",
            "senderAvatar": user_avatar_url(user_id),
            "recipientId": recording.get("recipientId"),
            "subteamId": recording.get("subteamId"),
            "memberIds": sorted(participant_ids) if recording.get("scope") == "subteam" else [],
            "text": "Gravacao da reuniao disponivel por 24 horas.",
            "attachments": [attachment],
            "metadata": {"action": "meeting_recording", "callId": recording.get("callId"), "recordingId": recording_id, "expiresAt": expires_at.isoformat()},
            "createdAt": now_iso(),
        }
        store.setdefault("messages", []).append(message)
        store["messages"] = store["messages"][-2000:]
        recording.update({"status": "completed", "completedAt": now_iso(), "expiresAt": expires_at.isoformat(), "messageId": message["id"]})
        await asyncio.to_thread(write_chat_store, team_id, store)
    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await manager.send_to_users(team_id, participant_ids, {"type": "CALL_RECORDING_AVAILABLE", "callId": recording.get("callId"), "recordingId": recording_id, "expiresAt": expires_at.isoformat(), "fromUserId": user_id, "fromUserName": recording.get("createdByName") or "Membro"})
    await record_team_event(team_id, "Gravacao de reuniao concluida", "A gravacao ficara disponivel por 24 horas.", {"action": "meeting_recording", "callId": recording.get("callId"), "recordingId": recording_id})
    return {"message": message, "expiresAt": expires_at.isoformat()}


@router.delete("/recordings/{recording_id}")
async def abort_recording(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_chat(user)
    team_id = team_id_for(user)
    user_id = str(user.get("id") or "")
    async with chat_lock:
        store = await asyncio.to_thread(read_chat_store, team_id)
        recording = recording_or_404(store, recording_id)
        require_recording_owner(recording, user_id)
        temp_name = Path(str(recording.get("tempStoredName") or "")).name
        if temp_name:
            await asyncio.to_thread((UPLOAD_DIR / temp_name).unlink, True)
        recording.update({"status": "aborted", "abortedAt": now_iso()})
        await asyncio.to_thread(write_chat_store, team_id, store)
    return {"ok": True}


@router.get("/attachments/{file_name}")
async def download_attachment(file_name: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    require_team_chat(user)
    safe_file_name = Path(file_name).name
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
    if not visible_file:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    path = UPLOAD_DIR / safe_file_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    return FileResponse(path, filename=path.name)


@router.websocket("/ws")
async def team_chat_ws(websocket: WebSocket, ticket: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_websocket_ticket(ticket or "")
        require_team_chat(user)
        team_id = team_id_for(user)
        user_id = str(user["id"])
    except Exception:
        await websocket.close(code=4401)
        return

    await manager.connect(team_id, user_id, websocket)
    try:
        await websocket.send_json({"type": "CONNECTED", "onlineUserIds": manager.online_users(team_id)})
        initial_store = await asyncio.to_thread(read_chat_store, team_id)
        if purge_stale_active_calls(initial_store):
            await asyncio.to_thread(write_chat_store, team_id, initial_store)
        for active_call in initial_store.get("activeCalls", []):
            participant_ids = {str(item) for item in active_call.get("participantIds", [])}
            if user_id in participant_ids and str(active_call.get("hostUserId") or "") != user_id:
                await websocket.send_json(active_call_invite(active_call))
        while True:
            raw = await websocket.receive_text()
            if not raw:
                continue
            if len(raw) > 120_000:
                await websocket.send_json({"type": "CALL_ERROR", "detail": "Sinal de chamada acima do limite."})
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {}
            event_type = str(payload.get("type") or "") if isinstance(payload, dict) else ""
            if event_type not in {"CALL_INVITE", "CALL_ACCEPT", "CALL_REJECT", "CALL_SIGNAL", "CALL_REACTION", "CALL_LEAVE", "CALL_END"}:
                await websocket.send_json({"type": "ACK", "timestamp": now_iso()})
                continue

            call_id = str(payload.get("callId") or "")
            scope = str(payload.get("scope") or "team")
            recipient_id = str(payload.get("recipientId") or "") or None
            subteam_id = str(payload.get("subteamId") or "") or None
            if not re.fullmatch(r"call_[a-f0-9]{16,64}", call_id):
                await websocket.send_json({"type": "CALL_ERROR", "detail": "Identificador de chamada invalido."})
                continue
            try:
                store = await asyncio.to_thread(read_chat_store, team_id)
                purge_stale_active_calls(store)
                participant_ids = await thread_participant_ids(user, store, scope, recipient_id, subteam_id)
                thread_id = normalize_thread_id(scope, user_id, recipient_id, subteam_id)
                active_call = active_call_for(store, call_id)
                if event_type == "CALL_END" and active_call and str(active_call.get("hostUserId") or "") != user_id:
                    raise HTTPException(status_code=403, detail="Somente o organizador pode encerrar a reuniao.")
                target_user_id = str(payload.get("targetUserId") or "")
                if event_type == "CALL_SIGNAL":
                    if target_user_id not in participant_ids or target_user_id == user_id or not isinstance(payload.get("signal"), dict):
                        raise HTTPException(status_code=400, detail="Destino de sinalizacao invalido.")
                    recipients = {target_user_id}
                else:
                    recipients = participant_ids - {user_id}
                event_created_at = now_iso()
                started_at = str(active_call.get("startedAt") or event_created_at) if active_call else event_created_at
                event = {
                    "type": event_type,
                    "callId": call_id,
                    "scope": scope,
                    "threadId": thread_id,
                    "recipientId": recipient_id,
                    "subteamId": subteam_id,
                    "fromUserId": user_id,
                    "fromUserName": str(user.get("nome") or user.get("email") or "Membro"),
                    "mode": "audio",
                    "signal": payload.get("signal") if event_type == "CALL_SIGNAL" else None,
                    "startedAt": started_at,
                    "createdAt": event_created_at,
                }
                if event_type == "CALL_REACTION":
                    emoji = str(payload.get("emoji") or "")
                    if emoji not in {"👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"}:
                        raise HTTPException(status_code=400, detail="Reacao invalida.")
                    event["emoji"] = emoji
                if event_type in {"CALL_INVITE", "CALL_END"}:
                    if event_type == "CALL_INVITE":
                        event["startedAt"] = event_created_at
                    call_message = {
                        "id": f"team_msg_{uuid.uuid4().hex}",
                        "threadId": thread_id,
                        "scope": scope,
                        "senderId": user_id,
                        "senderName": str(user.get("nome") or user.get("email") or "Membro"),
                        "senderAvatar": user_avatar_url(user_id),
                        "recipientId": recipient_id if scope == "direct" else None,
                        "subteamId": subteam_id if scope == "subteam" else None,
                        "memberIds": sorted(participant_ids) if scope == "subteam" else [],
                        "text": (
                            "Iniciou uma reuniao."
                            if event_type == "CALL_INVITE"
                            else "Encerrou a chamada."
                        ),
                        "attachments": [],
                        "metadata": {"action": "call_started" if event_type == "CALL_INVITE" else "call_ended", "callId": call_id, "mode": event["mode"]},
                        "createdAt": now_iso(),
                    }
                    async with chat_lock:
                        call_store = await asyncio.to_thread(read_chat_store, team_id)
                        purge_stale_active_calls(call_store)
                        if event_type == "CALL_INVITE":
                            call_store.setdefault("activeCalls", [])
                            call_store["activeCalls"] = [
                                call for call in call_store["activeCalls"]
                                if str(call.get("callId") or "") != call_id
                            ]
                            call_store["activeCalls"].append({
                                "callId": call_id,
                                "scope": scope,
                                "threadId": thread_id,
                                "recipientId": recipient_id,
                                "subteamId": subteam_id,
                                "participantIds": sorted(participant_ids),
                                "hostUserId": user_id,
                                "hostUserName": event["fromUserName"],
                                "startedAt": event["startedAt"],
                            })
                            call_store["activeCalls"] = call_store["activeCalls"][-100:]
                        else:
                            call_store["activeCalls"] = [
                                call for call in call_store.get("activeCalls", [])
                                if str(call.get("callId") or "") != call_id
                            ]
                        call_store.setdefault("messages", []).append(call_message)
                        call_store["messages"] = call_store["messages"][-2000:]
                        await asyncio.to_thread(write_chat_store, team_id, call_store)
                    await manager.send_to_users(team_id, participant_ids, {"type": "TEAM_CHAT_MESSAGE", "message": call_message})
                await manager.send_to_users(team_id, recipients, event)
                await websocket.send_json({"type": "CALL_ACK", "callId": call_id, "event": event_type})
            except HTTPException as exc:
                await websocket.send_json({"type": "CALL_ERROR", "callId": call_id, "detail": exc.detail})
    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)
        await manager.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": manager.online_users(team_id)})
    except Exception:
        manager.disconnect(websocket, user_id)


def save_attachment(payload: AttachmentPayload) -> dict[str, Any]:
    file_bytes, mime_type = decode_data_url(payload.dataUrl, payload.mimeType)
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
