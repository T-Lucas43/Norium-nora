from __future__ import annotations

import unittest

import httpx

from app.modules.team.meeting_tts import ElevenLabsMeetingStream, MeetingSpeechUnavailable


class TtsTests(unittest.IsolatedAsyncioTestCase):
    async def test_pcm_stream_endpoint_bounded_frames_and_secret_minimized(self):
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(200, content=bytes(1282))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = ElevenLabsMeetingStream(api_key="synthetic-key", alice_voice_id="syntheticAlice12345", client=client)
            frames = [frame async for frame in provider.stream("Olá senha=segredo")]
        self.assertEqual([640, 640, 2], [len(frame) for frame in frames])
        self.assertNotIn(b"senha=segredo", requests[0].content)
        self.assertEqual("pcm_16000", requests[0].url.params["output_format"])
        self.assertTrue(requests[0].url.path.endswith("/syntheticAlice12345/stream"))

    async def test_no_guessed_voice_and_provider_errors_no_retry_or_leak(self):
        async with httpx.AsyncClient() as client:
            with self.assertRaises(MeetingSpeechUnavailable):
                ElevenLabsMeetingStream(api_key="synthetic-key", alice_voice_id="", client=client)
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(402, content=b"private-provider-detail")
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = ElevenLabsMeetingStream(api_key="synthetic-key", alice_voice_id="syntheticAlice12345", client=client)
            with self.assertRaises(MeetingSpeechUnavailable) as exc:
                [frame async for frame in provider.stream("Resposta")]
        self.assertEqual(1, len(requests))
        self.assertNotIn("private-provider-detail", str(exc.exception))

    async def test_odd_pcm_tail_rejected(self):
        def respond(request):
            return httpx.Response(200, content=bytes(641))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = ElevenLabsMeetingStream(api_key="synthetic-key", alice_voice_id="syntheticAlice12345", client=client)
            with self.assertRaises(MeetingSpeechUnavailable):
                [frame async for frame in provider.stream("Resposta")]
