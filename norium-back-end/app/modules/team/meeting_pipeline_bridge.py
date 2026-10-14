"""Connects the bounded audio pipeline to the existing call lifecycle.

The reviewed media supervisor supplies STT/meter and admitted microphone frames.
This bridge never issues credentials, creates a process, captures browser audio,
or grants entitlement. Consent/roster changes synchronously cancel queued STT.
"""
from __future__ import annotations

from typing import Callable

from app.modules.team.call_coordinator import CallActor, CallCoordinator
from app.modules.team.nora_call_agent import NoraAudioPipeline, SpeechMeter
from app.modules.team.nora_call_state import NoraConsentState
from app.modules.team.nora_call_stt import SpeechToText


class MeetingPipelineBridge:
    def __init__(self, coordinator: CallCoordinator, actor: CallActor, call_id: str,
                 client_id: str, stt: SpeechToText, meter: SpeechMeter):
        self.coordinator, self.actor = coordinator, actor
        self.call_id, self.client_id = call_id, client_id
        self.stt, self.meter = stt, meter
        self.pipeline: NoraAudioPipeline | None = None
        self._unsubscribe: Callable[[], None] | None = None

    def _policy_changed(self, state: NoraConsentState | None) -> None:
        if state is None:
            if self.pipeline:
                self.pipeline.state.finish()
                self.pipeline.invalidate()
            return
        if self.pipeline is None:
            async def publish(segments):
                await self.coordinator.publish_nora_segments(self.actor, self.call_id, self.client_id,
                                                            self.pipeline.state.revision, segments)
            async def before_send():
                await self.coordinator.authorize_nora_capture(self.actor, self.call_id, self.client_id,
                                                             self.pipeline.state.revision)
            self.pipeline = NoraAudioPipeline(state, self.stt, self.meter, publish, before_send)
        else:
            changed = self.pipeline.state.revision != state.revision
            self.pipeline.state = state
            if changed or not state.capture_allowed:
                self.pipeline.invalidate()

    async def start(self) -> None:
        if self._unsubscribe is not None:
            raise RuntimeError("Ponte da Nora já iniciada.")
        self._unsubscribe = await self.coordinator.subscribe_nora_policy(self.actor, self.call_id, self.client_id,
                                                                       self._policy_changed)
        self.pipeline.start()

    def feed(self, user_id: str, session_id: str, pcm: bytes, at: float) -> bool:
        return bool(self.pipeline and self.pipeline.feed(user_id, session_id, pcm, at))

    async def close(self) -> None:
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        if self.pipeline:
            await self.pipeline.close()
            self.pipeline = None
