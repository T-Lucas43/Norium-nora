from __future__ import annotations

import asyncio
import io
import struct
import wave

import httpx

from app.modules.team.meeting_pipeline_bridge import MeetingPipelineBridge
from app.modules.team.nora_call_stt import GroqWhisper
from tests.unit.test_call_coordinator import actor, event
from tests.unit.test_meeting_session import CALL, CoordinatorSessionTests
from tests.unit.test_nora_call_agent import FakeMeter


class PipelineBridgeTests(CoordinatorSessionTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.requests = []
        self.provider_started = asyncio.Event()
        self.provider_release = asyncio.Event()
        self.block_provider = False
        async def respond(request):
            self.requests.append(request)
            self.provider_started.set()
            if self.block_provider:
                await self.provider_release.wait()
            data = request.content
            start = data.index(b"RIFF")
            with wave.open(io.BytesIO(data[start:]), "rb") as wav:
                value = struct.unpack("<h", wav.readframes(1))[0]
            return httpx.Response(200, json={"segments": [{"start": 0, "end": 10,
                "text": "Ana confirmou a revisão." if value == 700 else "Bruno informou senha=segredo."}]})
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        self.meter = FakeMeter()
        self.bridge = MeetingPipelineBridge(self.coordinator, actor("owner"), CALL, "owner-tab",
                                             GroqWhisper("synthetic-key", self.client), self.meter)
        await self.bridge.start()

    async def asyncTearDown(self):
        await self.bridge.close()
        await self.client.aclose()
        await super().asyncTearDown()

    def feed(self, user, value=700):
        session_id = self.bridge.pipeline.state.sessions[user]
        for second in range(10):
            self.bridge.feed(user, session_id, struct.pack("<h", value) * 16000, second)

    async def test_two_sources_to_groq_adapter_and_websocket_transcript_with_masking(self):
        self.feed("owner", 700)
        self.feed("member", 900)
        await asyncio.wait_for(self.bridge.pipeline.queue.join(), 3)
        view = await self.coordinator.nora_session_view(actor("member"), CALL, "member-tab")
        self.assertEqual({"owner", "member"}, {segment["userId"] for segment in view["segments"]})
        self.assertEqual("Ana confirmou a revisão.", next(segment["text"] for segment in view["segments"] if segment["userId"] == "owner"))
        self.assertNotIn("senha=segredo", str(view))
        self.assertEqual(2, len(self.requests))
        self.assertEqual(2, len(self.meter.settled))
        self.assertEqual("CALL_NORA_TRANSCRIPT", self.publisher.sent[-1][2]["type"])

    async def test_real_pause_event_cancels_provider_and_clears_pending_audio(self):
        self.block_provider = True
        self.feed("owner")
        await asyncio.wait_for(self.provider_started.wait(), 3)
        await self.coordinator.handle_event(actor("owner"), event("CALL_NORA_CONTROL", enabled=False))
        await asyncio.wait_for(self.bridge.pipeline.queue.join(), 3)
        self.assertFalse(self.bridge.pipeline.state.capture_allowed)
        self.assertEqual({"sent": True, "completed": False}, self.meter.settled[0][1])
        self.assertEqual([], (await self.coordinator.nora_session_view(actor("member"), CALL, "member-tab"))["segments"])

    async def test_ending_call_stops_bridge_and_unregisters_listener(self):
        await self.coordinator.end_call(actor("owner"), CALL)
        self.assertTrue(self.bridge.pipeline.state.ended)
        self.assertFalse(self.bridge.feed("owner", "old", bytes(32000), 0))
        self.assertEqual({}, self.coordinator._runtime("owner").nora_listeners)

    async def test_revoked_entitlement_rechecked_before_provider_send(self):
        self.coordinator._nora_entitled_for_actor = lambda user: False
        self.feed("owner")
        await asyncio.wait_for(self.bridge.pipeline.queue.join(), 3)
        self.assertEqual([], self.requests)
        self.assertEqual({"sent": False, "completed": False}, self.meter.settled[0][1])
