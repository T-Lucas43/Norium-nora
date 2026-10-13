"""Action slots from explicit user text; no provider or email transmission."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.core.request_context import set_request_context, reset_request_context
from app.services.email_agent import EmailAgent
from app.services.nora_action_prefill import extract_action_parameters
from tests.unit.test_nora_email_approvals import FakeGmail


class ActionPrefillTests(unittest.TestCase):
    def test_recipient_and_body_without_subject_are_preserved(self):
        result = extract_action_parameters("email", "Envie um e-mail para pessoa@example.test dizendo que confirmo a reunião.")
        self.assertEqual(["pessoa@example.test"], result.fields["to"])
        self.assertEqual("confirmo a reunião.", result.fields["body"])
        self.assertNotIn("subject", result.fields)

    def test_copy_and_blind_copy_are_not_primary_recipients(self):
        result = extract_action_parameters("email", "Envie para a@example.test, Cc: b@example.test; Cco: c@example.test; assunto: Reunião; mensagem: Confirmo.")
        self.assertEqual({"to": ["a@example.test"], "cc": ["b@example.test"], "bcc": ["c@example.test"], "subject": "Reunião", "body": "Confirmo."}, result.fields)

    def test_email_inside_body_is_not_added_as_recipient(self):
        result = extract_action_parameters("email", "Envie para a@example.test dizendo que o contato mencionado é b@example.test.")
        self.assertEqual(["a@example.test"], result.fields["to"])
        self.assertIn("b@example.test", result.fields["body"])

    def test_quoted_body_can_precede_the_header_fields(self):
        result = extract_action_parameters("email", 'Envie e-mail dizendo "Confirmo a reunião." para a@example.test, assunto: Confirmação')
        self.assertEqual(["a@example.test"], result.fields["to"])
        self.assertEqual("Confirmação", result.fields["subject"])
        self.assertEqual("Confirmo a reunião.", result.fields["body"])
        self.assertTrue(result.literal_body)

    def test_quoted_subject_cannot_introduce_a_body_marker(self):
        result = extract_action_parameters("email", 'Envie para a@example.test assunto: "Dizendo sim" mensagem: Confirmo.')
        self.assertEqual("Dizendo sim", result.fields["subject"])
        self.assertEqual("Confirmo.", result.fields["body"])

    def test_unknown_copy_contact_requires_an_address(self):
        result = extract_action_parameters("email", "Envie para a@example.test, cc: meu gerente, mensagem: Confirmo.")
        self.assertEqual(("cc",), result.unresolved)
        self.assertNotIn("cc", result.fields)

    def test_contact_from_body_does_not_satisfy_missing_primary_recipient(self):
        result = extract_action_parameters("email", 'Envie e-mail dizendo "O contato é pessoa@example.test."')
        self.assertNotIn("to", result.fields)

    def test_other_domains_do_not_receive_email_fields(self):
        self.assertIsNone(extract_action_parameters("tarefas", "Texto de tarefa"))


class EmailPrefillFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeGmail.connected = True
        FakeGmail.sent = []
        mocked = patch("app.services.email_agent.GmailService", FakeGmail)
        mocked.start()
        self.addCleanup(mocked.stop)
        self.agent = EmailAgent()
        self.agent.nora.perguntar_nora = AsyncMock(return_value="Confirmo a reunião.")

    async def test_complete_request_without_subject_reaches_preview_once(self):
        result = await self.agent.handle(message="Envie para a@example.test dizendo que confirmo a reunião.", session_id=None, user_id="actor-test")
        self.assertEqual("pronto_para_aprovacao", result["status"])
        self.assertTrue(result["fields"]["_subject_inferred"])
        self.assertEqual([], result["preview"]["cc"])
        self.assertEqual([], result["preview"]["bcc"])
        await self.agent.handle(message="pular", session_id=result["session_id"], user_id="actor-test")
        self.agent.nora.perguntar_nora.assert_awaited_once()
        self.assertEqual([], FakeGmail.sent)

    async def test_literal_message_has_native_preview_without_ai_charge(self):
        self.agent.nora.perguntar_nora.side_effect = HTTPException(402, "Sem tokens")
        result = await self.agent.handle(message='Envie para a@example.test dizendo "Confirmo a reunião."', session_id=None, user_id="actor-test")
        self.assertEqual("Confirmo a reunião.", result["preview"]["body"])
        self.agent.nora.perguntar_nora.assert_not_awaited()
        self.assertEqual([], FakeGmail.sent)

    async def test_continuation_fills_multiple_slots_without_reasking_body(self):
        first = await self.agent.handle(message="mande um e-mail", session_id=None, user_id="actor-test")
        result = await self.agent.handle(message='para: a@example.test; assunto: Confirmação; mensagem: "Confirmo a reunião."',
                                         session_id=first["session_id"], user_id="actor-test")
        self.assertEqual("pronto_para_aprovacao", result["status"])
        self.assertEqual("Confirmação", result["preview"]["subject"])
        self.agent.nora.perguntar_nora.assert_not_awaited()
        self.assertEqual([], FakeGmail.sent)

    async def test_session_cannot_cross_actor_or_workspace(self):
        first = await self.agent.handle(message="mande um e-mail", session_id=None, user_id="actor-test")
        with self.assertRaises(HTTPException) as wrong_actor:
            await self.agent.handle(message="pular", session_id=first["session_id"], user_id="another-actor")
        self.assertEqual(404, wrong_actor.exception.status_code)
        context = set_request_context("actor-test", "another-workspace")
        try:
            with self.assertRaises(HTTPException) as wrong_workspace:
                await self.agent.handle(message="pular", session_id=first["session_id"], user_id="actor-test")
            self.assertEqual(404, wrong_workspace.exception.status_code)
        finally:
            reset_request_context(context)
        self.assertEqual([], FakeGmail.sent)

    async def test_concurrent_continuations_polish_once(self):
        first = await self.agent.handle(message="mande um e-mail", session_id=None, user_id="actor-test")
        async def polish(*args, **kwargs):
            await asyncio.sleep(0.01)
            return "Confirmo a reunião."
        self.agent.nora.perguntar_nora.side_effect = polish
        results = await asyncio.gather(*(self.agent.handle(message="para: a@example.test; dizendo que confirmo a reunião.", session_id=first["session_id"], user_id="actor-test") for _ in range(3)))
        self.agent.nora.perguntar_nora.assert_awaited_once()
        self.assertTrue(all(item["status"] == "pronto_para_aprovacao" for item in results))
        self.assertEqual([], FakeGmail.sent)

    async def test_cancel_cannot_remove_another_actor_draft(self):
        first = await self.agent.handle(message="mande um e-mail", session_id=None, user_id="actor-test")
        self.assertIsNone(self.agent.cancel_session(first["session_id"], user_id="another-actor"))
        self.assertIn(first["session_id"], self.agent.sessions)
