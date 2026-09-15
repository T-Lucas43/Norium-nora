import base64
import os
import unittest
from unittest.mock import AsyncMock, patch

from app.modules.nora import router as nora_router


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
        ):
            result = await nora_router.transcrever_voz_nora(payload, {})

        self.assertEqual("experiência profissional em dados", result["text"])
        self.assertEqual(2, len(client.calls))
        self.assertEqual("audio/webm", client.calls[0]["files"]["file"][2])


if __name__ == "__main__":
    unittest.main()
