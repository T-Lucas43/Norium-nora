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
        lock_for_team: Callable[[str], asyncio.Lock] | None = None,
        on_call_removed: Callable[[dict[str, Any]], None | Awaitable[None]] | None = None,
    ) -> None:
        self._read_document = read_document
        self._write_document = write_document
        self._lock = lock
        self._lock_for_team = lock_for_team
        self._on_call_removed = on_call_removed

    @staticmethod
    async def _complete_worker(operation: Callable, *args):
        # Cancelling to_thread does not stop its thread. Keep the document
        # lock until that worker really exits, even after repeated cancellation,
        # so an older merge cannot overwrite a newer mutation after lock release.
        worker = asyncio.create_task(asyncio.to_thread(operation, *args))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
            worker.result()
            raise

    async def load(self, team_id: str) -> CallState:
        async with (self._lock_for_team(team_id) if self._lock_for_team else self._lock):
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
        async with (self._lock_for_team(team_id) if self._lock_for_team else self._lock):
            # The same shared document lock covers read, merge and write.
            # Normal updates need one worker dispatch, rather than handing
            # the lock back to the event loop between two I/O dispatches.
            pending = await self._complete_worker(self._save_document, team_id, state, append_messages)
            if pending is None:
                return
            document, removed_calls = pending
            for call in removed_calls:
                result = self._on_call_removed(call)
                if inspect.isawaitable(result):
                    await result
            await self._complete_worker(self._write_document, team_id, document)

    def _save_document(
        self,
        team_id: str,
        state: CallState,
        append_messages: tuple[dict[str, Any], ...],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
        document = self._read_document(team_id)
        retained_ids = {str(call.get("callId") or "") for call in state.active_calls if isinstance(call, dict)}
        removed_calls = [call for call in document.get("activeCalls", [])
                         if isinstance(call, dict) and str(call.get("callId") or "") not in retained_ids]
        document["activeCalls"] = copy.deepcopy(state.active_calls)
        document["endedCallIds"] = dict(state.ended_call_ids)
        if append_messages:
            document.setdefault("messages", []).extend(copy.deepcopy(list(append_messages)))
        # Awaitable cleanup retains its original ordering before the write;
        # no document or authorization snapshot is cached across operations.
        if self._on_call_removed and removed_calls:
            return document, removed_calls
        self._write_document(team_id, document)
        return None


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
