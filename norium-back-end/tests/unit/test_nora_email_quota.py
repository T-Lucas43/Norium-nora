"""Synthetic regressions for drafting with a small token allowance. No sends."""
import json
import os
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import httpx

from app.modules.mail import router as mail_router
from app.services import ai_costs
from app.services.email_agent import EmailAgent, EmailSession
from app.services.nora import NoraIAService, NoraIncompleteResponse
from app.services.nora_system_prompt import NORA_EMAIL_DRAFT_PROMPT


class NoraEmailQuotaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"NORIUM_DATA_DIR": directory.name, "ENVIRONMENT": "test",
                                     "GROQ_API_KEY": "synthetic-key", "OPENAI_API_KEY": "",
                                     "NORA_PROVIDER": "groq"})
        env.start()
        self.addCleanup(env.stop)
        self.agent = EmailAgent()
        self.fields = {"to": ["pessoa@example.test"], "cc": [], "bcc": [], "subject": "Reunião",
                       "body": "Confirmo a reunião de amanhã.", "attachments": [], "_attachments_done": True}

    async def test_complete_draft_fits_5000_tokens_and_records_actual_usage(self):
        ai_costs.save_limit("friend-test", {"monthlyTokenLimit": 5000, "monthlyBudgetUsd": 0}, "admin-test")
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={"model": self.agent.nora.model,
                "choices": [{"message": {"content": "Confirmo a reunião de amanhã."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 50}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            self.agent.nora._client = client
            draft = await self.agent._polish_body(self.fields, user_id="friend-test")
        self.assertEqual("Confirmo a reunião de amanhã.", draft)
        self.assertEqual(1, len(requests))
        messages = requests[0]["messages"]
        bound = ai_costs.Meter({}, messages, 1000, user_id="friend-test").input_bound
        self.assertLess(bound + requests[0]["max_tokens"], 5000)
        self.assertIn(NORA_EMAIL_DRAFT_PROMPT, messages[0]["content"])
        with ai_costs.database() as db:
            usage = db.execute("SELECT user_id,input_tokens,output_tokens FROM usage").fetchall()
            self.assertEqual([("friend-test", 120, 50)], [tuple(row) for row in usage])
            self.assertEqual(0, db.execute("SELECT COUNT(*) FROM reservations").fetchone()[0])

    async def test_quota_failure_keeps_draft_and_collection_stage_for_retry(self):
        original = dict(self.fields)
        session = EmailSession(id="draft-test", user_id="friend-test", fields=self.fields, awaiting="attachments")
        self.agent.nora.perguntar_nora = AsyncMock(side_effect=HTTPException(402, "Saldo de tokens insuficiente."))
        with self.assertRaises(HTTPException):
            await self.agent._next_question(session)
        self.assertEqual("attachments", session.awaiting)
        self.assertEqual(original, session.fields)
        self.agent.nora.perguntar_nora = AsyncMock(return_value="Corpo revisado.")
        result = await self.agent._next_question(session)
        self.assertEqual("pronto_para_aprovacao", result["status"])
        self.assertEqual("confirmacao", session.awaiting)
        self.assertEqual("Corpo revisado.", result["emailExact"]["body"])
        self.assertNotIn("approval", result)
        self.assertNotIn("sent", result)

    async def test_incomplete_generation_preserves_original_body(self):
        session = EmailSession(id="draft-test", user_id="friend-test", fields=self.fields, awaiting="attachments")
        self.agent.nora.perguntar_nora = AsyncMock(side_effect=NoraIncompleteResponse())
        with self.assertRaises(NoraIncompleteResponse):
            await self.agent._next_question(session)
        self.assertEqual("Confirmo a reunião de amanhã.", session.fields["body"])
        self.assertEqual("attachments", session.awaiting)

    async def test_endpoint_preserves_quota_and_permission_errors(self):
        for status in (402, 403):
            error = HTTPException(status, "Erro seguro de limite ou permissão.")
            with patch.object(mail_router.email_agent, "handle", AsyncMock(side_effect=error)):
                with self.assertRaises(HTTPException) as caught:
                    await mail_router.conversar_com_agente_email(
                        mail_router.EmailAgentPayload(message="pular", session_id="draft-test"), {"id": "friend-test"})
            self.assertIs(error, caught.exception)

    async def test_large_body_still_cannot_exceed_token_allowance(self):
        ai_costs.save_limit("friend-test", {"monthlyTokenLimit": 5000}, "admin-test")
        self.agent.nora._client = type("Client", (), {"post": AsyncMock(), "is_closed": False})()
        with self.assertRaises(HTTPException) as caught:
            await self.agent._polish_body({**self.fields, "body": "x" * 12000}, user_id="friend-test")
        self.assertEqual(402, caught.exception.status_code)
        self.agent.nora._client.post.assert_not_awaited()

    def test_other_nora_purposes_keep_the_general_system_prompt(self):
        nora = NoraIAService()
        for purpose in ("routine", "document"):
            messages = nora._build_payload_messages([{"role": "user", "content": "Texto sintético"}], None, purpose=purpose)
            self.assertIn(nora.system_prompt, messages[0]["content"])
