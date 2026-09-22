"""Dominio omnichannel extraido para centralizar eventos e WebSockets."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from pydantic import Field, field_validator

from app.shared.schemas import StrictModel

from app.core.tenant import get_user_db_path, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store
from app.routers.auth_router import current_user, user_from_websocket_ticket

BASE_DIR = Path(__file__).resolve().parents[3]
EVENTS_DB_PATH = BASE_DIR / "eventos_db.json"
MAX_TITLE_LENGTH = 180
MAX_DESCRIPTION_LENGTH = 1200

EventSource = Literal[
    "gmail",
    "whatsapp",
    "calendar",
    "kanban",
    "financeiro",
    "equipe",
    "automacoes",
    "brainstorm",
    "relatorios",
    "sistema",
]

router = APIRouter(prefix="/api/omnichannel", tags=["Omnichannel Inbox"])
events_lock = asyncio.Lock()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def trim_for_timeline(value: Any, max_length: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_length:
        return text
    if max_length <= 3:
        return text[:max_length]
    return f"{text[: max_length - 3].rstrip()}..."


class OmnichannelEvent(StrictModel):
    id: str = Field(default_factory=lambda: f"evt_{uuid.uuid4().hex}")
    source: EventSource
    title: str = Field(min_length=1)
    description: str = ""
    timestamp: str = Field(default_factory=utc_now_iso)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        title = trim_for_timeline(value, MAX_TITLE_LENGTH)
        if not title:
            raise ValueError("title is required")
        return title

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str) -> str:
        return trim_for_timeline(value, MAX_DESCRIPTION_LENGTH)


class SocketEnvelope(StrictModel):
    type: str = Field(min_length=1)
    event: OmnichannelEvent | None = None


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[str, list[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.setdefault(user_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        for user_id, connections in list(self.active_connections.items()):
            if websocket in connections:
                connections.remove(websocket)
            if not connections:
                self.active_connections.pop(user_id, None)

    async def broadcast(self, user_id: str, message: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        for connection in list(self.active_connections.get(user_id, [])):
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)

        for connection in disconnected:
            self.disconnect(connection)


manager = ConnectionManager()


def event_user_id(event: dict[str, Any], fallback: str = "") -> str:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    return str(metadata.get("userId") or fallback).strip() or fallback


def event_db_path(user_id: str) -> Path:
    return Path(get_user_db_path(user_id, "eventos"))


def notification_state_path(user_id: str) -> Path:
    return Path(get_user_db_path(user_id, "notificacoes_estado"))


async def read_notification_state(user_id: str) -> dict[str, str | None]:
    def load() -> dict[str, str | None]:
        path = notification_state_path(user_id)
        payload = read_json_file(path, None)
        if payload is None:
            initialized_at = utc_now_iso()
            initial_state = {
                "userId": user_id,
                "readBefore": initialized_at,
                "clearedBefore": initialized_at,
            }
            write_json_file(path, initial_state)
            return initial_state
        if not isinstance(payload, dict) or str(payload.get("userId") or "") != user_id:
            return {"userId": user_id, "readBefore": None, "clearedBefore": None}
        return {
            "userId": user_id,
            "readBefore": str(payload.get("readBefore") or "") or None,
            "clearedBefore": str(payload.get("clearedBefore") or "") or None,
        }

    return await asyncio.to_thread(load)


async def write_notification_state(user_id: str, state: dict[str, str | None]) -> dict[str, str | None]:
    payload = {
        "userId": user_id,
        "readBefore": state.get("readBefore"),
        "clearedBefore": state.get("clearedBefore"),
    }

    def save() -> None:
        write_json_file(notification_state_path(user_id), payload)

    await asyncio.to_thread(save)
    return payload


async def read_events(user_id: str) -> list[dict[str, Any]]:
    def load() -> list[dict[str, Any]]:
        path = event_db_path(user_id)
        payload = read_json_file(path, None)
        if payload is None:
            from app.infrastructure.persistence import postgres_store
            if not (postgres_store.configured() or postgres_store.required()) and user_id == "lucas123" and EVENTS_DB_PATH.exists():
                try:
                    legacy = json.loads(EVENTS_DB_PATH.read_text(encoding="utf-8"))
                    events = [
                        item for item in legacy
                        if isinstance(item, dict) and event_visible_for_user(item, user_id)
                    ] if isinstance(legacy, list) else []
                    write_json_file(path, events)
                    return events
                except Exception:
                    pass
            write_json_file(path, [])
            return []

        if not isinstance(payload, list):
            return []
        return [
            item
            for item in payload
            if isinstance(item, dict) and event_visible_for_user(item, user_id)
        ]

    return await asyncio.to_thread(load)


async def write_events(user_id: str, events: list[dict[str, Any]]) -> None:
    def save() -> None:
        write_json_file(event_db_path(user_id), events)

    await asyncio.to_thread(save)


def sort_key(event: dict[str, Any]) -> datetime:
    value = str(event.get("timestamp") or "")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def event_visible_for_user(event: dict[str, Any], user_id: str) -> bool:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    event_user_id = str(metadata.get("userId") or "").strip()
    return bool(event_user_id) and event_user_id == user_id


async def persist_event(event: OmnichannelEvent, user_id: str | None = None) -> tuple[dict[str, Any], bool]:
    async with events_lock:
        event_payload = event.model_dump()
        resolved_user_id = user_id or event_user_id(event_payload)
        if not resolved_user_id:
            raise ValueError("Todo evento precisa de um userId autenticado e explicito.")
        event_payload.setdefault("metadata", {})["userId"] = resolved_user_id
        events = await read_events(resolved_user_id)
        previous = next((item for item in events if item.get("id") == event.id), None)
        # Sincronizacao repetida gera timestamp novo; ignorar so timestamp evita reacender lidos.
        if previous is not None:
            previous_content = {key: value for key, value in previous.items() if key != "timestamp"}
            new_content = {key: value for key, value in event_payload.items() if key != "timestamp"}
            if previous_content == new_content:
                return previous, False
        changed = previous != event_payload
        if not changed:
            return event_payload, False
        without_duplicate = [item for item in events if item.get("id") != event.id]
        without_duplicate.append(event_payload)
        without_duplicate.sort(key=sort_key, reverse=True)
        await write_events(resolved_user_id, without_duplicate[:1000])
        return event_payload, True


async def record_event(
    *,
    source: EventSource,
    title: str,
    description: str = "",
    metadata: dict[str, Any] | None = None,
    event_id: str | None = None,
    timestamp: str | None = None,
    broadcast: bool = True,
) -> dict[str, Any]:
    event = OmnichannelEvent(
        id=event_id or f"evt_{uuid.uuid4().hex}",
        source=source,
        title=title,
        description=description,
        timestamp=timestamp or utc_now_iso(),
        metadata=metadata or {},
    )
    resolved_user_id = event_user_id(event.model_dump())
    if not resolved_user_id:
        raise ValueError("record_event exige metadata.userId para impedir mistura entre usuarios.")
    event_payload, changed = await persist_event(event, resolved_user_id)
    # Queue first, before optional notifications. Queue failures never roll back
    # the user's original message/task; duplicate deliveries are idempotent.
    from app.modules.automations.events import publish_event
    await publish_event(event_payload)
    if changed and broadcast:
        await manager.broadcast(resolved_user_id, {"type": "NEW_EVENT", "event": event_payload})
    if changed:
        from app.services.system_email import notify_event
        from app.core.request_context import current_workspace_id
        await notify_event(event_payload, current_workspace_id())
    return event_payload


@router.get("/inbox")
async def get_universal_inbox(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    user_id = str(user.get("id") or "lucas123")
    events = await read_events(user_id)
    events.sort(key=sort_key, reverse=True)
    return events


@router.get("/notifications/state")
async def get_notification_state(user: dict[str, Any] = Depends(current_user)) -> dict[str, str | None]:
    return await read_notification_state(str(user.get("id") or "lucas123"))


@router.post("/notifications/read-all")
async def mark_all_notifications_read(user: dict[str, Any] = Depends(current_user)) -> dict[str, str | None]:
    user_id = str(user.get("id") or "lucas123")
    async with events_lock:
        state = await read_notification_state(user_id)
        state["readBefore"] = utc_now_iso()
        return await write_notification_state(user_id, state)


@router.delete("/notifications")
async def clear_notifications(user: dict[str, Any] = Depends(current_user)) -> dict[str, str | None]:
    user_id = str(user.get("id") or "lucas123")
    async with events_lock:
        state = await read_notification_state(user_id)
        cleared_at = utc_now_iso()
        state["readBefore"] = cleared_at
        state["clearedBefore"] = cleared_at
        return await write_notification_state(user_id, state)


@router.post("/registrar-evento")
async def register_omnichannel_event(event: OmnichannelEvent, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = str(user.get("id") or "lucas123")
    event_payload, changed = await persist_event(event, user_id)
    if changed:
        await manager.broadcast(user_id, {"type": "NEW_EVENT", "event": event_payload})
    return event_payload


@router.websocket("/ws")
async def omnichannel_websocket(websocket: WebSocket, ticket: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_websocket_ticket(ticket or "")
        user_id = str(user.get("id") or "lucas123")
    except Exception:
        await websocket.close(code=4401)
        return
    await manager.connect(user_id, websocket)
    try:
        await websocket.send_json({"type": "CONNECTED", "timestamp": utc_now_iso()})
        while True:
            raw_message = await websocket.receive_text()
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "ERROR", "detail": "Invalid JSON"})
                continue

            if payload.get("type") == "PING":
                await websocket.send_json({"type": "PONG", "timestamp": utc_now_iso()})
                continue

            if payload.get("type") == "REGISTER_EVENT" and isinstance(payload.get("event"), dict):
                envelope = SocketEnvelope.model_validate(payload)
                if envelope.event:
                    event_payload, changed = await persist_event(envelope.event, user_id)
                    if changed:
                        await manager.broadcast(user_id, {"type": "NEW_EVENT", "event": event_payload})
                continue

            await websocket.send_json({"type": "ACK", "timestamp": utc_now_iso()})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
