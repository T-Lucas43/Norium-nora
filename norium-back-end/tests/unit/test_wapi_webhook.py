from __future__ import annotations

import asyncio
import os
import secrets
import tempfile
import time
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
SHARED_ENVIRONMENTS = ("production", "prod", "railway", "staging")
LOCAL_TEST_ENVIRONMENTS = ("development", "test")
RUNTIME_MARKERS_CLEARED = {
    "RAILWAY_ENVIRONMENT": "",
    "RAILWAY_PROJECT_ID": "",
    "RAILWAY_SERVICE_ID": "",
    "VERCEL": "",
    "WEBSITE_INSTANCE_ID": "",
}


class WapiWebhookAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _payload() -> dict:
        return {
            "event": "webhookReceived",
            "instanceId": "INST-A",
        }

    @staticmethod
    def _runtime(environment: str):
        return patch.dict(
            os.environ,
            {
                "ENVIRONMENT": environment,
                "APP_ENV": environment,
                **RUNTIME_MARKERS_CLEARED,
            },
        )

    async def test_missing_configuration_is_only_allowed_in_local_test(self) -> None:
        for environment in SHARED_ENVIRONMENTS:
            owner = patch.object(chat_router.wb, "owner_of_instance")
            classify = patch.object(chat_router.wapi_webhook, "classify_event")
            with self.subTest(environment=environment), self._runtime(environment), patch.object(
                chat_router,
                "WAPI_WEBHOOK_SECRET",
                "",
            ), owner as owner_lookup, classify as classify_event:
                with self.assertRaises(HTTPException) as error:
                    await chat_router.webhook_whatsapp(self._payload())
                self.assertEqual(503, error.exception.status_code)
                owner_lookup.assert_not_called()
                classify_event.assert_not_called()

        for environment in LOCAL_TEST_ENVIRONMENTS:
            handler = AsyncMock(return_value={"status": "success"})
            with self.subTest(environment=environment), self._runtime(environment), patch.object(
                chat_router,
                "WAPI_WEBHOOK_SECRET",
                "",
            ), patch.object(
                chat_router.wb,
                "owner_of_instance",
                return_value="tenant-owner",
            ), patch.object(
                chat_router.wapi_webhook,
                "classify_event",
                return_value=chat_router.wapi_webhook.EVENT_RECEIVED,
            ), patch.object(chat_router, "_wapi_handle_received", handler):
                result = await chat_router.webhook_whatsapp(self._payload())
                self.assertEqual("success", result["status"])
                handler.assert_awaited_once()

    async def test_correct_secret_is_compared_and_accepted_in_every_environment(self) -> None:
        real_compare_digest = secrets.compare_digest
        for environment in (*SHARED_ENVIRONMENTS, *LOCAL_TEST_ENVIRONMENTS):
            handler = AsyncMock(return_value={"status": "success"})
            payload = self._payload()
            with self.subTest(environment=environment), self._runtime(environment), patch.object(
                chat_router,
                "WAPI_WEBHOOK_SECRET",
                SECRET,
            ), patch.object(
                chat_router.wb,
                "owner_of_instance",
                return_value="tenant-owner",
            ), patch.object(
                chat_router.wapi_webhook,
                "classify_event",
                return_value=chat_router.wapi_webhook.EVENT_RECEIVED,
            ), patch.object(
                chat_router,
                "_wapi_handle_received",
                handler,
            ), patch.object(
                chat_router.secrets,
                "compare_digest",
                wraps=real_compare_digest,
            ) as compare_digest:
                result = await chat_router.webhook_whatsapp(
                    payload,
                    request=FakeRequest(secret=SECRET),
                )
                self.assertEqual("success", result["status"])
                compare_digest.assert_called_once_with(SECRET, SECRET)
                handler.assert_awaited_once_with("tenant-owner", payload)

    async def test_missing_empty_and_wrong_secret_are_rejected_before_tenant_resolution(self) -> None:
        for environment in (*SHARED_ENVIRONMENTS, *LOCAL_TEST_ENVIRONMENTS):
            for supplied_secret in (None, "", "wrong-secret"):
                owner_lookup = patch.object(chat_router.wb, "owner_of_instance")
                classify = patch.object(chat_router.wapi_webhook, "classify_event")
                with self.subTest(
                    environment=environment,
                    supplied_secret=repr(supplied_secret),
                ), self._runtime(environment), patch.object(
                    chat_router,
                    "WAPI_WEBHOOK_SECRET",
                    SECRET,
                ), owner_lookup as owner, classify as classify_event:
                    with self.assertRaises(HTTPException) as error:
                        await chat_router.webhook_whatsapp(
                            self._payload(),
                            request=FakeRequest(secret=supplied_secret),
                        )
                    self.assertEqual(403, error.exception.status_code)
                    owner.assert_not_called()
                    classify_event.assert_not_called()

    async def test_invalid_configured_secret_fails_before_tenant_resolution(self) -> None:
        for configured_secret in ("   ", "contains whitespace", "line\nbreak", "segredo-ç"):
            with self.subTest(configured_secret=repr(configured_secret)), self._runtime(
                "development"
            ), patch.object(
                chat_router,
                "WAPI_WEBHOOK_SECRET",
                configured_secret,
            ), patch.object(chat_router.wb, "owner_of_instance") as owner_lookup:
                with self.assertRaises(HTTPException) as error:
                    await chat_router.webhook_whatsapp(
                        self._payload(),
                        request=FakeRequest(secret=configured_secret),
                    )
                self.assertEqual(503, error.exception.status_code)
                owner_lookup.assert_not_called()


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
        with patch.object(chat_router.wapi_webhook, "classify_event") as classify_event:
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))
        self.assertEqual(404, error.exception.status_code)
        classify_event.assert_not_called()

    async def test_payload_tenant_fields_cannot_override_instance_owner(self) -> None:
        payload = self._received(message_id="FORGED-TENANT")
        payload["userId"] = "user-b"
        payload["tenantId"] = "user-b"
        handler = AsyncMock(return_value={"status": "success"})

        with patch.object(chat_router, "_wapi_handle_received", handler):
            result = await chat_router.webhook_whatsapp(
                payload,
                request=FakeRequest(secret=SECRET),
            )

        self.assertEqual("success", result["status"])
        handler.assert_awaited_once_with("user-a", payload)

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

    async def test_received_preserves_saved_contact_name_over_profile_name(self) -> None:
        db = await load_conversations("user-a")
        db["5511999998888"] = new_conversation(
            "5511999998888",
            contato="Nome salvo na agenda",
            channel="whatsapp",
        )
        await save_conversations(db, "user-a")

        payload = self._received(message_id="CONTACT-NAME-1")
        payload["sender"] = {
            "notify": "Nome escolhido no WhatsApp",
            "pushName": "Nome escolhido no WhatsApp",
        }

        event = AsyncMock()
        with patch.object(chat_router, "record_event", event):
            result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        stored = (await load_conversations("user-a"))["5511999998888"]
        self.assertEqual("Nome salvo na agenda", stored["contato"])
        self.assertEqual("Nome salvo na agenda: oi", event.await_args.kwargs["description"])

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

    async def test_from_me_group_message_persists_before_remote_metadata(self) -> None:
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
        group_metadata = AsyncMock(return_value={"nome": "Equipe", "photoUrl": "https://exemplo/equipe.jpg"})
        with patch.object(chat_router, "fetch_group_metadata", group_metadata):
            result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        db = await load_conversations("user-a")
        conv = db["120363000000000000@g.us"]
        self.assertEqual("120363000000000000@g.us", conv["contato"])
        self.assertEqual("oi grupo", conv["mensagens"][0]["texto"])
        group_metadata.assert_not_awaited()

    async def test_group_sender_uses_saved_contact_name_instead_of_profile_name(self) -> None:
        sender_id = "5511999998888@s.whatsapp.net"
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "contacts": [],
                "chats": [
                    {
                        "id": sender_id,
                        "savedName": "Nome salvo na agenda",
                    }
                ],
            },
        )
        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "GROUP-IN1",
            "fromMe": False,
            "isGroup": True,
            "chat": {"id": "120363000000000000@g.us"},
            "sender": {
                "id": sender_id,
                "pushName": "Nome escolhido no WhatsApp",
            },
            "msgContent": {"conversation": "oi grupo"},
        }

        result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        conversation = (await load_conversations("user-a"))["120363000000000000@g.us"]
        self.assertEqual("Nome salvo na agenda", conversation["ultimoRemetenteNome"])
        self.assertEqual("Nome salvo na agenda", conversation["mensagens"][0]["remetenteNome"])

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
                    self.assertEqual(
                        "status com imagem" if media_type == "image" else "status com video",
                        stored["texto"],
                    )

    async def test_status_media_uses_outer_caption_in_the_same_feed_item(self) -> None:
        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "STATUS-OUTER-CAPTION",
            "phone": "status@broadcast",
            "sender": {"id": "5511999998888", "pushName": "Contato"},
            "caption": "legenda fora do node",
            "msgContent": {
                "imageMessage": {
                    "mimetype": "image/jpeg",
                    "mediaKey": "img-key",
                    "directPath": "/status/image",
                }
            },
        }

        result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        feed = await chat_router.load_whatsapp_status_feed("user-a")
        stored = next(item for item in feed["items"] if item["id"] == "STATUS-OUTER-CAPTION")
        self.assertEqual("legenda fora do node", stored["texto"])
        self.assertEqual("midia", stored["tipo"])
        self.assertEqual(1, sum(item["id"] == "STATUS-OUTER-CAPTION" for item in feed["items"]))
        listed = await chat_router.listar_status_whatsapp(
            user={
                "id": "user-a",
                "role": "owner",
                "plan": "enterprise",
                "status": "ativo",
                "permissions": {"chat": True, "integracao_whatsapp": True},
            }
        )
        serialized = next(item for item in listed["items"] if item["id"] == "STATUS-OUTER-CAPTION")
        self.assertEqual("legenda fora do node", serialized["text"])
        self.assertEqual("image", serialized["type"])

    def test_flat_status_media_type_aliases_are_not_downgraded_to_text(self) -> None:
        from app.services.wapi_webhook import adapt_status_broadcast

        mime_by_type = {
            "image": "image/jpeg",
            "video": "video/mp4",
            "audio": "audio/ogg",
        }
        internal_type_by_media = {
            "image": "midia",
            "video": "midia",
            "audio": "audio",
        }

        for discriminator in ("type", "messageType"):
            for media_type, mimetype in mime_by_type.items():
                with self.subTest(discriminator=discriminator, media_type=media_type):
                    payload = {
                        "event": "webhookReceived",
                        "instanceId": "INST-A",
                        "messageId": f"STATUS-FLAT-{discriminator}-{media_type}",
                        "chatId": "status@broadcast",
                        "sender": {"id": "5511999998888", "pushName": "Contato"},
                        discriminator: media_type,
                        "mimetype": mimetype,
                        "caption": f"legenda {media_type}",
                        "url": f"https://media.example.test/{media_type}",
                    }

                    adapted = adapt_status_broadcast(payload)

                    self.assertIsNotNone(adapted)
                    assert adapted is not None
                    self.assertEqual(internal_type_by_media[media_type], adapted["tipo"])
                    self.assertEqual(f"legenda {media_type}", adapted["texto"])
                    self.assertEqual(media_type, adapted["midiaMeta"]["type"])
                    self.assertEqual(mimetype, adapted["midiaMeta"]["mimetype"])
                    self.assertEqual(
                        f"https://media.example.test/{media_type}",
                        adapted["midiaMeta"]["sourceUrl"],
                    )

    def test_status_media_preserves_url_and_thumbnail_with_download_keys(self) -> None:
        from app.services.wapi_webhook import adapt_status_broadcast

        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "STATUS-WITH-FALLBACKS",
            "chatId": "status@broadcast",
            "sender": {"id": "5511999998888", "pushName": "Contato"},
            "msgContent": {
                "imageMessage": {
                    "caption": "imagem com fallback",
                    "mimetype": "image/jpeg",
                    "mediaKey": "media-key",
                    "directPath": "/status/image",
                    "url": "https://mmg.whatsapp.net/status/image",
                    "jpegThumbnail": "dGh1bWJuYWls",
                }
            },
        }

        adapted = adapt_status_broadcast(payload)

        self.assertIsNotNone(adapted)
        assert adapted is not None
        self.assertEqual("media-key", adapted["midiaMeta"]["mediaKey"])
        self.assertEqual("/status/image", adapted["midiaMeta"]["directPath"])
        self.assertEqual("https://mmg.whatsapp.net/status/image", adapted["midiaMeta"]["sourceUrl"])
        self.assertEqual("url", adapted["midiaMeta"]["sourceField"])
        self.assertEqual("dGh1bWJuYWls", adapted["midiaMeta"]["thumbnail"])

    async def test_wrapped_baileys_status_is_routed_only_to_tenant_feed(self) -> None:
        payload = {
            "body": {
                "event": "webhookReceived",
                "instanceId": "INST-A",
                "message": {
                    "key": {
                        "id": "STATUS-WRAPPED-1",
                        "remoteJid": {"user": "status", "server": "broadcast"},
                        "participant": "5511888887777@s.whatsapp.net",
                    },
                    "message": {"extendedTextMessage": {"text": "status em envelope"}},
                },
                "sender": {"id": "5511888887777", "pushName": "Ana"},
                "messageTimestamp": int(time.time()),
            }
        }

        result = await chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))

        self.assertEqual("success", result["status"])
        self.assertEqual({}, await load_conversations("user-a"))
        self.assertEqual({}, await load_conversations("user-b"))
        feed_a = await chat_router.load_whatsapp_status_feed("user-a")
        self.assertEqual(["STATUS-WRAPPED-1"], [item["id"] for item in feed_a["items"]])
        self.assertEqual("status em envelope", feed_a["items"][0]["texto"])
        self.assertEqual("Ana", feed_a["items"][0]["contactName"])
        self.assertEqual({"items": []}, await chat_router.load_whatsapp_status_feed("user-b"))

    async def test_duplicate_received_is_ignored(self) -> None:
        await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        again = await chat_router.webhook_whatsapp(self._received("DUP"), request=FakeRequest(secret=SECRET))
        self.assertEqual("duplicate", again["status"])

    async def test_stored_group_duplicate_skips_catalog_lookup(self) -> None:
        group_id = "120363000000000000@g.us"
        conversation = new_conversation(
            group_id,
            contato="Equipe",
            channel="whatsapp",
            is_group=True,
        )
        conversation["mensagens"] = [{"id": "GROUP-STORED-DUP"}]
        await save_conversations({group_id: conversation}, "user-a")
        payload = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "messageId": "GROUP-STORED-DUP",
            "fromMe": False,
            "isGroup": True,
            "chat": {"id": group_id},
            "sender": {
                "id": "5511999998888@s.whatsapp.net",
                "pushName": "Nome escolhido no WhatsApp",
            },
            "msgContent": {"conversation": "duplicada"},
        }
        catalog = AsyncMock(side_effect=AssertionError("catalogo nao deve ser lido"))

        with patch.object(chat_router, "load_whatsapp_catalog_cache", catalog):
            result = await chat_router.webhook_whatsapp(
                payload,
                request=FakeRequest(secret=SECRET),
            )

        self.assertEqual("duplicate", result["status"])
        catalog.assert_not_awaited()

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

    async def test_webhook_waiting_for_lock_is_ignored_after_binding_is_cleared(self) -> None:
        payload = self._received("STALE-AFTER-DISCONNECT", "não deve reaparecer")
        lock = chat_router.whatsapp_conversation_mutation_lock("user-a")
        await lock.acquire()
        task: asyncio.Task[dict] | None = None
        try:
            task = asyncio.create_task(
                chat_router.webhook_whatsapp(payload, request=FakeRequest(secret=SECRET))
            )
            for _ in range(20):
                if chat_router.whatsapp_webhook_inflight:
                    break
                await asyncio.sleep(0)
            self.assertTrue(chat_router.whatsapp_webhook_inflight)
            self.assertFalse(task.done())

            # Simula a parte atômica da desconexão enquanto o webhook, que já
            # resolveu o tenant, ainda espera o mesmo lock.
            wb.clear_binding("user-a")
            await save_conversations({}, "user-a")
        finally:
            lock.release()

        self.assertIsNotNone(task)
        result = await task
        self.assertEqual("ignored", result["status"])
        self.assertEqual("stale_binding", result["event"])
        self.assertEqual({}, await load_conversations("user-a"))

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
            # O callback oficial de delivery pode trazer fromMe=false; o tipo
            # do webhook continua representando mensagem enviada pela conta.
            "fromMe": False,
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

    def test_status_detection_accepts_catalog_aliases_objects_and_wrappers(self) -> None:
        from app.services.wapi_webhook import is_status_broadcast

        variants = [
            {"id": "status@broadcast"},
            {"id": "status"},
            {"id": "statuses"},
            {"chatId": "broadcast"},
            {"chatId": "status_v3"},
            {"chatId": "status-v3"},
            {"id": {"_serialized": "status@broadcast"}},
            {"wid": {"user": "status", "server": "broadcast"}},
            {"payload": {"chat": {"id": "status"}}},
            {"body": {"message": {"key": {"remoteJid": "status@broadcast"}}}},
            {"eventData": {"isStatusMessage": "true"}},
            {"messageData": {"statusBroadcast": "status@broadcast"}},
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                self.assertTrue(is_status_broadcast(variant))

        normal_variants = [
            {"id": "5511999998888@s.whatsapp.net", "name": "Status"},
            {"chatId": "5511999998888", "status": "READ"},
            {"chatId": "5511999998888", "text": "status@broadcast"},
            {"message": {"conversation": "broadcast"}, "phone": "5511999998888"},
        ]
        for variant in normal_variants:
            with self.subTest(normal_variant=variant):
                self.assertFalse(is_status_broadcast(variant))

    def test_catalog_status_expands_messages_with_forced_broadcast_chat(self) -> None:
        from app.services.wapi_webhook import status_broadcast_payloads

        expanded = status_broadcast_payloads(
            {
                "id": {"user": "status", "server": "broadcast"},
                "messages": [
                    {
                        "messageId": "CATALOG-STATUS-1",
                        "sender": {"id": "5511777776666", "pushName": "Bia"},
                        "msgContent": {"conversation": "do catálogo"},
                    }
                ],
            }
        )

        self.assertEqual(1, len(expanded))
        self.assertEqual("status@broadcast", expanded[0]["chatId"])
        self.assertEqual("CATALOG-STATUS-1", expanded[0]["messageId"])

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

    def test_group_sender_id_accepts_sender_identifier_aliases(self) -> None:
        from app.services.wapi_webhook import adapt_incoming

        variants = {
            "jid": "5511999998888@s.whatsapp.net",
            "lid": "73650132766836@lid",
            "senderLid": "73650132766837@lid",
            "phone": "5511999997777@s.whatsapp.net",
            "phoneNumber": "5511999996666@s.whatsapp.net",
        }
        for field, sender_id in variants.items():
            with self.subTest(field=field):
                message = adapt_incoming(
                    {
                        "event": "webhookReceived",
                        "messageId": "GROUP-SENDER-ALIAS",
                        "isGroup": True,
                        "chat": {"id": "120363000000000000@g.us"},
                        "sender": {field: sender_id, "pushName": "Joao"},
                        "msgContent": {"conversation": "ola grupo"},
                    }
                )

                self.assertIsNotNone(message)
                self.assertEqual(sender_id, message["senderId"])

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
            {
                "mediaKey": "abc",
                "directPath": "/v/t62...",
                "type": "image",
                "mimetype": "image/jpeg",
                "sourceUrl": "https://mmg.whatsapp.net/enc",
                "sourceField": "url",
            },
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
