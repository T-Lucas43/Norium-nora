"""Adaptadores da infraestrutura atual para a politica de gravacao."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from typing import Any

from app.modules.team.call_coordinator import CallActor, CallCoordinator, CallError
from app.modules.team.recording_coordinator import (
    CallRecordingContext,
    RecordingActor,
    RecordingError,
)


class JsonRecordingStore:
    """Transaciona gravacoes e mensagens no documento JSON legado da equipe."""

    def __init__(
        self,
        *,
        read_document: Callable[[str], dict[str, Any]],
        write_document: Callable[[str, dict[str, Any]], None],
        lock: asyncio.Lock,
    ) -> None:
        self._read_document = read_document
        self._write_document = write_document
        self._lock = lock

    async def load(self, team_id: str) -> dict[str, Any]:
        async with self._lock:
            return copy.deepcopy(await asyncio.to_thread(self._read_document, team_id))

    async def transact(
        self,
        team_id: str,
        operation: Callable[[dict[str, Any]], Awaitable[Any]],
    ) -> Any:
        async with self._lock:
            document = await asyncio.to_thread(self._read_document, team_id)
            result = await operation(document)
            document["recordings"] = document.get("recordings", [])[-200:]
            document["messages"] = document.get("messages", [])[-2000:]
            await asyncio.to_thread(self._write_document, team_id, document)
            return result


class CallCoordinatorRecordingAccess:
    def __init__(self, coordinator: Callable[[], CallCoordinator]) -> None:
        self._coordinator = coordinator

    async def authorize(
        self,
        actor: RecordingActor,
        call_id: str,
        client_id: str,
        *,
        require_host: bool,
    ) -> CallRecordingContext:
        try:
            call = await self._coordinator().recording_context(
                CallActor(actor.user_id, actor.team_id, actor.name),
                call_id,
                client_id,
                require_host=require_host,
            )
        except CallError as error:
            raise RecordingError(error.status_code, error.detail) from error
        sessions = call.get("participantSessions", {})
        participant_clients = {
            str(user_id): str(session.get("clientId") or "")
            for user_id, session in sessions.items()
            if isinstance(session, dict) and str(session.get("clientId") or "")
        }
        return CallRecordingContext(
            call_id=str(call.get("callId") or ""),
            host_user_id=str(call.get("hostUserId") or ""),
            participant_ids=frozenset(str(item) for item in call.get("participantIds", []) if str(item)),
            participant_clients=participant_clients,
            thread_id=str(call.get("threadId") or "team"),
            scope=str(call.get("scope") or "team"),
            recipient_id=str(call.get("recipientId") or "") or None,
            subteam_id=str(call.get("subteamId") or "") or None,
        )


class CallbackRecordingEvents:
    def __init__(
        self,
        *,
        publish: Callable[[str, set[str], dict[str, Any]], Awaitable[None]],
        audit: Callable[[str, str, dict[str, Any]], Awaitable[None]],
    ) -> None:
        self._publish = publish
        self._audit = audit

    async def publish(self, team_id: str, recipients: set[str], payload: dict[str, Any]) -> None:
        await self._publish(team_id, recipients, payload)

    async def audit(self, team_id: str, action: str, metadata: dict[str, Any]) -> None:
        await self._audit(team_id, action, metadata)
