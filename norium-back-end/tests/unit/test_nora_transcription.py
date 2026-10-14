import base64
import os
import unittest
from unittest.mock import AsyncMock, patch

from app.modules.nora import router as nora_router
from app.services import nora_transcription as stt
from fastapi import HTTPException


class _Meter:
    attempts = []
    def __init__(self, *args, **kwargs):
        self.started = False
        self.max_output = args[2]
        self.records = []
        self.attempts.append(self)
    async def __aenter__(self): return self
    async def __aexit__(self, *_): return None
    def sent(self): self.started = True
    def rejected(self): self.started = False
    async def record(self, data, text=""):
        self.records.append(data)
        usage = data.get("usage") or {}
        return {"outputTokens": usage.get("completion_tokens", len(text)), "estimated": not bool(usage), "ledgerId": "synthetic-ledger"}


class _Response:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


class _Client:
    def __init__(self, responses: list[_Response]) -> None:
        self.responses = responses
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def post(self, _url: str, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


class NoraTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_transient_provider_failure_and_normalizes_mime_type(self) -> None:
        client = _Client([_Response(503), _Response(200, {"text": "experiência profissional em dados"})])
        audio = base64.b64encode(b"audio" * 20).decode("ascii")
        payload = nora_router.NoraTranscriptionPayload(
            audio_data_url=f"data:audio/webm;base64,{audio}",
            mime_type="audio/webm;codecs=opus",
        )
        with (
            patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}),
            patch.object(nora_router.httpx, "AsyncClient", return_value=client),
            patch.object(nora_router.asyncio, "sleep", new=AsyncMock()),
            patch.object(stt, "Meter", _Meter),
        ):
            result = await nora_router.transcrever_voz_nora(payload, {"id": "transcriber", "role": "owner"})

        self.assertEqual("experiência profissional em dados", result["text"])
        self.assertEqual(2, len(client.calls))
        self.assertEqual("audio/webm", client.calls[0]["files"]["file"][2])

    async def test_output_is_masked_and_decoder_tokens_measured(self):
        _Meter.attempts = []
        client = _Client([_Response(200, {"text": "CPF 123.456.789-09", "segments": [{"tokens": [1, 2, 3]}]})])
        audio = base64.b64encode(b"audio"*20).decode()
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key", "NORIUM_AI_PROVIDER_POLICY": ""}), patch.object(stt.httpx, "AsyncClient", return_value=client), patch.object(stt, "Meter", _Meter):
            result = await stt.transcribe("data:audio/webm;base64,"+audio, "audio/webm", {"id": "transcriber"})
        self.assertNotIn("123.456.789-09", result["text"])
        self.assertEqual(3, result["usage"]["outputTokens"])
        self.assertFalse(result["usage"]["estimated"])
        self.assertEqual("verbose_json", client.calls[0]["data"]["response_format"])

    async def test_missing_provider_tokens_are_labeled_estimated(self):
        client = _Client([_Response(200, {"text": "Texto transcrito"})])
        audio = base64.b64encode(b"audio"*20).decode()
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key", "NORIUM_AI_PROVIDER_POLICY": ""}), patch.object(stt.httpx, "AsyncClient", return_value=client), patch.object(stt, "Meter", _Meter):
            result = await stt.transcribe(audio, "audio/webm", {"id": "transcriber"})
        self.assertTrue(result["usage"]["estimated"])

    async def test_denied_provider_never_uploads_audio(self):
        with patch.dict(os.environ, {"NORIUM_AI_PROVIDER_POLICY": '{"transcriber":{"primary":{"providers":["openai"]}}}'}), patch.object(stt.httpx, "AsyncClient") as client:
            with self.assertRaises(HTTPException) as error:
                await stt.transcribe("data:audio/webm;base64,AAAA", "audio/webm", {"id": "transcriber"})
        self.assertEqual(403, error.exception.status_code)
        client.assert_not_called()

    def test_malformed_decoder_metadata_is_not_treated_as_measured(self):
        self.assertEqual({}, stt.usage_for({"segments": [{"tokens": [True, "not-a-token"]}]}))
        self.assertEqual({}, stt.usage_for({"segments": [{"tokens": [True]}]}))


if __name__ == "__main__":
    unittest.main()
