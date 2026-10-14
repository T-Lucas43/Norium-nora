"""Metered meeting understanding linked to current call consent and audience.

The media supervisor owns this bridge; construction alone never starts a model
call. No tools, effects or cross-module search are offered to the meeting model.
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Awaitable, Callable, Mapping

from app.modules.team.call_coordinator import CallActor, CallCoordinator
from app.modules.team.meeting_intelligence import MeetingAnalyzer
from app.modules.team.nora_call_state import NoraConsentState
from app.modules.team.meeting_usage import meeting_usage_source
from app.core.request_context import current_workspace_id


class MeetingIntelligenceBridge:
    def __init__(self, coordinator: CallCoordinator, actor: CallActor, call_id: str,
                 client_id: str, *, model_service,
                 participant_names: Callable[[], Awaitable[Mapping[str, str]]],
                 every_segments: int = 12):
        self.coordinator, self.actor = coordinator, actor
        self.call_id, self.client_id = call_id, client_id
        self.model_service, self.participant_names = model_service, participant_names
        self.every_segments = every_segments
        self._revision = -1
        self._allowed = False
        self._unsubscribe = None
        self._loop: asyncio.Task | None = None
        self._iteration: asyncio.Task | None = None
        self._ended = False
        self._failed_revision: int | None = None
        self._started_at = time.monotonic()
        self.last_error = ""
        async def model(messages):
            await self.coordinator.authorize_nora_capture(self.actor, self.call_id, self.client_id, self._revision)
            return await self.model_service.perguntar_nora(messages, user_id=self.actor.user_id,
                                                         max_tokens=2400, require_complete=True, research=True,
                                                         usage_source=meeting_usage_source(current_workspace_id(), self.actor.team_id, self.call_id))
        self._model = model
        self.analyzer = MeetingAnalyzer(model, every_segments=every_segments)

    def _changed(self, state: NoraConsentState | None):
        ended = state is None
        revision = state.revision if state else -1
        allowed = bool(state and state.capture_allowed and revision != self._failed_revision)
        changed = ended or revision != self._revision or not allowed
        if changed and self._iteration:
            self._iteration.cancel()
        if revision != self._revision:
            self.analyzer = MeetingAnalyzer(self._model, every_segments=self.every_segments)
        self._revision, self._allowed, self._ended = revision, allowed, ended

    async def start(self):
        if self._unsubscribe is not None:
            raise RuntimeError("Entendimento da Nora já iniciado.")
        self._unsubscribe = await self.coordinator.subscribe_nora_policy(self.actor, self.call_id,
                                                                       self.client_id, self._changed)
        self._loop = asyncio.create_task(self._run())

    async def refresh(self, *, force: bool = False):
        if not self._allowed or self._ended:
            return None
        revision = self._revision
        values = await self.coordinator.nora_analysis_context(self.actor, self.call_id, self.client_id, revision)
        names = await self.participant_names()
        result = await self.analyzer.update(values, names, elapsed=time.monotonic() - self._started_at, force=force)
        if result is not None:
            if revision != self._revision or not self._allowed or self._ended:
                return None
            await self.coordinator.publish_nora_understanding(self.actor, self.call_id, self.client_id, revision, result)
        return result

    async def _run(self):
        while not self._ended:
            if self._allowed:
                self._iteration = asyncio.create_task(self.refresh())
                try:
                    await self._iteration
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                except Exception:
                    # Do not repeat a potentially billable failed attempt every
                    # five seconds; a fresh explicit consent revision may resume.
                    self.last_error = "Não foi possível atualizar o entendimento da reunião."
                    self._failed_revision = self._revision
                    self._allowed = False
                finally:
                    self._iteration = None
            await asyncio.sleep(5)

    async def close(self):
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        self._ended = True
        for task in (self._iteration, self._loop):
            if task:
                task.cancel()
        if self._loop:
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop
        self._loop = self._iteration = None
