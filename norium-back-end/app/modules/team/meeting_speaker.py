"""Nora PCM publisher for an already connected, reviewed RTC agent profile.

No token is created and no room is joined here. Human profiles are refused.
The media supervisor must close this publisher on end, pause or permission loss.
"""
from __future__ import annotations

import asyncio

from app.modules.team.nora_call_state import NoraCallDenied


class LiveKitNoraSpeaker:
    def __init__(self, *, rtc, room):
        self.rtc, self.room = rtc, room
        self.source = None
        self.track = None
        self.publication = None
        self._epoch = 0
        self._lock = asyncio.Lock()

    def _check_profile(self):
        participant = self.room.local_participant
        permissions = participant.permissions
        microphone = self.rtc.TrackSource.SOURCE_MICROPHONE
        if (participant.identity != "nora" or permissions is None
                or not permissions.can_publish or permissions.can_publish_data
                or set(permissions.can_publish_sources) != {microphone}):
            raise NoraCallDenied("Perfil de voz da Nora indisponível nesta sala.")

    async def open(self):
        self._check_profile()
        async with self._lock:
            if self.source is not None:
                raise RuntimeError("Voz RTC da Nora já aberta.")
            source = self.rtc.AudioSource(16000, 1, queue_size_ms=200)
            track = self.rtc.LocalAudioTrack.create_audio_track("Nora", source)
            try:
                publication = await self.room.local_participant.publish_track(
                    track, self.rtc.TrackPublishOptions(source=self.rtc.TrackSource.SOURCE_MICROPHONE))
            except BaseException:
                await source.aclose()
                raise
            self.source, self.track, self.publication = source, track, publication

    async def publish_frame(self, data: bytes):
        self._check_profile()
        if not isinstance(data, bytes) or not data or len(data) % 2 or len(data) > 32000:
            raise ValueError("Frame PCM da Nora inválido.")
        epoch = self._epoch
        async with self._lock:
            if self.source is None or epoch != self._epoch:
                return
            frame = self.rtc.AudioFrame(data=data, sample_rate=16000, num_channels=1,
                                        samples_per_channel=len(data) // 2)
            await self.source.capture_frame(frame)

    async def clear_audio(self):
        # Fencing happens before waiting for the lock. The SDK queue is then
        # cleared; this cannot retract frames already received by human peers.
        self._epoch += 1
        async with self._lock:
            if self.source is not None:
                self.source.clear_queue()

    async def close(self):
        self._epoch += 1
        async with self._lock:
            source, publication = self.source, self.publication
            self.source = self.track = self.publication = None
            if source:
                source.clear_queue()
                try:
                    if publication:
                        await self.room.local_participant.unpublish_track(publication.sid)
                finally:
                    await source.aclose()
