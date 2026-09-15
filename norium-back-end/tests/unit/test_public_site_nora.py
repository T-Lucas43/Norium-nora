from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

from app.modules.public_site.router import (
    PUBLIC_NORA_PROMPT,
    REFUSAL,
    PublicNoraMessage,
    PublicNoraPayload,
    direct_response,
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
    def test_direct_answers_are_concise_and_cover_common_conversation(self):
        self.assertTrue(direct_response("Oi!"))
        answer = direct_response("O que é o Norium?")
        self.assertIsNotNone(answer)
        self.assertLessEqual(len(answer.split()), 50)
        self.assertIn("workspace", answer)
        self.assertTrue(direct_response("Obrigado"))

    def test_topic_filter_accepts_product_questions_and_rejects_external_topics(self):
        self.assertTrue(is_norium_related("Como funcionam as tarefas no Norium?"))
        self.assertTrue(is_norium_related("Quanto custa?"))
        self.assertFalse(is_norium_related("Qual é a capital da França?"))
        self.assertFalse(is_norium_related("O que é fotossíntese?"))
        self.assertFalse(is_norium_related("Quanto custa um celular?"))
        self.assertFalse(is_norium_related("Escreva uma receita de bolo"))
        initial = [PublicNoraMessage(role="assistant", content="Posso explicar o Norium.")]
        self.assertFalse(is_norium_related("Qual Pokémon é mais forte?", initial))
        previous = [PublicNoraMessage(role="user", content="O que é o Norium?")]
        self.assertTrue(is_norium_related("E isso ajuda uma equipe?", previous))

    async def test_external_question_is_refused_without_calling_groq(self):
        payload = PublicNoraPayload(question="Quem ganhou a Copa do Mundo?")
        with patch("app.modules.public_site.router.site_nora_service.perguntar_nora", new=AsyncMock()) as ask:
            result = await public_nora_chat(payload, request_for("203.0.113.11"))
        self.assertEqual(REFUSAL, result["response"])
        self.assertIn("Por isso, mantenho o foco na plataforma", result["response"])
        self.assertIn("tarefas e projetos", result["response"])
        self.assertTrue(result["restricted"])
        ask.assert_not_awaited()

    async def test_common_question_uses_concise_editorial_answer_without_groq(self):
        payload = PublicNoraPayload(question="O que é o Norium?")
        with patch("app.modules.public_site.router.site_nora_service.perguntar_nora", new=AsyncMock()) as ask:
            result = await public_nora_chat(payload, request_for("203.0.113.12"))
        self.assertFalse(result["restricted"])
        self.assertLessEqual(len(result["response"].split()), 50)
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
        self.assertIn("nunca mais de 4", sent_messages[0]["content"])
        self.assertIn("Não invente nomes de recursos", sent_messages[0]["content"])
        self.assertEqual("Como a Nora ajuda com projetos?", sent_messages[-1]["content"])
        self.assertEqual(220, ask.await_args.kwargs["max_tokens"])


if __name__ == "__main__":
    unittest.main()
