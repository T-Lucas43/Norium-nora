from __future__ import annotations

import asyncio
import io
import json
import struct
import unittest
import wave

import httpx

from app.modules.team.nora_call_agent import AgentCapacity, NoraAudioPipeline, PcmChunker
from app.modules.team.nora_call_state import NoraCallConfig, NoraCallDenied, NoraConsentState
from app.modules.team.nora_call_stt import GroqWhisper, SpeechSegment, TranscriptionUnavailable, parse_segments, wav_bytes


def consented() -> NoraConsentState:
    state = NoraConsentState("call_test", "a", NoraCallConfig(enabled=True, chunk_seconds=5), True, "sfu")
    state.sync_members({"a": "a1", "b": "b1"})
    state.request("a", True)
    for user, session in state.sessions.items():
        state.consent(user, session, state.revision, True)
    return state


class FakeMeter:
    def __init__(self):
        self.reserved = []
        self.settled = []
    async def reserve(self, event_id, duration):
        self.reserved.append((event_id, duration))
    async def settle(self, event_id, **state):
        self.settled.append((event_id, state))


class ConsentTests(unittest.TestCase):
    def test_every_participant_required_and_real_connected_state(self):
        state = consented()
        self.assertTrue(state.capture_allowed)
        self.assertEqual("awaiting_agent", state.snapshot()["state"])
        self.assertEqual("listening", state.snapshot(connected=True)["state"])
        state.consent("b", "b1", state.revision, False)
        self.assertFalse(state.capture_allowed)
        self.assertEqual(["a", "b"], state.snapshot()["pendingUserIds"])

    def test_roster_session_change_and_old_revision_are_fenced(self):
        state = consented()
        old = state.revision
        state.sync_members({"a": "a1", "b": "b2", "c": "c1"})
        self.assertFalse(state.capture_allowed)
        for user, session, revision in [("b", "b1", state.revision), ("a", "a1", old)]:
            with self.assertRaises(NoraCallDenied):
                state.consent(user, session, revision, True)

    def test_disabled_entitlement_mesh_and_nonhost_cannot_activate(self):
        for config, entitled, transport in [(NoraCallConfig(), True, "sfu"), (NoraCallConfig(enabled=True), False, "sfu"), (NoraCallConfig(enabled=True), True, "mesh")]:
            state = NoraConsentState("call_test", "a", config, entitled, transport)
            state.sync_members({"a": "a1"})
            with self.assertRaises(NoraCallDenied):
                state.request("a", True)
        state = consented()
        with self.assertRaises(NoraCallDenied):
            state.request("b", False)
        state.finish()
        self.assertFalse(state.capture_allowed)

    def test_silence_suppression_buffer_bound_and_timestamp_gap(self):
        chunker = PcmChunker(5)
        for second in range(5):
            self.assertEqual([], chunker.push(bytes(32000), second))
            self.assertLess(len(chunker.buffer), 160000)
        audio = struct.pack("<h", 800) * 16000
        chunker.push(audio, 10)
        for second in range(20, 24):
            self.assertEqual([], chunker.push(audio, second))
        chunks = chunker.push(audio, 24)
        self.assertEqual(20, chunks[0][0])
        self.assertEqual(160000, len(chunks[0][1]))


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def feed_chunk(self, pipeline, user="a", value=800, start=0):
        audio = struct.pack("<h", value) * 16000
        for second in range(5):
            pipeline.feed(user, user + "1", audio, start + second)

    async def test_two_tracks_preserve_speaker_and_timeline(self):
        class Stt:
            async def transcribe(self, pcm):
                value = struct.unpack_from("<h", pcm)[0]
                return (SpeechSegment(0, 5, "Ana decidiu" if value == 800 else "Bruno confirmou"),)
        published = []
        async def publish(values):
            published.extend(values)
        meter = FakeMeter()
        pipe = NoraAudioPipeline(consented(), Stt(), meter, publish)
        pipe.start()
        try:
            self.feed_chunk(pipe, "a", 800)
            self.feed_chunk(pipe, "b", 900, 15)
            await asyncio.wait_for(pipe.queue.join(), 2)
            self.assertEqual([("a", 0, "Ana decidiu"), ("b", 15, "Bruno confirmou")],
                             [(item.user_id, item.start, item.text) for item in published])
            self.assertEqual(2, len(meter.settled))
        finally:
            await pipe.close()

    async def test_withdrawal_cancels_inflight_and_clears_queue(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        class Stt:
            async def transcribe(self, pcm):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
        async def publish(values):
            self.fail("Withdrawn text must never publish")
        state = consented()
        meter = FakeMeter()
        pipe = NoraAudioPipeline(state, Stt(), meter, publish)
        pipe.start()
        try:
            self.feed_chunk(pipe)
            await asyncio.wait_for(started.wait(), 2)
            self.feed_chunk(pipe, start=5)
            state.consent("b", "b1", state.revision, False)
            pipe.invalidate()
            await asyncio.wait_for(cancelled.wait(), 2)
            await asyncio.wait_for(pipe.queue.join(), 2)
            self.assertEqual([], list(pipe.completed_ids))
            self.assertEqual({"sent": True, "completed": False}, meter.settled[0][1])
            self.assertEqual({}, pipe.chunkers)
        finally:
            await pipe.close()

    async def test_no_consent_no_capture_or_provider_and_backpressure_bounded(self):
        class Stt:
            async def transcribe(self, pcm):
                self.fail("No provider request expected")
        async def publish(values):
            pass
        state = consented()
        pipe = NoraAudioPipeline(state, Stt(), FakeMeter(), publish)
        for index in range(12):
            self.feed_chunk(pipe, start=index * 5)
        self.assertEqual(4, pipe.queue.qsize())
        self.assertEqual(8, pipe.dropped_chunks)
        state.request("a", False)
        self.assertFalse(pipe.feed("a", "a1", bytes(32000), 60))
        self.assertEqual(0, pipe.queue.qsize())
        await pipe.close()

    async def test_capacity_scoped_and_released_on_error(self):
        capacity = AgentCapacity(2)
        async with capacity.slot("primary", "t1", "call"):
            async with capacity.slot("primary", "t2", "call"):
                with self.assertRaises(RuntimeError):
                    async with capacity.slot("primary", "t3", "call"):
                        pass
                with self.assertRaises(RuntimeError):
                    async with capacity.slot("primary", "t1", "call"):
                        pass
        async with capacity.slot("primary", "t3", "call"):
            pass


class GroqTests(unittest.IsolatedAsyncioTestCase):
    async def test_wav_multipart_pt_masking_and_no_retry(self):
        seen = []
        def respond(request):
            seen.append(request)
            return httpx.Response(200, json={"segments": [{"start": 0, "end": 4, "text": "CPF 123.456.789-00 senha=segredo"}]})
        pcm = bytes(160000)
        with wave.open(io.BytesIO(wav_bytes(pcm)), "rb") as wav:
            self.assertEqual((1, 2, 16000), (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await GroqWhisper("synthetic-key", client).transcribe(pcm)
        self.assertNotIn("123.456", result[0].text)
        self.assertNotIn("segredo", result[0].text)
        self.assertEqual(1, len(seen))
        self.assertEqual(GroqWhisper.endpoint, str(seen[0].url))
        self.assertIn(b"whisper-large-v3-turbo", seen[0].content)
        self.assertIn(b"verbose_json", seen[0].content)
        self.assertIn(b"\r\npt\r\n", seen[0].content)

    async def test_errors_oversize_and_redirect_do_not_retry_or_leak(self):
        for status, body in [(500, b"provider-secret"), (307, b""), (200, b"x" * 131073), (200, b"invalid-json")]:
            seen = []
            def respond(request):
                seen.append(request)
                return httpx.Response(status, content=body, headers={"Location": "https://example.test/secret"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                with self.assertRaises(TranscriptionUnavailable) as exc:
                    await GroqWhisper("synthetic-key", client).transcribe(bytes(160000))
            self.assertNotIn("provider-secret", str(exc.exception))
            self.assertEqual(1, len(seen))

    async def test_provider_timestamps_validated(self):
        for start, end in [(True, 4), (0, float("nan")), (-1, 3), (3, 2), (0, 90)]:
            with self.assertRaises(TranscriptionUnavailable):
                parse_segments({"segments": [{"start": start, "end": end, "text": "teste"}]}, 5)
