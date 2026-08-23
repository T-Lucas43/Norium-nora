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


class WapiAdaptIncomingTests(unittest.TestCase):
    """Trava o parsing do payload real da W-API (grupo, nome, mídia, timestamp)."""

    def test_group_message_uses_group_id_and_no_sender_name(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "isGroup": True,
            "messageId": "M1",
            "fromMe": False,
            "chat": {"id": "120363000000000000@g.us"},
            "sender": {"id": "5511999998888", "pushName": "Joao"},
            "moment": 1700000000,
            "msgContent": {"conversation": "ola grupo"},
        }
        msg = adapt_incoming(payload)
        self.assertEqual("120363000000000000@g.us", msg["chatId"])  # chave = grupo, não remetente
        self.assertTrue(msg["isGroup"])
        self.assertEqual("", msg["chatName"])  # grupo não traz nome no webhook
        self.assertEqual("Joao", msg["senderName"])
        self.assertEqual(1700000000, msg["timestamp"])
        self.assertEqual("texto", msg["tipo"])

    def test_image_message_captures_media_meta(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "isGroup": False,
            "messageId": "M2",
            "chat": {"id": "73650132766836@lid"},
            "sender": {"pushName": "Nando"},
            "moment": 1700000001,
            "msgContent": {
                "imageMessage": {
                    "caption": "olha isso",
                    "mediaKey": "abc",
                    "directPath": "/v/t62...",
                    "mimetype": "image/jpeg",
                    "URL": "https://mmg.whatsapp.net/enc",
                }
            },
        }
        msg = adapt_incoming(payload)
        self.assertEqual("73650132766836@lid", msg["chatId"])
        self.assertEqual("midia", msg["tipo"])
        self.assertEqual("olha isso", msg["texto"])
        self.assertEqual(
            {"mediaKey": "abc", "directPath": "/v/t62...", "type": "image", "mimetype": "image/jpeg"},
            msg["midiaMeta"],
        )


class WapiPhoneLidTests(unittest.TestCase):
    def test_lid_and_group_kept_whole(self) -> None:
        from app.services.wapi_messaging import wapi_phone

        self.assertEqual("73650132766836@lid", wapi_phone("73650132766836@lid"))
        self.assertEqual("120363000000000000@g.us", wapi_phone("120363000000000000@g.us"))
        self.assertEqual("5511999998888", wapi_phone("5511999998888@c.us"))


if __name__ == "__main__":
    unittest.main()
