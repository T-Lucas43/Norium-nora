from __future__ import annotations

import asyncio
import unittest

from app.modules.team.meeting_voice import MeetingVoice
from app.modules.team.nora_call_state import NoraCallDenied
from tests.unit.test_nora_call_agent import FakeMeter, consented


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.frames = []
        self.clear_count = 0
        self.meter = FakeMeter()
        self.state = consented()
        self.released = asyncio.Event()
        self.started = asyncio.Event()
        async def speak(text):
            self.started.set()
            yield bytes(640)
            await self.released.wait()
            yield bytes(640)
        async def publish(frame):
            self.frames.append(frame)
        async def clear():
            self.clear_count += 1
        self.voice = MeetingVoice(self.state, meter=self.meter, speak=speak, publish_frame=publish, clear_audio=clear)

    def test_wake_off_by_default_host_only_and_no_action_execution(self):
        self.assertIsNone(self.voice.wake_request("a", "Nora, resuma a reunião"))
        with self.assertRaises(NoraCallDenied):
            self.voice.configure("b", enabled=True, wake_enabled=True)
        self.voice.configure("a", enabled=True, wake_enabled=True)
        self.assertIsNone(self.voice.wake_request("a", "Eu disse Nora, resuma a reunião"))
        self.assertIsNone(self.voice.wake_request("absent", "Nora, envie ao cliente"))
        self.assertEqual({"requestedBy": "b", "question": "envie ao cliente", "status": "proposal"},
                         self.voice.wake_request("b", "Nora, envie ao cliente"))

    async def test_any_participant_can_interrupt_and_cost_remains_uncertain(self):
        self.voice.configure("a", enabled=True, wake_enabled=False)
        await self.voice.start_public("a", "Resposta aprovada para a sala")
        await asyncio.wait_for(self.started.wait(), 2)
        self.assertEqual(1, len(self.frames))
        await self.voice.stop("b")
        self.released.set()
        await asyncio.sleep(0)
        self.assertEqual(1, len(self.frames))
        self.assertGreater(self.clear_count, 0)
        self.assertEqual({"sent": True, "completed": False}, self.meter.settled[0][1])

    async def test_consent_revision_cuts_audio_and_no_second_frame(self):
        self.voice.configure("a", enabled=True, wake_enabled=False)
        await self.voice.start_public("a", "Resposta curta")
        await asyncio.wait_for(self.started.wait(), 2)
        self.state.consent("b", "b1", self.state.revision, False)
        self.released.set()
        await asyncio.wait_for(self.voice._task, 2)
        self.assertEqual(1, len(self.frames))
        self.assertEqual({"sent": True, "completed": False}, self.meter.settled[0][1])

    async def test_private_question_never_invokes_tts_or_publishes(self):
        seen = []
        async def answer(user, question):
            seen.append((user, question))
            return {"text": "Resposta privada senha=segredo", "broadcast": True, "execute": "send"}
        response = await self.voice.answer_private("b", "Pergunta só minha", answer)
        self.assertEqual([("b", "Pergunta só minha")], seen)
        self.assertEqual("b", response["recipientUserId"])
        self.assertTrue(response["private"])
        self.assertNotIn("broadcast", response)
        self.assertNotIn("segredo", response["text"])
        self.assertEqual([], self.frames)
        self.assertEqual([], self.meter.reserved)
        self.assertFalse(self.started.is_set())

    async def test_private_response_refused_after_session_replacement(self):
        async def answer(user, question):
            self.state.sync_members({"a": "a1", "b": "b2"})
            return {"text": "segredo do solicitante"}
        with self.assertRaises(NoraCallDenied):
            await self.voice.answer_private("b", "Pergunta", answer)
