"""Audio-only RTC adapter for an already-authorized server room.

No token issuance/refresh or SDK import happens here. A reviewed supervisor must
provide the SDK module, connected room and identity/session map from its issuer.
Participant-supplied metadata is never used as proof of speaker identity.
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Callable, Mapping

from app.modules.team.nora_call_agent import NoraAudioPipeline
from app.modules.team.nora_call_state import NoraCallDenied


class LiveKitMicrophoneReceiver:
    def __init__(self, *, rtc, room, pipeline: NoraAudioPipeline,
                 identities: Mapping[str, tuple[str, str]], elapsed: Callable[[], float]):
        self.rtc, self.room, self.pipeline = rtc, room, pipeline
        self.identities, self.elapsed = dict(identities), elapsed
        self._tasks: dict[str, asyncio.Task] = {}
        self._streams: dict[str, object] = {}
        self._handlers = []
        self._revision = pipeline.state.revision
        self.closed = False
        self.last_error = ""

    def _eligible(self, publication, participant) -> tuple[str, str] | None:
        value = self.identities.get(participant.identity)
        if (self.closed or not self.pipeline.state.capture_allowed or not value
                or self.pipeline.state.sessions.get(value[0]) != value[1]
                or publication.kind != self.rtc.TrackKind.KIND_AUDIO
                or publication.source != self.rtc.TrackSource.SOURCE_MICROPHONE):
            return None
        return value

    def attach(self) -> None:
        if not self.pipeline.state.capture_allowed:
            raise NoraCallDenied("Áudio da reunião ainda não autorizado.")
        if self._handlers or self.closed:
            raise RuntimeError("Receptor de áudio já configurado.")
        for name, callback in [("track_published", self._published), ("track_subscribed", self._subscribed),
                               ("track_unsubscribed", self._unsubscribed)]:
            self.room.on(name, callback)
            self._handlers.append((name, callback))
        self.pipeline.start()
        self.refresh()

    def _published(self, publication, participant) -> None:
        publication.set_subscribed(self._eligible(publication, participant) is not None)

    def refresh(self) -> None:
        revision_changed = self._revision != self.pipeline.state.revision
        self._revision = self.pipeline.state.revision
        if revision_changed or not self.pipeline.state.capture_allowed:
            self.pipeline.invalidate()
            for task in self._tasks.values():
                task.cancel()
        for participant in self.room.remote_participants.values():
            for publication in participant.track_publications.values():
                self._published(publication, participant)
                track = getattr(publication, "track", None)
                if track is not None and publication.sid not in self._tasks:
                    self._subscribed(track, publication, participant)

    def _subscribed(self, track, publication, participant) -> None:
        identity = self._eligible(publication, participant)
        if identity is None:
            publication.set_subscribed(False)
            return
        if publication.sid in self._tasks:
            return
        task = asyncio.create_task(self._consume(track, publication.sid, identity, self.pipeline.state.revision))
        self._tasks[publication.sid] = task
        def finished(done):
            if self._tasks.get(publication.sid) is done:
                self._tasks.pop(publication.sid, None)
            if not done.cancelled() and done.exception() is not None:
                self.last_error = "Recepção de áudio interrompida."
                self.pipeline.state.requested = False
                self.pipeline.state.revision += 1
                self.pipeline.state.consents.clear()
                self.pipeline.invalidate()
        task.add_done_callback(finished)

    def _unsubscribed(self, track, publication, participant) -> None:
        task = self._tasks.get(publication.sid)
        if task:
            task.cancel()
        self.pipeline.chunkers.pop(self.identities.get(participant.identity, ("", ""))[0], None)

    async def _consume(self, track, sid: str, identity: tuple[str, str], revision: int) -> None:
        stream = self.rtc.AudioStream.from_track(track=track, sample_rate=16000, num_channels=1,
                                                frame_size_ms=20, capacity=8)
        self._streams[sid] = stream
        origin = self.elapsed()
        samples = 0
        try:
            async for event in stream:
                frame = event.frame
                if (revision != self.pipeline.state.revision or not self.pipeline.state.capture_allowed
                        or self.pipeline.state.sessions.get(identity[0]) != identity[1]):
                    return
                if (frame.sample_rate != 16000 or frame.num_channels != 1
                        or not 1 <= frame.samples_per_channel <= 16000):
                    raise ValueError("Formato de áudio inesperado.")
                pcm = bytes(frame.data)
                if len(pcm) != frame.samples_per_channel * 2:
                    raise ValueError("Frame de áudio inválido.")
                self.pipeline.feed(identity[0], identity[1], pcm, origin + samples / 16000)
                samples += frame.samples_per_channel
        finally:
            self._streams.pop(sid, None)
            await stream.aclose()

    async def close(self) -> None:
        self.closed = True
        for name, callback in self._handlers:
            self.room.off(name, callback)
        self._handlers.clear()
        self.refresh()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        await self.pipeline.close()
