from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

from app.modules.public_site.router import (
    PUBLIC_NORA_PROMPT,
    REFUSAL,
    PublicNoraMessage,
    PublicNoraPayload,
    is_norium_related,
    public_nora_chat,
)


def request_for(ip: str) -> Request:
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/public/site/nora",
        "raw_path": b"/api/public/site/nora",
        "query_string": b"",
        "headers": [],
        "client": (ip, 12345),
        "server": ("testserver", 80),
    })


class PublicSiteNoraTests(unittest.IsolatedAsyncioTestCase):
    def test_topic_filter_accepts_product_questions_and_rejects_external_topics(self):
        self.assertTrue(is_norium_related("Como funcionam as tarefas no Norium?"))
        self.assertTrue(is_norium_related("Quanto custa?"))
        self.assertFalse(is_norium_related("Qual é a capital da França?"))
        self.assertFalse(is_norium_related("O que é fotossíntese?"))
        self.assertFalse(is_norium_related("Quanto custa um celular?"))
        self.assertFalse(is_norium_related("Escreva uma receita de bolo"))

    async def test_external_question_is_refused_without_calling_groq(self):
        payload = PublicNoraPayload(question="Quem ganhou a Copa do Mundo?")
        with patch("app.modules.public_site.router.site_nora_service.perguntar_nora", new=AsyncMock()) as ask:
            result = await public_nora_chat(payload, request_for("203.0.113.11"))
        self.assertEqual(REFUSAL, result["response"])
        self.assertTrue(result["restricted"])
        ask.assert_not_awaited()

    async def test_product_question_uses_restricted_prompt_and_short_history(self):
        payload = PublicNoraPayload(
            question="Como a Nora ajuda com projetos?",
            history=[PublicNoraMessage(role="assistant", content="Posso explicar o Norium.")],
        )
        ask = AsyncMock(return_value="A Nora ajuda a estruturar os próximos passos do projeto.")
        with patch("app.modules.public_site.router.site_nora_service.perguntar_nora", new=ask):
            result = await public_nora_chat(payload, request_for("203.0.113.12"))
        self.assertFalse(result["restricted"])
        sent_messages = ask.await_args.args[0]
        self.assertEqual("system", sent_messages[0]["role"])
        self.assertEqual(PUBLIC_NORA_PROMPT, sent_messages[0]["content"])
        self.assertEqual("Como a Nora ajuda com projetos?", sent_messages[-1]["content"])


if __name__ == "__main__":
    unittest.main()
