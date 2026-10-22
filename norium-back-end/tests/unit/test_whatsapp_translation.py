import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.modules.chat import router
from app.modules.chat.translation import translate_message
from app.services.nora import NoraIAService, NoraIncompleteResponse


USER = {"id": "synthetic-owner", "role": "owner", "plan": "equipe"}


class TranslationTests(unittest.IsolatedAsyncioTestCase):
    def runtime(self, messages):
        return SimpleNamespace(load_conversations=AsyncMock(return_value={"owned": {"mensagens": messages}}))

    async def test_selected_message_is_masked_bounded_and_metered_without_sending(self):
        runtime = self.runtime([{"id": "selected", "texto": "CPF 123.456.789-00, teste@example.test, +55 11 99999-0000"},
                                {"id": "other", "texto": "Other private conversation text"}])
        service = SimpleNamespace(perguntar_nora=AsyncMock(return_value="Translated message"))
        with patch.object(router.whatsapp_integration, "send", AsyncMock(side_effect=AssertionError("must never send"))) as send:
            result = await translate_message(runtime, service, USER, "owned", "selected", "en")
        self.assertEqual("Translated message", result["translation"])
        runtime.load_conversations.assert_awaited_once_with(USER["id"])
        prompt = service.perguntar_nora.call_args.args[0][0]["content"]
        for private in ["123.456.789-00", "teste@example.test", "+55 11 99999-0000", "Other private conversation text"]:
            self.assertNotIn(private, prompt)
        self.assertIn("[CPF REMOVIDO]", prompt)
        self.assertEqual(USER["id"], service.perguntar_nora.call_args.kwargs["user_id"])
        self.assertEqual("whatsapp-translation", service.perguntar_nora.call_args.kwargs["usage_source"])
        self.assertTrue(service.perguntar_nora.call_args.kwargs["strict_errors"])
        send.assert_not_awaited()

    async def test_foreign_conversation_and_view_once_never_call_ai(self):
        service = SimpleNamespace(perguntar_nora=AsyncMock())
        runtime = self.runtime([{"id": "once", "texto": "private", "visualizacaoUnica": True}])
        for conversation, message in [("foreign", "once"), ("owned", "once")]:
            with self.assertRaises(HTTPException) as error:
                await translate_message(runtime, service, USER, conversation, message, "en")
            self.assertEqual(404, error.exception.status_code)
        service.perguntar_nora.assert_not_awaited()

    async def test_permission_and_size_limits_deny_before_ai(self):
        service = SimpleNamespace(perguntar_nora=AsyncMock())
        runtime = self.runtime([{"id": "long", "texto": "x" * 6001}])
        with self.assertRaises(HTTPException) as error:
            await translate_message(runtime, service, {"id": "no-nora", "plan": "equipe", "role": "member"}, "owned", "long", "en")
        self.assertEqual(403, error.exception.status_code)
        with self.assertRaises(HTTPException) as error:
            await translate_message(runtime, service, USER, "owned", "long", "en")
        self.assertEqual(413, error.exception.status_code)
        service.perguntar_nora.assert_not_awaited()

    async def test_incomplete_response_is_an_error_not_a_translation(self):
        service = SimpleNamespace(perguntar_nora=AsyncMock(side_effect=NoraIncompleteResponse()))
        with self.assertRaises(HTTPException) as error:
            await translate_message(self.runtime([{"id": "text", "texto": "Hi"}]), service, USER, "owned", "text", "pt-BR")
        self.assertEqual(502, error.exception.status_code)

    async def test_optional_strict_mode_preserves_legacy_default_and_raises_when_requested(self):
        service = NoraIAService.__new__(NoraIAService)
        service.api_key = ""
        self.assertIsInstance(await service.perguntar_nora([]), str)
        with self.assertRaises(HTTPException) as error:
            await service.perguntar_nora([], strict_errors=True)
        self.assertEqual(503, error.exception.status_code)
