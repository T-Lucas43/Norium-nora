"""Dominio de equipe extraido para concentrar membros, chat e permissoes."""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import Field

from app.shared.schemas import StrictModel

from app.core.tenant import get_data_root, get_user_db_path, public_api_url, read_json_file, read_profile_db, write_json_file
from app.modules.team.nora_mentions import generate_team_reply, has_nora_mention
from app.routers.auth_router import current_user, read_user_store, sanitize_user, user_from_token
from app.routers.inbox_router import record_event

router = APIRouter(prefix="/api/team-chat", tags=["Chat interno"])
chat_lock = asyncio.Lock()
UPLOAD_DIR = get_data_root() / "team_chat_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024

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


class PresenceManager:
    def __init__(self) -> None:
        self.connections: dict[str, list[WebSocket]] = {}
        self.user_team: dict[str, str] = {}

    async def connect(self, team_id: str, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.setdefault(team_id, []).append(websocket)
        self.user_team[user_id] = team_id
        await self.broadcast(team_id, {"type": "PRESENCE", "onlineUserIds": self.online_users(team_id)})

    def disconnect(self, websocket: WebSocket, user_id: str) -> None:
        team_id = self.user_team.get(user_id)
        if team_id:
            connections = self.connections.get(team_id, [])
            if websocket in connections:
                connections.remove(websocket)
            if not connections:
                self.connections.pop(team_id, None)
        self.user_team.pop(user_id, None)

    def online_users(self, team_id: str) -> list[str]:
        return sorted(user_id for user_id, active_team in self.user_team.items() if active_team == team_id)

    async def broadcast(self, team_id: str, payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        for websocket in list(self.connections.get(team_id, [])):
            try:
                await websocket.send_json(payload)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            for connections in self.connections.values():
                if websocket in connections:
                    connections.remove(websocket)


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
    return {"messages": [], "createdAt": now_iso(), "updatedAt": now_iso()}


def read_chat_store(team_id: str) -> dict[str, Any]:
    payload = read_json_file(team_chat_path(team_id), empty_store())
    if not isinstance(payload, dict):
        return empty_store()
    payload.setdefault("messages", [])
    return payload


def write_chat_store(team_id: str, payload: dict[str, Any]) -> None:
    payload["updatedAt"] = now_iso()
    write_json_file(team_chat_path(team_id), payload)


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
    return user_id in {str(message.get("senderId")), str(message.get("recipientId"))}


def normalize_thread_id(scope: str, user_id: str, recipient_id: str | None) -> str:
    if scope == "team":
        return "team"
    if not recipient_id:
        raise HTTPException(status_code=400, detail="recipientId obrigatorio para mensagem direta.")
    return "direct:" + ":".join(sorted([user_id, recipient_id]))


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


@router.get("/messages")
async def list_messages(
    scope: MessageScope = "team",
    recipientId: str | None = None,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    thread_id = normalize_thread_id(scope, user_id, recipientId)
    store = await asyncio.to_thread(read_chat_store, team_id_for(user))
    messages = [
        item for item in store.get("messages", [])
        if isinstance(item, dict) and item.get("threadId") == thread_id and message_visible(item, user_id)
    ]
    return {"threadId": thread_id, "messages": messages[-300:]}


@router.post("/messages")
async def send_message(payload: SendTeamMessagePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_chat(user)
    user_id = str(user["id"])
    if not payload.text.strip() and not payload.attachments:
        raise HTTPException(status_code=400, detail="Digite uma mensagem ou anexe um arquivo.")

    team_id = team_id_for(user)
    thread_id = normalize_thread_id(payload.scope, user_id, payload.recipientId)
    attachments = [save_attachment(item) for item in payload.attachments]
    nora_mentioned = payload.scope == "team" and has_nora_mention(payload.text)
    nora_triggered = nora_mentioned and can_use_nora(user)
    message = {
        "id": f"team_msg_{uuid.uuid4().hex}",
        "threadId": thread_id,
        "scope": payload.scope,
        "senderId": user_id,
        "senderName": user.get("nome") or user.get("email") or "Membro",
        "senderAvatar": user_avatar_url(user_id),
        "recipientId": payload.recipientId if payload.scope == "direct" else None,
        "text": payload.text.strip(),
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

    await manager.broadcast(team_id, {"type": "TEAM_CHAT_MESSAGE", "message": message})
    await record_team_event(
        team_id,
        "Mensagem no chat interno" if payload.scope == "team" else "Mensagem direta no chat interno",
        (
            f"{message['senderName']}: {short_text(message['text'])}. "
            f"Anexos: {len(attachments)}."
        ),
        {
            "action": "team_message_created",
            "messageId": message["id"],
            "senderId": user_id,
            "senderName": message["senderName"],
            "scope": payload.scope,
            "threadId": thread_id,
            "attachments": len(attachments),
            "recipientId": payload.recipientId,
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


@router.get("/attachments/{file_name}")
async def download_attachment(file_name: str, _: dict[str, Any] = Depends(current_user)) -> FileResponse:
    path = UPLOAD_DIR / Path(file_name).name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    return FileResponse(path, filename=path.name)


@router.websocket("/ws")
async def team_chat_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_token(token or "")
        require_team_chat(user)
        team_id = team_id_for(user)
        user_id = str(user["id"])
    except Exception:
        await websocket.close(code=4401)
        return

    await manager.connect(team_id, user_id, websocket)
    try:
        await websocket.send_json({"type": "CONNECTED", "onlineUserIds": manager.online_users(team_id)})
        while True:
            raw = await websocket.receive_text()
            if raw:
                await websocket.send_json({"type": "ACK", "timestamp": now_iso()})
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
