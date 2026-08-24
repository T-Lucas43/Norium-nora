from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.wapi_messaging import wapi_phone, InvalidGroupParticipants


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


def bind(user_id: str, instance_id: str, token: str) -> None:
    wb.save_binding(user_id, InstanceBinding(instance_id=instance_id, token=token, state="connected"))


class WapiPhoneNormalizationTests(unittest.TestCase):
    def test_individual_jid_becomes_digits(self) -> None:
        self.assertEqual("5511999998888", wapi_phone("5511999998888@c.us"))
        self.assertEqual("5511999998888", wapi_phone("+55 11 99999-8888"))

    def test_group_id_is_preserved(self) -> None:
        self.assertEqual("120363000000000000@g.us", wapi_phone("120363000000000000@g.us"))


class WapiMessagingRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}))
        self._send_text = AsyncMock(return_value={"messageId": "MID-1"})
        self._stack.enter_context(patch.object(chat_router.wapi_messaging._client, "send_text", self._send_text))

    def tearDown(self) -> None:
        self._stack.close()

    async def test_send_without_instance_returns_409(self) -> None:
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888", texto="ola")
        with self.assertRaises(HTTPException) as error:
            await chat_router.enviar_mensagem(payload, chat_user("user-a"))
        self.assertEqual(409, error.exception.status_code)
        self._send_text.assert_not_awaited()

    async def test_send_uses_own_instance_and_persists(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888@c.us", texto="ola mundo")
        result = await chat_router.enviar_mensagem(payload, chat_user("user-a"))
        self.assertEqual("enviado_real", result["status"])
        # chamou o cliente com a instância do próprio usuário e o número normalizado
        self._send_text.assert_awaited_once()
        args = self._send_text.await_args.args
        self.assertEqual("INST-A", args[0])
        self.assertEqual("tok-a", args[1])
        self.assertEqual("5511999998888", args[2])
        # persistiu no store de conversas do usuário
        from app.services.conversation_store import load_conversations
        db = await load_conversations("user-a")
        self.assertIn("5511999998888@c.us", db)
        textos = [m.get("texto") for m in db["5511999998888@c.us"].get("mensagens", [])]
        self.assertIn("ola mundo", textos)

    async def test_one_account_cannot_send_through_another(self) -> None:
        # A vincula INST-A; B não vincula nada. B tenta enviar -> 409, sem usar INST-A.
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888", texto="x")
        with self.assertRaises(HTTPException) as error:
            await chat_router.enviar_mensagem(payload, chat_user("user-b"))
        self.assertEqual(409, error.exception.status_code)
        self._send_text.assert_not_awaited()

    async def test_group_creation_sends_only_numeric_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        create_group = AsyncMock(return_value={"group": {"id": "120363000000000000@g.us"}})
        with patch.object(chat_router.wapi_messaging._client, "create_group", create_group):
            await chat_router.wapi_messaging.create_group(
                "user-a",
                "Equipe",
                ["5511999998888@c.us", "219451387551856@lid", "123@newsletter"],
            )
        self.assertEqual(["5511999998888"], create_group.await_args.args[3])

    async def test_group_creation_rejects_only_lid_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        with self.assertRaises(InvalidGroupParticipants):
            await chat_router.wapi_messaging.create_group(
                "user-a",
                "Equipe",
                ["219451387551856@lid"],
            )

    async def test_group_route_returns_422_for_only_lid_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.CriarGrupoPayload(nome="Equipe", participantes=["219451387551856@lid"])
        with self.assertRaises(HTTPException) as error:
            await chat_router.criar_grupo(payload, chat_user("user-a"))
        self.assertEqual(422, error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
