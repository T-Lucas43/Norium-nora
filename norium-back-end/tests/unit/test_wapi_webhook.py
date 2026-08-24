from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

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
        chat_router.whatsapp_webhook_inflight.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()
        # Instancia INST-A pertence a user-a.
        wb.save_binding("user-a", InstanceBinding(instance_id="INST-A", token="tok-a", state="connected"))

    def tearDown(self) -> None:
        chat_router.whatsapp_webhook_event_cache.clear()
        chat_router.whatsapp_webhook_inflight.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()
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

    async def test_from_me_message_preserves_contact_identity(self) -> None:
        # Conversa já tem nome e foto do contato.
        db = await load_conversations("user-a")
        conversa = new_conversation("5511999998888", contato="Maria", channel="whatsapp")
        conversa["metadados"]["photoUrl"] = "https://exemplo/maria.jpg"
        conversa["photoUrl"] = "https://exemplo/maria.jpg"
        db["5511999998888"] = conversa
        await save_conversations(db, "user-a")

        # Mensagem enviada por MIM (fromMe) — sender sou eu; não pode virar o contato.
        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "OUT1",
            "phone": "5511999998888",
            "fromMe": True,
            "momment": 1700000100,
            "sender": {"pushName": "Eu Mesmo", "profilePicture": "https://exemplo/eu.jpg"},
            "msgContent": {"conversation": "oi"},
        }
        result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))
        self.assertEqual("success", result["status"])
        db2 = await load_conversations("user-a")
        conv = db2["5511999998888"]
        self.assertEqual("Maria", conv["contato"])  # nome do contato preservado
        self.assertEqual("https://exemplo/maria.jpg", conv["metadados"]["photoUrl"])  # foto preservada
        self.assertTrue(conv["ultimaMensagemMinha"])  # mas a msg fromMe foi registrada

    async def test_from_me_group_message_resolves_group_identity_from_metadata(self) -> None:
        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "GROUP-OUT1",
            "fromMe": True,
            "isGroup": True,
            "chat": {"id": "120363000000000000@g.us"},
            "sender": {"pushName": "Eu Mesmo", "profilePicture": "https://exemplo/eu.jpg"},
            "msgContent": {"conversation": "oi grupo"},
        }
        group = {"nome": "Equipe", "photoUrl": "https://exemplo/equipe.jpg"}
        with patch.object(chat_router, "fetch_group_metadata", return_value=group):
            result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        db = await load_conversations("user-a")
        conv = db["120363000000000000@g.us"]
        self.assertEqual("Equipe", conv["contato"])
        self.assertEqual("https://exemplo/equipe.jpg", conv["photoUrl"])

    async def test_whatsapp_status_text_image_and_video_use_separate_feed(self) -> None:
        contents = {
            "text": {"conversation": "status em texto"},
            "image": {"imageMessage": {
                "caption": "status com imagem", "mimetype": "image/jpeg",
                "mediaKey": "img-key", "directPath": "/status/image",
            }},
            "video": {"videoMessage": {
                "caption": "status com video", "mimetype": "video/mp4",
                "mediaKey": "video-key", "directPath": "/status/video",
            }},
        }

        for index, (media_type, content) in enumerate(contents.items(), start=1):
            with self.subTest(media_type=media_type):
                payload = {
                    "event": "webhookReceived",
                    "instanceId": "INST-A",
                    "messageId": f"STATUS-{index}",
                    "phone": "status@broadcast",
                    "fromMe": False,
                    "sender": {"id": "5511999998888", "pushName": "Contato"},
                    "msgContent": content,
                }
                with patch.object(chat_router, "fetch_profile_picture", AsyncMock(return_value=None)):
                    result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

                self.assertEqual("success", result["status"])
                self.assertNotIn("status@broadcast", await load_conversations("user-a"))
                feed = await chat_router.load_whatsapp_status_feed("user-a")
                stored = next(item for item in feed["items"] if item["id"] == f"STATUS-{index}")
                self.assertEqual("5511999998888", stored["contactId"])
                if media_type in {"image", "video"}:
                    self.assertIn("/api/chat/midia/", stored["arquivoUrl"])

    async def test_duplicate_received_is_ignored(self) -> None:
        await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        again = await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        self.assertEqual("duplicate", again["status"])

    async def test_failed_dispatch_is_not_cached_and_retry_can_persist(self) -> None:
        handler = AsyncMock(side_effect=[RuntimeError("falha transitoria"), {"status": "success"}])
        with patch.object(chat_router, "_wapi_handle_received", handler):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(
                    self._received("RETRY-AFTER-FAILURE"), request=FakeRequest(secret=SECRET)
                )
            retry = await chat_router.webhook_whatsapp(
                self._received("RETRY-AFTER-FAILURE"), request=FakeRequest(secret=SECRET)
            )

        self.assertEqual(502, error.exception.status_code)
        self.assertEqual("success", retry["status"])
        self.assertEqual(2, handler.await_count)

    async def test_concurrent_duplicate_waits_for_first_dispatch(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def slow_handler(_user_id: str, _payload: dict) -> dict:
            entered.set()
            await release.wait()
            return {"status": "success"}

        with patch.object(chat_router, "_wapi_handle_received", side_effect=slow_handler) as handler:
            first = asyncio.create_task(
                chat_router.webhook_whatsapp(self._received("CONCURRENT"), request=FakeRequest(secret=SECRET))
            )
            await entered.wait()
            second = asyncio.create_task(
                chat_router.webhook_whatsapp(self._received("CONCURRENT"), request=FakeRequest(secret=SECRET))
            )
            await asyncio.sleep(0)
            self.assertEqual(1, handler.await_count)
            release.set()
            first_result, second_result = await asyncio.gather(first, second)

        self.assertEqual("success", first_result["status"])
        self.assertEqual("duplicate", second_result["status"])
        self.assertEqual(1, handler.await_count)

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

    async def test_successive_delivery_states_for_same_message_are_not_deduped(self) -> None:
        db = await load_conversations("user-a")
        conversa = new_conversation("5511999998888", contato="Joao", channel="whatsapp")
        conversa["mensagens"] = [{"id": "M10", "texto": "ola", "status": "enviado", "canal": "whatsapp"}]
        db["5511999998888"] = conversa
        await save_conversations(db, "user-a")

        delivered = {"event": "messageStatus", "instanceId": "INST-A", "messageId": "M10", "status": "DELIVERED"}
        read = {"event": "messageStatus", "instanceId": "INST-A", "messageId": "M10", "status": "READ"}
        self.assertEqual("success", (await chat_router.webhook_whatsapp(delivered, request=FakeRequest(secret=SECRET)))["status"])
        self.assertEqual("success", (await chat_router.webhook_whatsapp(read, request=FakeRequest(secret=SECRET)))["status"])
        stored = (await load_conversations("user-a"))["5511999998888"]["mensagens"][0]
        self.assertEqual("lido", stored["status"])

    async def test_chat_read_on_phone_clears_local_unread_count(self) -> None:
        db = await load_conversations("user-a")
        conversa = new_conversation("5511999998888", contato="Joao", channel="whatsapp")
        conversa["lida"] = False
        conversa["naoLidasCount"] = 3
        db["5511999998888"] = conversa
        await save_conversations(db, "user-a")

        event = {
            "event": "chatStatus",
            "instanceId": "INST-A",
            "eventId": "CHAT-READ-1",
            "chatId": "5511999998888",
            "isRead": True,
            "unreadCount": 0,
        }
        result = await chat_router.webhook_whatsapp(event, request=FakeRequest(secret=SECRET))
        self.assertEqual("success", result["status"])
        stored = (await load_conversations("user-a"))["5511999998888"]
        self.assertTrue(stored["lida"])
        self.assertEqual(0, stored["naoLidasCount"])

    async def test_chat_presence_event_can_propagate_mobile_read_state(self) -> None:
        db = await load_conversations("user-a")
        conversa = new_conversation("5511888887777", contato="Ana", channel="whatsapp")
        conversa["lida"] = False
        conversa["naoLidasCount"] = 2
        db["5511888887777"] = conversa
        await save_conversations(db, "user-a")

        event = {
            "event": "chatPresence",
            "instanceId": "INST-A",
            "eventId": "PRESENCE-READ-1",
            "chatId": "5511888887777",
            "isRead": True,
            "unreadCount": 0,
        }
        result = await chat_router.webhook_whatsapp(event, request=FakeRequest(secret=SECRET))
        self.assertEqual("success", result["status"])
        stored = (await load_conversations("user-a"))["5511888887777"]
        self.assertTrue(stored["lida"])
        self.assertEqual(0, stored["naoLidasCount"])

    async def test_delivery_with_from_me_content_syncs_phone_message_once(self) -> None:
        event = {
            "event": "webhookDelivery",
            "instanceId": "INST-A",
            "messageId": "PHONE-OUT-1",
            "phone": "5511999998888",
            "fromMe": True,
            "momment": 1700000300,
            "status": "SENT",
            "sender": {"pushName": "Eu"},
            "msgContent": {"conversation": "resposta pelo celular"},
        }
        first = await chat_router.webhook_whatsapp(event, request=FakeRequest(secret=SECRET))
        second = await chat_router.webhook_whatsapp(event, request=FakeRequest(secret=SECRET))
        self.assertEqual("success", first["status"])
        self.assertEqual("duplicate", second["status"])
        messages = (await load_conversations("user-a"))["5511999998888"]["mensagens"]
        synced = [message for message in messages if message["id"] == "PHONE-OUT-1"]
        self.assertEqual(1, len(synced))
        self.assertEqual("usuario", synced[0]["remetente"])
        self.assertEqual("enviado", synced[0]["status"])

    async def test_disconnected_webhook_clears_connected_timestamp(self) -> None:
        binding = wb.get_binding("user-a")
        binding.state = "connected"
        binding.connected_at = 1_700_000_000.0
        wb.save_binding("user-a", binding)

        result = chat_router._wapi_handle_connection("user-a", "disconnected")

        self.assertEqual("success", result["status"])
        updated = wb.get_binding("user-a")
        self.assertEqual("disconnected", updated.state)
        self.assertIsNone(updated.connected_at)


class WapiAdaptIncomingTests(unittest.TestCase):
    """Trava o parsing do payload real da W-API (grupo, nome, mídia, timestamp)."""

    def test_status_markers_are_rejected_before_content_adaptation(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        variants = [
            {"phone": "status@broadcast"},
            {"chat": {"id": "status@broadcast"}},
            {"phone": "5511999998888@c.us", "key": {"remoteJid": "status@broadcast"}},
            {"phone": "5511999998888@c.us", "isStatus": True},
        ]
        for marker in variants:
            with self.subTest(marker=marker):
                payload = {
                    "event": "webhookReceived",
                    "messageId": "STATUS-MARKER",
                    "msgContent": {"conversation": "não deve virar mensagem"},
                    **marker,
                }
                self.assertIsNone(adapt_incoming(payload))

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


    def test_received_reaction_is_flagged_not_stored_as_message(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "isGroup": False,
            "messageId": "R1",
            "chat": {"id": "73650132766836@lid"},
            "sender": {"pushName": "Nando"},
            "moment": 1700000002,
            "msgContent": {"reactionMessage": {"key": {"id": "TARGET-1"}, "text": "\U0001F602"}},
        }
        msg = adapt_incoming(payload)
        self.assertEqual("reaction", msg["tipo"])
        self.assertEqual("\U0001F602", msg["texto"])
        self.assertEqual("TARGET-1", msg["reactionTargetId"])

    def test_non_displayable_content_is_ignored(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "chat": {"id": "x@lid"},
            "sender": {},
            "moment": 1,
            "msgContent": {"protocolMessage": {"type": "REVOKE"}},
        }
        self.assertIsNone(adapt_incoming(payload))


class WapiPhoneLidTests(unittest.TestCase):
    def test_lid_and_group_kept_whole(self) -> None:
        from app.services.wapi_messaging import wapi_phone

        self.assertEqual("73650132766836@lid", wapi_phone("73650132766836@lid"))
        self.assertEqual("120363000000000000@g.us", wapi_phone("120363000000000000@g.us"))
        self.assertEqual("5511999998888", wapi_phone("5511999998888@c.us"))


if __name__ == "__main__":
    unittest.main()
