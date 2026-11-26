import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.modules.whatsapp_team import nora, context
from app.modules.nora import router as main


class WhatsAppNoraContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.actor = {"id": "member", "role": "member", "plan": "equipe", "permissions": {"nora": True}}
        self.grant = SimpleNamespace(actor=self.actor, actor_id="member", owner={"id": "owner"})
        self.history = AsyncMock(return_value={"items": [{"texto": "Texto sintético", "remetente": "contato", "midiaMeta": {"secret": "excluded"}},
                                                       {"texto": "Temporário", "visualizacaoUnica": True}]})
        self.authorized = AsyncMock(return_value=(self.grant, {}, None))
        for active in (patch.object(context, "authorized", self.authorized),
                       patch.object(context, "runtime", return_value=SimpleNamespace(obter_historico_conversa=self.history)),
                       patch.object(main, "require_nora_permission", side_effect=lambda user: user)):
            active.start(); self.addCleanup(active.stop)

    async def test_bills_requesting_actor_and_bounds_context_without_external_send(self):
        provider = AsyncMock(return_value="Rascunho sintético")
        with patch.object(main.nora_service, "perguntar_nora", provider):
            result = await nora.draft("inbox", "conversation", nora.Draft(action="reply"), self.actor)
        self.assertFalse(result["whatsapp_enviado"])
        self.assertEqual("member", provider.call_args.kwargs["user_id"])
        self.assertNotIn("excluded", str(provider.call_args))
        self.assertNotIn("Temporário", str(provider.call_args))
        self.assertEqual(12, self.history.call_args.kwargs["limit"])

    async def test_revocation_before_read_prevents_provider_call(self):
        self.authorized.side_effect = HTTPException(404, "indisponível")
        with patch.object(main.nora_service, "perguntar_nora", new=AsyncMock()) as provider, self.assertRaises(HTTPException):
            await nora.draft("inbox", "conversation", nora.Draft(action="summary"), self.actor)
        provider.assert_not_awaited(); self.history.assert_not_awaited()

    async def test_revocation_while_generating_discards_response(self):
        self.authorized.side_effect = [(self.grant, {}, None), (self.grant, {}, None), HTTPException(404, "indisponível")]
        with patch.object(main.nora_service, "perguntar_nora", new=AsyncMock(return_value="private")), self.assertRaises(HTTPException):
            await nora.draft("inbox", "conversation", nora.Draft(action="summary"), self.actor)

    async def test_no_history_does_not_invent_context_or_spend_tokens(self):
        self.history.return_value = {"items": []}
        with patch.object(main.nora_service, "perguntar_nora", new=AsyncMock()) as provider:
            result = await nora.draft("inbox", "conversation", nora.Draft(action="reply"), self.actor)
        self.assertTrue(result["empty_context"]); provider.assert_not_awaited()

    async def test_personal_custom_and_summary_pass_the_billing_user(self):
        provider = AsyncMock(return_value="Texto sintético")
        with patch.object(main, "buscar_historico_whats", new=AsyncMock(return_value="Histórico sintético")), patch.object(main.nora_service, "perguntar_nora", provider):
            await main.conversar_nora_whatsapp(main.NoraWhatsAppPayload(conversa_id="synthetic", texto_usuario="resuma"), {"id": "personal"})
            self.assertEqual("personal", provider.call_args.kwargs["user_id"])
            await main.resumir_conversa("synthetic", {"id": "personal"})
            self.assertEqual("personal", provider.call_args.kwargs["user_id"])
