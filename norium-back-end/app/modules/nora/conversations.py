"""Private conversation history, scoped to the authenticated user and workspace."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import Field, model_validator

from app.core.tenant import read_user_db, write_user_db
from app.routers.auth_router import current_user
from app.shared.schemas import StrictModel
from app.modules.nora.response_schema import ResponseView
from app.modules.nora.context import delete_conversation_context

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations")
history_lock = asyncio.Lock()
INDEX = "nora_conversations"
ID_PATTERN = r"^[a-zA-Z0-9_-]{8,80}$"


def history_user(user: dict = Depends(current_user)) -> dict:
    if not user.get("systemAdmin") and not (user.get("permissions") or {}).get("nora"):
        raise HTTPException(403, "A Nora não está liberada para esta conta.")
    return user


class ApprovalSnapshot(StrictModel):
    id: str = Field(max_length=120)
    action: str | None = Field(default=None, max_length=120)
    source: str | None = Field(default=None, max_length=60)
    title: str = Field(default="", max_length=300)
    status: str = Field(default="pending", max_length=30)
    digest: str | None = Field(default=None, max_length=128)
    expiresAt: str | None = Field(default=None, max_length=64)
    workspace: str | None = Field(default=None, max_length=80)
    version: str | None = Field(default=None, max_length=40)
    summary: str = Field(default="", max_length=2000)
    recipients: list[str] = Field(default_factory=list, max_length=25)
    decidedAt: str | None = Field(default=None, max_length=64)
    outcome: str | None = Field(default=None, max_length=2000)
    uncertain: bool = False


class SavedMessage(StrictModel):
    role: Literal["user", "ai"]
    text: str = Field(max_length=100_000)
    feedback: Literal["positive", "negative"] | None = None
    agent: str | None = Field(default=None, max_length=50)
    status: str | None = Field(default=None, max_length=100)
    emailMessages: list[dict[str, Any]] | None = Field(default=None, max_length=100)
    agendaEvents: list[dict[str, Any]] | None = Field(default=None, max_length=100)
    responseView: ResponseView | None = None
    files: list[dict[str, Any]] | None = Field(default=None, max_length=20)
    approval: ApprovalSnapshot | None = None


class ConversationState(StrictModel):
    messages: list[SavedMessage] = Field(default_factory=list, max_length=500)
    agendaSessionId: str | None = Field(default=None, max_length=180)
    agendaAgentActive: bool = False
    emailSessionId: str | None = Field(default=None, max_length=180)
    emailAgentActive: bool = False
    commercialSessionId: str | None = Field(default=None, max_length=180)
    commercialAgentActive: bool = False


class ConversationSave(StrictModel):
    title: str = Field(min_length=1, max_length=160)
    revision: int = Field(ge=0)
    inLibrary: bool = False
    state: ConversationState

    @model_validator(mode="after")
    def bounded_snapshot(self):
        if len(json.dumps(self.state.model_dump(), ensure_ascii=False).encode("utf-8")) > 4_000_000:
            raise ValueError("Conversa muito longa. Comece uma nova conversa.")
        return self


def read_index(user_id: str) -> dict:
    return read_user_db(user_id, INDEX, {"conversations": []})


def conversation_db(conversation_id: str) -> str:
    return f"nora_chat_{conversation_id}"


@router.get("")
async def list_conversations(user: dict = Depends(history_user)):
    async with history_lock:
        return sorted(read_index(user["id"])["conversations"], key=lambda item: item["updatedAt"], reverse=True)


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str = Path(pattern=ID_PATTERN), user: dict = Depends(history_user)):
    async with history_lock:
        record = read_user_db(user["id"], conversation_db(conversation_id), {})
        if not record or record.get("deleted"):
            raise HTTPException(404, "Conversa não encontrada.")
        return record


@router.put("/{conversation_id}")
async def save_conversation(payload: ConversationSave, conversation_id: str = Path(pattern=ID_PATTERN), user: dict = Depends(history_user)):
    async with history_lock:
        user_id = user["id"]
        old = read_user_db(user_id, conversation_db(conversation_id), {})
        if old.get("deleted") or payload.revision != old.get("revision", 0):
            raise HTTPException(409, "Esta conversa mudou em outra janela. Reabra o histórico antes de continuar.")
        timestamp = datetime.now(timezone.utc).isoformat()
        state = payload.state.model_dump(exclude_none=True)
        summary = {
            "id": conversation_id, "title": payload.title.strip() or "Nova conversa",
            "createdAt": old.get("createdAt", timestamp), "updatedAt": timestamp,
            "revision": payload.revision + 1, "messageCount": len(state["messages"]),
            "inLibrary": payload.inLibrary,
            "preview": next((item["text"][:180] for item in reversed(state["messages"]) if item["text"].strip()), ""),
        }
        index = read_index(user_id)
        if not old and len(index["conversations"]) >= 500:
            raise HTTPException(409, "Limite de 500 conversas. Exclua uma conversa para continuar.")
        record = {**summary, "state": state}
        write_user_db(user_id, conversation_db(conversation_id), record)
        index["conversations"] = [summary, *[item for item in index["conversations"] if item["id"] != conversation_id]]
        write_user_db(user_id, INDEX, index)
        return summary


class ConversationLibraryUpdate(StrictModel):
    revision: int = Field(ge=0)
    inLibrary: bool


@router.patch("/{conversation_id}/library")
async def update_conversation_library(
    payload: ConversationLibraryUpdate,
    conversation_id: str = Path(pattern=ID_PATTERN),
    user: dict = Depends(history_user),
):
    async with history_lock:
        user_id = user["id"]
        record = read_user_db(user_id, conversation_db(conversation_id), {})
        if not record or record.get("deleted"):
            raise HTTPException(404, "Conversa não encontrada.")
        if payload.revision != record.get("revision", 0):
            raise HTTPException(409, "Esta conversa mudou em outra janela. Reabra o histórico antes de continuar.")
        timestamp = datetime.now(timezone.utc).isoformat()
        record.update({"inLibrary": payload.inLibrary, "updatedAt": timestamp, "revision": payload.revision + 1})
        summary = {key: value for key, value in record.items() if key != "state"}
        write_user_db(user_id, conversation_db(conversation_id), record)
        index = read_index(user_id)
        index["conversations"] = [summary if item.get("id") == conversation_id else item for item in index["conversations"]]
        write_user_db(user_id, INDEX, index)
        return summary


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str = Path(pattern=ID_PATTERN), user: dict = Depends(history_user)):
    async with history_lock:
        user_id = user["id"]
        old = read_user_db(user_id, conversation_db(conversation_id), {})
        if not old or old.get("deleted"):
            raise HTTPException(404, "Conversa não encontrada.")
        # A tombstone prevents an older open tab from recreating deleted content.
        write_user_db(user_id, conversation_db(conversation_id), {"deleted": True})
        index = read_index(user_id)
        index["conversations"] = [item for item in index["conversations"] if item["id"] != conversation_id]
        write_user_db(user_id, INDEX, index)
        try:
            await delete_conversation_context(user_id, conversation_id)
        except Exception:
            logger.warning("nora_context_delete_failed")
        return {"deleted": True}
