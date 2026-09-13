"""Adapters da infraestrutura atual para o modulo de coordenacao de chamadas."""

from __future__ import annotations

import asyncio
import copy
import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from app.modules.team.call_coordinator import CallActor, CallState


class JsonCallStateStore:
    """Persiste somente os campos da chamada dentro do JSON legado da equipe."""

    def __init__(
        self,
        *,
        read_document: Callable[[str], dict[str, Any]],
        write_document: Callable[[str, dict[str, Any]], None],
        lock: asyncio.Lock,
        on_call_removed: Callable[[dict[str, Any]], None | Awaitable[None]] | None = None,
    ) -> None:
        self._read_document = read_document
        self._write_document = write_document
        self._lock = lock
        self._on_call_removed = on_call_removed

    async def load(self, team_id: str) -> CallState:
        async with self._lock:
            document = await asyncio.to_thread(self._read_document, team_id)
        return CallState(
            active_calls=copy.deepcopy([
                item for item in document.get("activeCalls", []) if isinstance(item, dict)
            ]),
            ended_call_ids={
                str(key): str(value)
                for key, value in document.get("endedCallIds", {}).items()
            },
        )

    async def save(
        self,
        team_id: str,
        state: CallState,
        *,
        append_messages: tuple[dict[str, Any], ...] = (),
    ) -> None:
        async with self._lock:
            document = await asyncio.to_thread(self._read_document, team_id)
            if self._on_call_removed:
                retained_ids = {
                    str(call.get("callId") or "") for call in state.active_calls if isinstance(call, dict)
                }
                for call in document.get("activeCalls", []):
                    if isinstance(call, dict) and str(call.get("callId") or "") not in retained_ids:
                        result = self._on_call_removed(call)
                        if inspect.isawaitable(result):
                            await result
            document["activeCalls"] = copy.deepcopy(state.active_calls)
            document["endedCallIds"] = dict(state.ended_call_ids)
            if append_messages:
                document.setdefault("messages", []).extend(copy.deepcopy(list(append_messages)))
                document["messages"] = document["messages"][-2000:]
            await asyncio.to_thread(self._write_document, team_id, document)


class CallbackTeamDirectory:
    def __init__(
        self,
        *,
        active_members: Callable[[CallActor], Awaitable[set[str]]],
        subteam_members: Callable[[CallActor, str], Awaitable[set[str] | None]],
    ) -> None:
        self._active_members = active_members
        self._subteam_members = subteam_members

    async def active_member_ids(self, actor: CallActor) -> set[str]:
        return await self._active_members(actor)

    async def subteam_member_ids(self, actor: CallActor, subteam_id: str) -> set[str] | None:
        return await self._subteam_members(actor, subteam_id)


class CallbackCallPublisher:
    def __init__(
        self,
        *,
        send: Callable[[str, set[str], dict[str, Any]], Awaitable[None]],
        online: Callable[[str], list[str] | Awaitable[list[str]]],
    ) -> None:
        self._send = send
        self._online = online

    async def send_to_users(self, team_id: str, user_ids: set[str], payload: dict[str, Any]) -> None:
        await self._send(team_id, user_ids, payload)

    async def online_users(self, team_id: str) -> list[str]:
        result = self._online(team_id)
        return await result if inspect.isawaitable(result) else result
