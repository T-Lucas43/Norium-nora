"""Audio pipeline for a server participant, independent of the RTC SDK.

The trusted supervisor owns room admission, plan checks, membership and leases.
Until that bridge is accepted, this module is exercised with synthetic audio only.
No browser-upload route or automatic media/provider activation is installed.
"""
from __future__ import annotations

import asyncio
import contextlib
import math
import struct
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from app.core.ai_guardrails import minimize_for_ai

from app.modules.team.nora_call_state import NoraConsentState
from app.modules.team.nora_call_stt import SAMPLE_RATE, SpeechToText


class SpeechMeter(Protocol):
    async def reserve(self, event_id: str, duration: float) -> None: ...
    async def settle(self, event_id: str, *, sent: bool, completed: bool) -> None: ...


@dataclass(frozen=True)
class TranscriptSegment:
    id: str
    call_id: str
    user_id: str
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class _Chunk:
    pcm: bytes
    user_id: str
    session_id: str
    revision: int
    start: float


class AgentCapacity:
    """Supervisor-owned capacity. Not a distributed/OS-wide lock."""
    def __init__(self, maximum: int = 2) -> None:
        if not 1 <= maximum <= 2:
            raise ValueError("Capacidade inválida.")
        self.maximum = maximum
        self._active: set[tuple[str, str, str]] = set()

    @contextlib.asynccontextmanager
    async def slot(self, workspace: str, team_id: str, call_id: str):
        key = (workspace, team_id, call_id)
        if not all(key) or key in self._active or len(self._active) >= self.maximum:
            raise RuntimeError("Capacidade da Nora indisponível.")
        self._active.add(key)
        try:
            yield
        finally:
            self._active.discard(key)


class PcmChunker:
    """PCM16 LE mono, already resampled by the RTC adapter to 16 kHz.

    Energy VAD suppresses silent chunks; it is not speaker identification or a
    trained speech classifier. Track ownership provides speaker attribution.
    """
    def __init__(self, seconds: int = 10, threshold: int = 180) -> None:
        if not 5 <= seconds <= 10:
            raise ValueError("Trechos devem durar de 5 a 10 segundos.")
        self.limit = seconds * SAMPLE_RATE * 2
        self.threshold = threshold
        self.buffer = bytearray()
        self.start: float | None = None
        self.voiced = False
        self.previous_end: float | None = None

    def clear(self) -> None:
        self.buffer.clear()
        self.start = None
        self.voiced = False
        self.previous_end = None

    def push(self, pcm: bytes, start: float) -> list[tuple[float, bytes]]:
        if not pcm or len(pcm) % 2 or len(pcm) > SAMPLE_RATE * 2 or not math.isfinite(start) or start < 0:
            raise ValueError("Frame de áudio inválido.")
        if self.previous_end is not None and abs(start - self.previous_end) > 0.05:
            self.clear()
        self.previous_end = start + len(pcm) / (SAMPLE_RATE * 2)
        result = []
        offset = 0
        while offset < len(pcm):
            if self.start is None:
                self.start = start + offset / (SAMPLE_RATE * 2)
            take = min(self.limit - len(self.buffer), len(pcm) - offset)
            piece = pcm[offset:offset + take]
            rms = math.sqrt(sum(sample[0] ** 2 for sample in struct.iter_unpack("<h", piece)) / (len(piece) // 2))
            self.voiced |= rms >= self.threshold
            self.buffer.extend(piece)
            offset += take
            if len(self.buffer) == self.limit:
                if self.voiced:
                    result.append((self.start, bytes(self.buffer)))
                self.buffer.clear()
                self.start = None
                self.voiced = False
        return result


class NoraAudioPipeline:
    def __init__(self, state: NoraConsentState, stt: SpeechToText, meter: SpeechMeter,
                 publish: Callable[[tuple[TranscriptSegment, ...]], Awaitable[None]],
                 before_send: Callable[[], Awaitable[None]] | None = None) -> None:
        self.state, self.stt, self.meter, self.publish = state, stt, meter, publish
        self.before_send = before_send
        self.queue: asyncio.Queue[_Chunk] = asyncio.Queue(maxsize=state.config.queue_size)
        self.chunkers: dict[str, PcmChunker] = {}
        self._revision = state.revision
        self._worker: asyncio.Task | None = None
        self._inflight: asyncio.Task | None = None
        self.dropped_chunks = 0
        self.last_error = ""
        # Bounded recent IDs prevent accidental duplicate sink events.
        self.completed_ids: deque[str] = deque(maxlen=128)

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    def invalidate(self) -> None:
        self._revision = self.state.revision
        self.chunkers.clear()
        while not self.queue.empty():
            self.queue.get_nowait()
            self.queue.task_done()
        if self._inflight and not self._inflight.done():
            self._inflight.cancel()

    def feed(self, user_id: str, session_id: str, pcm: bytes, start: float) -> bool:
        if self._revision != self.state.revision or not self.state.capture_allowed:
            self.invalidate()
        if not self.state.capture_allowed or self.state.sessions.get(user_id) != session_id:
            return False
        chunker = self.chunkers.setdefault(user_id, PcmChunker(self.state.config.chunk_seconds))
        for at, audio in chunker.push(pcm, start):
            chunk = _Chunk(audio, user_id, session_id, self.state.revision, at)
            if self.queue.full():
                # Drop newest instead of retaining an unbounded delayed backlog.
                self.dropped_chunks += 1
            else:
                self.queue.put_nowait(chunk)
        return True

    def _valid(self, chunk: _Chunk) -> bool:
        return (self.state.capture_allowed and chunk.revision == self.state.revision
                and self.state.sessions.get(chunk.user_id) == chunk.session_id)

    async def _process(self, chunk: _Chunk) -> None:
        if not self._valid(chunk):
            return
        event_id = uuid.uuid4().hex
        duration = len(chunk.pcm) / (SAMPLE_RATE * 2)
        # Reservations happen before sending; audio never becomes fake tokens.
        await self.meter.reserve(event_id, duration)
        sent = completed = False
        try:
            if not self._valid(chunk):
                return
            if self.before_send:
                await self.before_send()
            if not self._valid(chunk):
                return
            sent = True
            segments = await self.stt.transcribe(chunk.pcm)
            completed = True
            if not self._valid(chunk):
                return
            values = tuple(TranscriptSegment(f"{event_id}:{index}", self.state.call_id, chunk.user_id,
                                             chunk.start + item.start, chunk.start + item.end,
                                             minimize_for_ai(item.text, max_chars=2000))
                           for index, item in enumerate(segments))
            if values:
                await self.publish(values)
            self.completed_ids.append(event_id)
        finally:
            # Cancellation after dispatch is uncertain/billable, never refunded
            # automatically. A new consent revision cannot publish the old text.
            await asyncio.shield(self.meter.settle(event_id, sent=sent, completed=completed))

    async def _run(self) -> None:
        try:
            while True:
                chunk = await self.queue.get()
                try:
                    self._inflight = asyncio.create_task(self._process(chunk))
                    try:
                        await self._inflight
                    except asyncio.CancelledError:
                        if asyncio.current_task().cancelling():
                            raise
                    except Exception:
                        # No raw provider exception, audio or text in state/logs.
                        self.last_error = "Transcrição pausada por falha de processamento."
                        self.state.requested = False
                        self.state.revision += 1
                        self.state.consents.clear()
                        self.invalidate()
                finally:
                    self._inflight = None
                    self.queue.task_done()
        finally:
            self.invalidate()

    async def close(self) -> None:
        self.state.finish()
        self.invalidate()
        if self._worker:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
        self._worker = None
