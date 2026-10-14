"""Voice control policy with injected streaming and room publication boundaries.

This does not grant RTC publish rights or activate a provider. Private questions
return text to the requester and can never reach the room TTS/publication path.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import uuid
from typing import AsyncIterator, Awaitable, Callable

from app.core.ai_guardrails import minimize_for_ai
from app.modules.team.nora_call_agent import SpeechMeter
from app.modules.team.nora_call_state import NoraCallDenied, NoraConsentState

WAKE = re.compile(r"^\s*nora\s*[,.:!?-]\s*(\S[\s\S]{0,999})$", re.I)


class MeetingVoice:
    def __init__(self, state: NoraConsentState, *, meter: SpeechMeter,
                 speak: Callable[[str], AsyncIterator[bytes]],
                 publish_frame: Callable[[bytes], Awaitable[None]],
                 clear_audio: Callable[[], Awaitable[None]]):
        self.state, self.meter = state, meter
        self.speak, self.publish_frame, self.clear_audio = speak, publish_frame, clear_audio
        self.enabled = False
        self.wake_enabled = False
        self._task: asyncio.Task | None = None
        self._epoch = 0
        self._lock = asyncio.Lock()
        self.requested_by: str | None = None

    def configure(self, host_user_id: str, *, enabled: bool, wake_enabled: bool) -> None:
        if host_user_id != self.state.host_user_id or host_user_id not in self.state.sessions:
            raise NoraCallDenied("Somente o organizador presente pode configurar a voz.")
        if type(enabled) is not bool or type(wake_enabled) is not bool:
            raise NoraCallDenied("Configuração de voz inválida.")
        if not enabled and self._task and not self._task.done():
            # Immediate fence; the supervisor still awaits stop() to drain output.
            self._epoch += 1
            self._task.cancel()
        self.enabled, self.wake_enabled = enabled, enabled and wake_enabled

    def wake_request(self, user_id: str, text: str) -> dict | None:
        if not self.enabled or not self.wake_enabled or not self.state.capture_allowed or user_id not in self.state.sessions:
            return None
        match = WAKE.fullmatch(minimize_for_ai(text, max_chars=1100))
        if not match:
            return None
        # A request proposal only: no action, automatic answer or authorization.
        return {"requestedBy": user_id, "question": match.group(1), "status": "proposal"}

    async def answer_private(self, user_id: str, question: str,
                             answer: Callable[[str, str], Awaitable[dict]]) -> dict:
        if user_id not in self.state.sessions or self.state.ended:
            raise NoraCallDenied("Pergunta privada indisponível nesta sessão.")
        text = minimize_for_ai(question, max_chars=1000).strip()
        if not text:
            raise ValueError("Pergunta vazia.")
        session = self.state.sessions[user_id]
        result = await answer(user_id, text)
        if self.state.ended or self.state.sessions.get(user_id) != session:
            raise NoraCallDenied("Sessão da pergunta privada foi encerrada.")
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise ValueError("Resposta privada indisponível.")
        # Deliberately strips any provider-generated public routing/action fields.
        return {"recipientUserId": user_id, "text": minimize_for_ai(result["text"], max_chars=4000),
                "private": True}

    async def start_public(self, user_id: str, text: str) -> None:
        if not self.enabled or not self.state.capture_allowed or user_id not in self.state.sessions:
            raise NoraCallDenied("Voz da Nora indisponível nesta reunião.")
        value = minimize_for_ai(text, max_chars=1800).strip()
        if not value:
            raise ValueError("Resposta vazia.")
        async with self._lock:
            await self._stop_locked()
            epoch, revision = self._epoch, self.state.revision
            self.requested_by = user_id
            self._task = asyncio.create_task(self._stream(value, epoch, revision))

    async def _stream(self, text: str, epoch: int, revision: int) -> None:
        event_id = uuid.uuid4().hex
        reserved = sent = completed = False
        try:
            await self.meter.reserve(event_id, len(text))
            reserved = True
            if epoch != self._epoch or not self.state.capture_allowed or revision != self.state.revision:
                return
            sent = True
            byte_count = 0
            async for frame in self.speak(text):
                if epoch != self._epoch or revision != self.state.revision or not self.state.capture_allowed:
                    return
                # RTC adapter supplies PCM16 mono 16kHz, max one second/frame,
                # max two minutes/answer. Raw MP3 must not enter this boundary.
                if not isinstance(frame, bytes) or not frame or len(frame) % 2 or len(frame) > 32000:
                    raise ValueError("Frame de voz inválido.")
                byte_count += len(frame)
                if byte_count > 120 * 32000:
                    raise ValueError("Limite de voz atingido.")
                await self.publish_frame(frame)
            completed = True
        finally:
            if reserved:
                await asyncio.shield(self.meter.settle(event_id, sent=sent, completed=completed))
            await asyncio.shield(self.clear_audio())

    async def _stop_locked(self) -> None:
        self._epoch += 1
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self._task = None
        self.requested_by = None
        await self.clear_audio()

    async def stop(self, user_id: str) -> None:
        if user_id not in self.state.sessions:
            raise NoraCallDenied("Participante ausente da reunião.")
        async with self._lock:
            await self._stop_locked()
