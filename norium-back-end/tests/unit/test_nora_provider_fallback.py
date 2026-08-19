import os
import unittest
from unittest.mock import patch

from app.services.nora import NoraIAService


class FakeResponse:
    def __init__(self, status_code: int, content: str = "") -> None:
        self.status_code = status_code
        self._content = content

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


class FakeAsyncClient:
    calls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, _url, *, json, **_kwargs):
        self.calls.append(json["model"])
        if len(self.calls) == 1:
            return FakeResponse(404)
        return FakeResponse(200, "Sugestao pronta")


class NoraProviderFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_with_active_fallback_when_configured_model_is_removed(self) -> None:
        FakeAsyncClient.calls = []
        with (
            patch.dict(
                os.environ,
                {
                    "GROQ_API_KEY": "test-key",
                    "NORA_MODEL": "modelo-removido",
                    "NORA_FALLBACK_MODELS": "openai/gpt-oss-20b",
                },
                clear=False,
            ),
            patch("app.services.nora.httpx.AsyncClient", FakeAsyncClient),
        ):
            service = NoraIAService()
            answer = await service.perguntar_nora([{"role": "user", "content": "Ajude a responder"}])

        self.assertEqual(answer, "Sugestao pronta")
        self.assertEqual(FakeAsyncClient.calls, ["modelo-removido", "openai/gpt-oss-20b"])
        self.assertEqual(service.model, "openai/gpt-oss-20b")


if __name__ == "__main__":
    unittest.main()
