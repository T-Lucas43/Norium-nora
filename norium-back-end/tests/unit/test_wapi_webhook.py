from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.conversation_store import load_conversations, save_conversations, new_conversation


class FakeRequest:
    """Stub minimo com a interface que o handler usa (query_params/headers)."""

    def __init__(self, secret: str | None = None, header_secret: str | None = None) -> None:
        self.query_params = {"secret": secret} if secret is not None else {}
        self.headers = {"x-wapi-webhook-secret": header_secret} if header_secret is not None else {}


SECRET = "segredo-teste"


class WapiWebhookTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}))
        self._stack.enter_context(patch.object(chat_router, "WAPI_WEBHOOK_SECRET", SECRET))
        chat_router.whatsapp_webhook_event_cache.clear()
        # Instancia INST-A pertence a user-a.
        wb.save_binding("user-a", InstanceBinding(instance_id="INST-A", token="tok-a", state="connected"))

    def tearDown(self) -> None:
        chat_router.whatsapp_webhook_event_cache.clear()
        self._stack.close()

    def _received(self, message_id: str = "M1", text: str = "oi") -> dict:
        return {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": message_id,
            "phone": "5511999998888",
            "fromMe": False,
            "momment": 1700000000,
            "sender": {"pushName": "Joao"},
            "msgContent": {"conversation": text},
        }

    async def test_rejects_wrong_secret(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.webhook_whatsapp(self._received(), request=FakeRequest(secret="errado"))
        self.assertEqual(403, error.exception.status_code)

    async def test_rejects_unknown_instance(self) -> None:
        payload = self._received()
        payload["instanceId"] = "INST-DESCONHECIDA"
        with self.assertRaises(HTTPException) as error:
            await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))
        self.assertEqual(404, error.exception.status_code)

    async def test_received_persists_only_for_owner(self) -> None:
        result = await chat_router.webhook_whatsapp(self._received(), request=FakeRequest(secret=SECRET))
        self.assertEqual("success", result["status"])
        # Mensagem foi para o dono (user-a) e nao para outra conta (user-b).
        db_a = await load_conversations("user-a")
        self.assertIn("5511999998888", db_a)
        textos = [m.get("texto") for m in db_a["5511999998888"].get("mensagens", [])]
        self.assertIn("oi", textos)
        db_b = await load_conversations("user-b")
        self.assertEqual({}, db_b)

    async def test_duplicate_received_is_ignored(self) -> None:
        await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        again = await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        self.assertEqual("duplicate", again["status"])

    async def test_status_update_not_deduped_against_received(self) -> None:
        # pre-semeia uma mensagem enviada
        db = await load_conversations("user-a")
        conversa = new_conversation("5511999998888", contato="Joao", channel="whatsapp")
        conversa["mensagens"] = [{"id": "M9", "texto": "ola", "status": "enviado", "canal": "whatsapp"}]
        db["5511999998888"] = conversa
        await save_conversations(db, "user-a")

        # evento de status para o MESMO messageId nao pode ser descartado como duplicado
        status_event = {"event": "messageStatus", "instanceId": "INST-A", "messageId": "M9", "status": "READ"}
        result = await chat_router.webhook_whatsapp(status_event, request=FakeRequest(secret=SECRET))
        self.assertEqual("success", result["status"])
        db2 = await load_conversations("user-a")
        msg = db2["5511999998888"]["mensagens"][0]
        self.assertEqual("lido", msg["status"])  # "READ" mapeado para o vocabulario interno


if __name__ == "__main__":
    unittest.main()
