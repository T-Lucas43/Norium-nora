from __future__ import annotations

import unittest
from unittest.mock import AsyncMock

from app.services.email_agent import EmailAgent


class FakeGmailService:
    def list_messages(self, **_kwargs):
        return {
            "messages": [
                {
                    "fromName": "Cliente Aurora",
                    "fromEmail": "contato@aurora.test",
                    "subject": "Aprovação da proposta até amanhã",
                    "dateLabel": "hoje, 09:10",
                    "labels": ["INBOX", "UNREAD", "IMPORTANT"],
                    "snippet": "Precisamos confirmar a proposta e o prazo informado.",
                },
                {
                    "fromName": "LinkedIn",
                    "fromEmail": "alertas@linkedin.test",
                    "subject": "Novas vagas para você",
                    "dateLabel": "ontem",
                    "labels": ["INBOX"],
                    "snippet": "Alerta automático de vagas.",
                },
            ]
        }


class EmailAgentSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_prompt_forbids_inbox_replica_and_returns_compact_answer(self) -> None:
        agent = EmailAgent()
        agent.nora.perguntar_nora = AsyncMock(
            return_value=(
                "## Visão geral\nHá uma decisão comercial pendente.\n\n"
                "## O que merece atenção\n- A proposta da Aurora precisa de resposta.\n\n"
                "## Próximo passo\nConfirmar o prazo com o cliente."
            )
        )

        result = await agent._summarize_inbox(FakeGmailService(), "resumir caixa de entrada")

        prompt = agent.nora.perguntar_nora.await_args.args[0][0]["content"]
        self.assertIn("não crie tabela", prompt)
        self.assertIn("no máximo 180 palavras", prompt)
        self.assertNotIn("messages", result)
        self.assertEqual(2, result["summaryCount"])
        self.assertIn("## Próximo passo", result["response"])

    async def test_table_like_provider_answer_is_replaced_with_actionable_fallback(self) -> None:
        agent = EmailAgent()
        agent.nora.perguntar_nora = AsyncMock(return_value="| Prioridade | Remetente |\n|---|---|\n| Alta | Cliente Aurora |")

        result = await agent._summarize_inbox(FakeGmailService(), "resumir caixa")

        self.assertNotIn("|---", result["response"])
        self.assertIn("Aprovação da proposta até amanhã", result["response"])
        self.assertIn("## Próximo passo", result["response"])


if __name__ == "__main__":
    unittest.main()
