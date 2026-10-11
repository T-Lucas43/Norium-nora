import json
import os
import unittest
from unittest.mock import patch

import httpx

from app.modules.nora import router as nora_router


REAL_ASYNC_CLIENT = httpx.AsyncClient


def client_factory(handler):
    def build(**kwargs):
        return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kwargs)

    return build


async def collect(response) -> bytes:
    data = b""
    async for chunk in response.body_iterator:
        data += chunk
    return data


async def fake_edge_stream():
    yield b"edge-audio"


class NoraElevenLabsVoiceTests(unittest.IsolatedAsyncioTestCase):
    env = {"NORA_TTS_PROVIDER": "elevenlabs", "ELEVENLABS_API_KEY": "test-key", "ELEVENLABS_VOICE_ID": ""}

    async def test_streams_alice_voice_progressively_and_ignores_client_voice(self) -> None:
        requests: list[httpx.Request] = []

        async def chunks():
            yield b"part-1"
            yield b"part-2"

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=chunks(), headers={"content-type": "audio/mpeg"})

        payload = nora_router.NoraVoicePayload(text="Olá, tudo bem?", voice_id="voz-escolhida-pelo-cliente")
        with patch.dict(os.environ, self.env), patch.object(nora_router.httpx, "AsyncClient", side_effect=client_factory(handler)):
            response = await nora_router.gerar_voz_nora(payload, {})
            audio = await collect(response)

        self.assertEqual(b"part-1part-2", audio)
        self.assertEqual("progressive", response.headers["x-norium-audio-mode"])
        self.assertEqual("elevenlabs", response.headers["x-norium-voice-provider"])
        self.assertEqual(1, len(requests))
        self.assertIn("/v1/text-to-speech/Xb7hH8MSUJpSbSDYk0k2/stream", str(requests[0].url))
        body = json.loads(requests[0].content)
        self.assertEqual("eleven_flash_v2_5", body["model_id"])
        self.assertEqual("pt", body["language_code"])
        self.assertNotIn("voz-escolhida-pelo-cliente", str(requests[0].url))

    async def test_falls_back_to_edge_when_elevenlabs_has_no_credits(self) -> None:
        payload = nora_router.NoraVoicePayload(text="Bom dia")
        with (
            patch.dict(os.environ, self.env),
            patch.object(nora_router.httpx, "AsyncClient", side_effect=client_factory(lambda _r: httpx.Response(402))),
            patch.object(nora_router, "gerar_audio_edge_tts_stream", return_value=fake_edge_stream()),
        ):
            response = await nora_router.gerar_voz_nora(payload, {})
            audio = await collect(response)

        self.assertEqual(b"edge-audio", audio)
        self.assertEqual("edge-tts", response.headers["x-norium-voice-provider"])

    async def test_falls_back_to_edge_when_provider_is_unreachable(self) -> None:
        def handler(_request):
            raise httpx.ConnectError("offline")

        payload = nora_router.NoraVoicePayload(text="Bom dia")
        with (
            patch.dict(os.environ, self.env),
            patch.object(nora_router.httpx, "AsyncClient", side_effect=client_factory(handler)),
            patch.object(nora_router, "gerar_audio_edge_tts_stream", return_value=fake_edge_stream()),
        ):
            response = await nora_router.gerar_voz_nora(payload, {})

        self.assertEqual("edge-tts", response.headers["x-norium-voice-provider"])

    async def test_auto_provider_uses_edge_without_api_key(self) -> None:
        payload = nora_router.NoraVoicePayload(text="Bom dia")
        with (
            patch.dict(os.environ, {"NORA_TTS_PROVIDER": "auto", "ELEVENLABS_API_KEY": ""}),
            patch.object(nora_router, "gerar_audio_edge_tts_stream", return_value=fake_edge_stream()),
        ):
            response = await nora_router.gerar_voz_nora(payload, {})

        self.assertEqual("edge-tts", response.headers["x-norium-voice-provider"])

    async def test_voice_route_has_its_own_rate_limit_bucket(self) -> None:
        from app.bootstrap import rate_limit_bucket

        self.assertEqual("voice", rate_limit_bucket("/api/nora/voz"))
        self.assertEqual("ai", rate_limit_bucket("/api/nora/natural"))


if __name__ == "__main__":
    unittest.main()
