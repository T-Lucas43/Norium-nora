from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest

from app.modules.team.meeting_rtc import LiveKitMicrophoneReceiver
from app.modules.team.nora_call_agent import NoraAudioPipeline
from app.modules.team.nora_call_state import NoraCallDenied
from tests.unit.test_nora_call_agent import FakeMeter, consented


class Publication:
    def __init__(self, sid, kind="audio", source="microphone", track=None):
        self.sid, self.kind, self.source, self.track = sid, kind, source, track
        self.subscriptions = []
    def set_subscribed(self, enabled):
        self.subscriptions.append(enabled)


class Room:
    def __init__(self, participants):
        self.remote_participants = participants
        self.handlers = {}
    def on(self, name, callback):
        self.handlers[name] = callback
    def off(self, name, callback):
        del self.handlers[name]


class RtcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.streams = []
        self.options = []
        self.closed = []
        self.frames = asyncio.Queue()
        outer = self
        class Stream:
            @classmethod
            def from_track(cls, **options):
                outer.options.append(options)
                value = cls()
                outer.streams.append(value)
                return value
            def __aiter__(self):
                return self
            async def __anext__(self):
                value = await outer.frames.get()
                if value is None:
                    raise StopAsyncIteration
                return SimpleNamespace(frame=value)
            async def aclose(self):
                outer.closed.append(self)
        self.rtc = SimpleNamespace(AudioStream=Stream,
                                   TrackKind=SimpleNamespace(KIND_AUDIO="audio"),
                                   TrackSource=SimpleNamespace(SOURCE_MICROPHONE="microphone"))
        self.state = consented()
        class Stt:
            async def transcribe(self, pcm):
                raise AssertionError("No complete audio chunk expected in this test")
        async def publish(values):
            raise AssertionError("No transcript expected")
        self.pipe = NoraAudioPipeline(self.state, Stt(), FakeMeter(), publish)

    async def test_only_authenticated_mapped_microphone_source_subscribed(self):
        mic = Publication("mic")
        camera = Publication("camera", kind="video", source="camera")
        screen = Publication("screen-audio", source="screen_share_audio")
        unknown = Publication("unknown")
        participant = SimpleNamespace(identity="trusted-a", track_publications={p.sid: p for p in (mic, camera, screen)}, metadata='{"userId":"b"}')
        attacker = SimpleNamespace(identity="unknown", track_publications={unknown.sid: unknown}, metadata='{"userId":"a"}')
        room = Room({"a": participant, "unknown": attacker})
        receiver = LiveKitMicrophoneReceiver(rtc=self.rtc, room=room, pipeline=self.pipe, identities={"trusted-a": ("a", "a1")}, elapsed=lambda: 15)
        receiver.attach()
        self.assertEqual([True], mic.subscriptions)
        self.assertEqual([False], camera.subscriptions)
        self.assertEqual([False], screen.subscriptions)
        self.assertEqual([False], unknown.subscriptions)
        self.assertEqual([], self.streams)
        await receiver.close()
        self.assertEqual({}, room.handlers)

    async def test_mono_resample_bounded_sdk_queue_and_pause_closes_stream(self):
        publication = Publication("mic", track="synthetic-track")
        participant = SimpleNamespace(identity="trusted-a", track_publications={"mic": publication})
        room = Room({"a": participant})
        receiver = LiveKitMicrophoneReceiver(rtc=self.rtc, room=room, pipeline=self.pipe, identities={"trusted-a": ("a", "a1")}, elapsed=lambda: 15)
        receiver.attach()
        await asyncio.sleep(0)
        await self.frames.put(SimpleNamespace(sample_rate=16000, num_channels=1, samples_per_channel=320, data=bytes(640)))
        await asyncio.sleep(0)
        self.assertEqual({"track": "synthetic-track", "sample_rate": 16000, "num_channels": 1, "frame_size_ms": 20, "capacity": 8}, self.options[0])
        self.assertEqual(640, len(self.pipe.chunkers["a"].buffer))
        self.state.consent("b", "b1", self.state.revision, False)
        receiver.refresh()
        await asyncio.sleep(0)
        self.assertEqual([self.streams[0]], self.closed)
        self.assertFalse(publication.subscriptions[-1])
        self.assertEqual({}, self.pipe.chunkers)
        await receiver.close()

    async def test_without_consent_does_not_bind_or_subscribe(self):
        self.state.request("a", False)
        room = Room({})
        receiver = LiveKitMicrophoneReceiver(rtc=self.rtc, room=room, pipeline=self.pipe, identities={}, elapsed=lambda: 0)
        with self.assertRaises(NoraCallDenied):
            receiver.attach()
        self.assertEqual({}, room.handlers)
        self.assertEqual([], self.options)
        await receiver.close()
