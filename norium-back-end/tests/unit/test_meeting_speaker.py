from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from app.modules.team.meeting_speaker import LiveKitNoraSpeaker
from app.modules.team.nora_call_state import NoraCallDenied


class SpeakerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.source = SimpleNamespace(capture_frame=AsyncMock(), clear_queue=Mock(), aclose=AsyncMock())
        self.rtc = SimpleNamespace(AudioSource=Mock(return_value=self.source),
                                   LocalAudioTrack=SimpleNamespace(create_audio_track=Mock(return_value="nora-audio-track")),
                                   AudioFrame=lambda **values: SimpleNamespace(**values),
                                   TrackPublishOptions=lambda **values: SimpleNamespace(**values),
                                   TrackSource=SimpleNamespace(SOURCE_MICROPHONE=2))
        self.participant = SimpleNamespace(identity="nora", permissions=SimpleNamespace(can_publish=True,
                                           can_publish_data=False, can_publish_sources=[2]),
                                           publish_track=AsyncMock(return_value=SimpleNamespace(sid="audio-publication")),
                                           unpublish_track=AsyncMock())
        self.speaker = LiveKitNoraSpeaker(rtc=self.rtc, room=SimpleNamespace(local_participant=self.participant))

    async def test_publishes_only_pcm_microphone_and_clear_unpublish_on_close(self):
        await self.speaker.open()
        self.rtc.AudioSource.assert_called_once_with(16000, 1, queue_size_ms=200)
        self.assertEqual(2, self.participant.publish_track.call_args.args[1].source)
        await self.speaker.publish_frame(bytes(640))
        frame = self.source.capture_frame.call_args.args[0]
        self.assertEqual((16000, 1, 320), (frame.sample_rate, frame.num_channels, frame.samples_per_channel))
        await self.speaker.clear_audio()
        self.source.clear_queue.assert_called()
        await self.speaker.close()
        self.participant.unpublish_track.assert_awaited_once_with("audio-publication")
        self.source.aclose.assert_awaited_once()

    async def test_human_or_broad_publish_grants_refused_before_media_allocation(self):
        for identity, sources, data in [("human", [2], False), ("nora", [1, 2], False), ("nora", [2], True)]:
            self.participant.identity = identity
            self.participant.permissions.can_publish_sources = sources
            self.participant.permissions.can_publish_data = data
            with self.assertRaises(NoraCallDenied):
                await self.speaker.open()
        self.rtc.AudioSource.assert_not_called()

    async def test_profile_revocation_refuses_next_frame(self):
        await self.speaker.open()
        self.participant.permissions.can_publish = False
        with self.assertRaises(NoraCallDenied):
            await self.speaker.publish_frame(bytes(640))
        self.source.capture_frame.assert_not_awaited()
        await self.speaker.close()
