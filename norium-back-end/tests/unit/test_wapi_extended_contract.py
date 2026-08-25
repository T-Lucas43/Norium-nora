from __future__ import annotations

import asyncio
import base64
import os
import tempfile
import time
import unittest
import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.conversation_store import load_conversations, new_conversation, save_conversations


def chat_user(user_id: str = "user-a") -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class WapiExtendedContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}))
        wb.save_binding("user-a", InstanceBinding(instance_id="INST-A", token="tok-a", state="connected"))
        chat_router.whatsapp_contact_sync_states.clear()
        chat_router.whatsapp_contact_sync_tasks.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()

    def tearDown(self) -> None:
        for task in chat_router.whatsapp_contact_sync_tasks.values():
            task.cancel()
        chat_router.whatsapp_contact_sync_tasks.clear()
        chat_router.whatsapp_contact_sync_states.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()
        self._stack.close()

    async def test_contact_pagination_uses_official_page_and_per_page(self) -> None:
        fetch = AsyncMock(
            side_effect=[
                {
                    "contacts": [{"id": "5511000000001", "notify": "Um"}],
                    "pagination": {"totalPages": 2},
                },
                {
                    "contacts": [{"id": "5511000000002", "notify": "Dois"}],
                    "pagination": {"totalPages": 2},
                },
            ]
        )
        with patch.object(chat_router.wapi_client, "fetch_contacts", fetch):
            contacts = await chat_router.fetch_all_wapi_contacts("user-a")

        self.assertEqual(["Um", "Dois"], [contact["notify"] for contact in contacts])
        self.assertEqual(1, fetch.await_args_list[0].kwargs["page"])
        self.assertEqual(100, fetch.await_args_list[0].kwargs["perPage"])
        self.assertEqual(2, fetch.await_args_list[1].kwargs["page"])

    async def test_contact_picker_filters_technical_ids_and_cleans_phone(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": time.time(),
                "contacts": [
                    {"id": "5511999999999@s.whatsapp.net", "notify": "Maria"},
                    {"id": "120363000000000000@g.us", "subject": "Grupo"},
                    {"id": "123@newsletter", "notify": "Canal"},
                    {"id": "9911223344@lid"},
                    {"id": "8811223344@lid", "notify": "Contato LID"},
                ],
            },
        )
        contacts = await chat_router.obter_contatos_disponiveis(user=chat_user())
        self.assertEqual(["Maria", "Contato LID"], [contact["name"] for contact in contacts])
        self.assertEqual("5511999999999", contacts[0]["phone"])
        self.assertEqual("5511999999999@s.whatsapp.net", contacts[0]["id"])

    async def test_contact_sync_does_not_block_on_profile_picture_refresh(self) -> None:
        expired = {
            "id": "5511999999999",
            "notify": "Maria",
            "photoUrl": "https://cdn.example/expired.jpg",
            "photoFetchedAt": time.time() - chat_router.WHATSAPP_PROFILE_PHOTO_TTL_SECONDS - 1,
        }
        profile = AsyncMock(return_value="https://cdn.example/fresh.jpg")
        with (
            patch.object(chat_router, "fetch_all_wapi_contacts", AsyncMock(return_value=[expired])),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
            patch.object(chat_router, "fetch_profile_picture", profile),
        ):
            result = await chat_router._run_contact_sync("user-a")
        self.assertEqual("complete", result["status"])
        profile.assert_not_awaited()
        cache = await chat_router.load_whatsapp_catalog_cache("user-a")
        self.assertEqual("https://cdn.example/expired.jpg", cache["contacts"][0]["photoUrl"])

    async def test_contact_sync_does_not_overwrite_message_arriving_concurrently(self) -> None:
        conversation_id = "5511999999999"
        await save_conversations(
            {conversation_id: new_conversation(conversation_id, contato="Numero", channel="whatsapp")},
            "user-a",
        )
        sync_save_entered = asyncio.Event()
        release_sync_save = asyncio.Event()
        save_calls = 0

        async def delayed_save(payload: dict, user_id: str) -> None:
            nonlocal save_calls
            save_calls += 1
            if save_calls == 1:
                sync_save_entered.set()
                await release_sync_save.wait()
            await save_conversations(payload, user_id)

        contact = {"id": conversation_id, "notify": "Maria", "photoFetchedAt": time.time()}
        incoming = {
            "event": "webhookReceived",
            "messageId": "DURING-CONTACT-SYNC",
            "phone": conversation_id,
            "fromMe": False,
            "moment": int(time.time()),
            "sender": {"pushName": "Maria"},
            "msgContent": {"conversation": "mensagem preservada"},
        }
        with (
            patch.object(chat_router, "fetch_all_wapi_contacts", AsyncMock(return_value=[contact])),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
            patch.object(chat_router, "fetch_profile_picture", AsyncMock(return_value=None)),
            patch.object(chat_router, "save_conversations", side_effect=delayed_save),
        ):
            sync_task = asyncio.create_task(chat_router._run_contact_sync("user-a"))
            await asyncio.wait_for(sync_save_entered.wait(), timeout=2)
            message_task = asyncio.create_task(chat_router._wapi_handle_received("user-a", incoming))
            await asyncio.sleep(0)
            self.assertFalse(message_task.done())
            release_sync_save.set()
            await asyncio.gather(sync_task, message_task)

        stored = await load_conversations("user-a")
        messages = stored[conversation_id]["mensagens"]
        self.assertEqual(["DURING-CONTACT-SYNC"], [message["id"] for message in messages])
        self.assertEqual("Maria", stored[conversation_id]["contato"])

    async def test_status_route_returns_frontend_shape(self) -> None:
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": "STATUS-1",
                        "contactId": "5511999999999",
                        "contactName": "Maria",
                        "photoUrl": "https://cdn.example/maria.jpg",
                        "tipo": "midia",
                        "texto": "foto",
                        "midiaMeta": {"type": "image", "mimetype": "image/jpeg"},
                        "arquivoUrl": "/api/chat/midia/STATUS-1?conversa_id=status%40broadcast",
                        "timestamp": 9_999_999_999,
                        "visualizado": False,
                        "fromMe": False,
                    }
                ]
            },
        )
        result = await chat_router.listar_status_whatsapp(chat_user())
        item = result["items"][0]
        self.assertEqual("Maria", item["name"])
        self.assertEqual("image", item["type"])
        self.assertEqual("foto", item["text"])
        self.assertFalse(item["viewed"])
        self.assertFalse(item["mine"])
        self.assertIn("/api/chat/midia/", item["mediaUrl"])

    async def test_status_media_is_downloaded_from_separate_feed(self) -> None:
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": "STATUS-MEDIA",
                        "midiaMeta": {
                            "mediaKey": "key",
                            "directPath": "/status/image",
                            "type": "image",
                            "mimetype": "image/jpeg",
                        },
                        "timestamp": 9_999_999_999,
                    }
                ]
            },
        )
        image = b"\xff\xd8\xffstatus"
        with patch.object(
            chat_router.wapi_client,
            "download_media",
            AsyncMock(return_value={"base64": base64.b64encode(image).decode()}),
        ):
            response = await chat_router.obter_midia_whatsapp(
                "STATUS-MEDIA",
                conversa_id="status",
                user=chat_user(),
            )
        self.assertEqual(image, response.body)
        self.assertEqual("image/jpeg", response.media_type)

    def test_download_media_response_accepts_official_link_inside_envelopes(self) -> None:
        inline, link = chat_router.unpack_wapi_media_response(
            {"data": {"result": {"fileLink": "https://api.w-api.app/media/status.jpeg"}}}
        )

        self.assertIsNone(inline)
        self.assertEqual("https://api.w-api.app/media/status.jpeg", link)

    def test_external_media_url_rejects_local_and_private_destinations(self) -> None:
        blocked = (
            "https://localhost/status",
            "https://service.internal/status",
            "https://127.0.0.1/status",
            "https://10.0.0.8/status",
            "https://169.254.169.254/latest/meta-data",
            "https://192.168.1.20/status",
            "https://[::1]/status",
        )

        for url in blocked:
            with self.subTest(url=url), self.assertRaises(HTTPException) as error:
                chat_router.validate_external_media_url(url)
            self.assertEqual(400, error.exception.status_code)

    async def test_external_media_redirect_is_validated_before_following(self) -> None:
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.get = AsyncMock(
            return_value=SimpleNamespace(
                status_code=302,
                headers={"Location": "https://127.0.0.1/private"},
                content=b"",
            )
        )

        public_dns = [
            (
                chat_router.socket.AF_INET,
                chat_router.socket.SOCK_STREAM,
                6,
                "",
                ("93.184.216.34", 443),
            )
        ]
        with (
            patch.object(chat_router.socket, "getaddrinfo", return_value=public_dns),
            patch.object(chat_router.httpx, "AsyncClient", return_value=client),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.fetch_external_whatsapp_media(
                    "https://api.w-api.app/media/status.jpeg",
                    timeout=10.0,
                )

        self.assertEqual(400, error.exception.status_code)
        client.get.assert_awaited_once_with(
            "https://api.w-api.app/media/status.jpeg",
            timeout=10.0,
        )

    async def test_external_media_allows_valid_https_wapi_redirect(self) -> None:
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.get = AsyncMock(
            side_effect=[
                SimpleNamespace(
                    status_code=302,
                    headers={"Location": "https://cdn.w-api.app/media/status.jpeg"},
                    content=b"",
                ),
                SimpleNamespace(
                    status_code=200,
                    headers={"Content-Type": "image/jpeg"},
                    content=b"\xff\xd8\xffstatus",
                ),
            ]
        )

        public_dns = [
            (
                chat_router.socket.AF_INET,
                chat_router.socket.SOCK_STREAM,
                6,
                "",
                ("93.184.216.34", 443),
            )
        ]
        with (
            patch.object(chat_router.socket, "getaddrinfo", return_value=public_dns),
            patch.object(chat_router.httpx, "AsyncClient", return_value=client),
        ):
            response = await chat_router.fetch_external_whatsapp_media(
                "https://api.w-api.app/media/status.jpeg",
                timeout=10.0,
            )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [
                "https://api.w-api.app/media/status.jpeg",
                "https://cdn.w-api.app/media/status.jpeg",
            ],
            [call.args[0] for call in client.get.await_args_list],
        )

    async def test_external_media_rejects_hostname_resolving_to_private_ip(self) -> None:
        private_dns = [
            (
                chat_router.socket.AF_INET,
                chat_router.socket.SOCK_STREAM,
                6,
                "",
                ("10.20.30.40", 443),
            )
        ]

        with patch.object(chat_router.socket, "getaddrinfo", return_value=private_dns):
            with self.assertRaises(HTTPException) as error:
                await chat_router.fetch_external_whatsapp_media(
                    "https://media.example.test/status.jpeg",
                    timeout=10.0,
                )

        self.assertEqual(400, error.exception.status_code)

    async def test_flat_status_url_is_used_as_safe_media_fallback(self) -> None:
        message_id = f"STATUS-FLAT-URL-{uuid.uuid4().hex}"
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": message_id,
                        "midiaMeta": {
                            "mediaKey": "",
                            "directPath": "",
                            "type": "image",
                            "mimetype": "image/jpeg",
                            "sourceUrl": "https://cdn.w-api.app/media/status.jpeg",
                            "sourceField": "url",
                        },
                        "timestamp": 9_999_999_999,
                    }
                ]
            },
        )
        image = b"\xff\xd8\xffflat-status"
        response_payload = SimpleNamespace(
            status_code=200,
            headers={"Content-Type": "image/jpeg"},
            content=image,
        )
        safe_fetch = AsyncMock(return_value=response_payload)

        with patch.object(chat_router, "fetch_external_whatsapp_media", safe_fetch):
            response = await chat_router.obter_midia_whatsapp(
                message_id,
                conversa_id="status@broadcast",
                user=chat_user(),
            )

        self.assertEqual(image, response.body)
        safe_fetch.assert_awaited_once_with(
            "https://cdn.w-api.app/media/status.jpeg",
            timeout=60.0,
        )

    async def test_status_image_uses_embedded_thumbnail_when_full_media_is_unavailable(self) -> None:
        thumbnail = b"\xff\xd8\xffthumbnail"
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": "STATUS-THUMBNAIL",
                        "midiaMeta": {
                            "mediaKey": "",
                            "directPath": "",
                            "type": "image",
                            "mimetype": "image/jpeg",
                            "thumbnail": base64.b64encode(thumbnail).decode(),
                        },
                        "timestamp": 9_999_999_999,
                    }
                ]
            },
        )

        response = await chat_router.obter_midia_whatsapp(
            "STATUS-THUMBNAIL",
            conversa_id="status@broadcast",
            user=chat_user(),
        )

        self.assertEqual(thumbnail, response.body)
        self.assertEqual("image/jpeg", response.media_type)

    async def test_status_image_continues_from_expired_links_to_embedded_thumbnail(self) -> None:
        thumbnail = b"\xff\xd8\xffthumbnail-chain"
        message_id = f"STATUS-FALLBACK-CHAIN-{uuid.uuid4().hex}"
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": message_id,
                        "midiaMeta": {
                            "mediaKey": "key",
                            "directPath": "/status/image",
                            "type": "image",
                            "mimetype": "image/jpeg",
                            "sourceUrl": "https://cdn.w-api.app/media/expired-source.jpeg",
                            "sourceField": "filelink",
                            "thumbnail": base64.b64encode(thumbnail).decode(),
                        },
                        "timestamp": 9_999_999_999,
                    }
                ]
            },
        )
        safe_fetch = AsyncMock(
            side_effect=[
                HTTPException(status_code=404, detail="link expirado"),
                HTTPException(status_code=404, detail="source expirado"),
            ]
        )

        with (
            patch.object(
                chat_router.wapi_client,
                "download_media",
                AsyncMock(return_value={"fileLink": "https://api.w-api.app/media/expired.jpeg"}),
            ),
            patch.object(chat_router, "fetch_external_whatsapp_media", safe_fetch),
        ):
            response = await chat_router.obter_midia_whatsapp(
                message_id,
                conversa_id="status@broadcast",
                user=chat_user(),
            )

        self.assertEqual(thumbnail, response.body)
        self.assertEqual("image/jpeg", response.media_type)
        self.assertEqual(2, safe_fetch.await_count)

    async def test_video_and_audio_status_do_not_serve_image_thumbnail_as_media(self) -> None:
        thumbnail = base64.b64encode(b"\xff\xd8\xffthumbnail").decode()

        for media_type, mimetype in (("video", "video/mp4"), ("audio", "audio/ogg")):
            with self.subTest(media_type=media_type):
                message_id = f"STATUS-{media_type.upper()}-THUMBNAIL"
                await chat_router.save_whatsapp_status_feed(
                    "user-a",
                    {
                        "items": [
                            {
                                "id": message_id,
                                "midiaMeta": {
                                    "mediaKey": "",
                                    "directPath": "",
                                    "type": media_type,
                                    "mimetype": mimetype,
                                    "thumbnail": thumbnail,
                                },
                                "timestamp": 9_999_999_999,
                            }
                        ]
                    },
                )

                with self.assertRaises(HTTPException) as error:
                    await chat_router.obter_midia_whatsapp(
                        message_id,
                        conversa_id="status@broadcast",
                        user=chat_user(),
                    )

                self.assertEqual(404, error.exception.status_code)

    async def test_marking_status_viewed_does_not_drop_concurrent_status(self) -> None:
        now = int(time.time())
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": "STATUS-A",
                        "contactId": "5511000000001",
                        "contactName": "Ana",
                        "timestamp": now,
                        "texto": "Primeiro",
                        "tipo": "texto",
                        "visualizado": False,
                    }
                ]
            },
        )
        original_load = chat_router.load_whatsapp_status_feed
        first_load_started = asyncio.Event()
        release_first_load = asyncio.Event()
        load_count = 0

        async def controlled_load(user_id: str):
            nonlocal load_count
            payload = await original_load(user_id)
            load_count += 1
            if load_count == 1:
                first_load_started.set()
                await release_first_load.wait()
            return payload

        async def add_second_status() -> None:
            async with chat_router.whatsapp_conversation_mutation_lock("user-a"):
                await chat_router._store_status_items_unlocked(
                    "user-a",
                    [
                        {
                            "id": "STATUS-B",
                            "contactId": "5511000000002",
                            "contactName": "Bia",
                            "timestamp": now,
                            "texto": "Segundo",
                            "tipo": "texto",
                        }
                    ],
                )

        with (
            patch.object(chat_router, "load_whatsapp_status_feed", controlled_load),
            patch.object(chat_router.wapi_client, "read_message", AsyncMock(return_value={})),
        ):
            mark_task = asyncio.create_task(
                chat_router.visualizar_status_whatsapp("STATUS-A", user=chat_user())
            )
            await first_load_started.wait()
            add_task = asyncio.create_task(add_second_status())
            await asyncio.sleep(0)
            self.assertFalse(add_task.done())
            release_first_load.set()
            await asyncio.gather(mark_task, add_task)

        stored = await original_load("user-a")
        by_id = {item["id"]: item for item in stored["items"]}
        self.assertEqual({"STATUS-A", "STATUS-B"}, set(by_id))
        self.assertTrue(by_id["STATUS-A"]["visualizado"])

    async def test_groups_list_returns_chat_conversations(self) -> None:
        payload = {
            "groups": [
                {
                    "id": "120363000000000000@g.us",
                    "subject": "Familia",
                    "description": "Grupo da familia",
                    "participants": [{"id": "5511999999999"}],
                }
            ]
        }
        with patch.object(chat_router.wapi_client, "get_all_groups", AsyncMock(return_value=payload)):
            result = await chat_router.listar_grupos(chat_user())
        group = result["items"][0]
        self.assertEqual("120363000000000000@g.us", group["id"])
        self.assertEqual("Familia", group["contato"])
        self.assertTrue(group["esGrupo"])
        self.assertEqual("Grupo da familia", group["metadados"]["descricaoGrupo"])

    async def test_connected_event_starts_sync_progress(self) -> None:
        with patch.object(chat_router, "schedule_contact_sync", return_value={"status": "syncing"}) as schedule:
            result = chat_router._wapi_handle_connection("user-a", "connected")
        self.assertEqual("success", result["status"])
        schedule.assert_called_once_with("user-a", force=True)
        self.assertEqual("syncing", chat_router.contact_sync_state("user-a")["status"])

    async def test_read_update_is_returned_once_by_delta_cursor(self) -> None:
        from app.services.conversation_store import new_conversation, save_conversations

        conversation = new_conversation("5511999999999", contato="Maria", channel="whatsapp")
        conversation["lida"] = False
        conversation["naoLidasCount"] = 1
        await save_conversations({"5511999999999": conversation}, "user-a")
        before = int(time.time()) - 1
        await chat_router._wapi_handle_status(
            "user-a",
            {"event": "chatStatus", "chatId": "5511999999999", "isRead": True, "unreadCount": 0},
        )
        with patch.object(chat_router.wapi_connect, "status", AsyncMock(return_value={"status": "conectado"})):
            first = await chat_router.obter_conversas(since=before, limit=100, user=chat_user())
            second = await chat_router.obter_conversas(since=first["cursor"], limit=100, user=chat_user())
        self.assertEqual(1, len(first["items"]))
        self.assertTrue(first["items"][0]["lida"])
        self.assertEqual(0, first["items"][0]["naoLidasCount"])
        self.assertGreater(first["cursor"], before)
        self.assertEqual([], second["items"])

    async def test_new_message_advances_cursor_after_same_second_read_update(self) -> None:
        from app.services.conversation_store import new_conversation, save_conversations

        conversation = new_conversation("5511999999999", contato="Maria", channel="whatsapp")
        await save_conversations({"5511999999999": conversation}, "user-a")
        await chat_router._wapi_handle_status(
            "user-a",
            {"event": "chatStatus", "chatId": "5511999999999", "isRead": True, "unreadCount": 0},
        )
        cache = await chat_router.load_whatsapp_catalog_cache("user-a")
        read_cursor = int(cache["conversationUpdates"]["5511999999999"])
        with patch.object(chat_router, "fetch_profile_picture", AsyncMock(return_value=None)):
            await chat_router._wapi_handle_received(
                "user-a",
                {
                    "event": "webhookReceived",
                    "messageId": "NEW-SAME-SECOND",
                    "phone": "5511999999999",
                    "fromMe": False,
                    "momment": int(time.time()),
                    "sender": {"pushName": "Maria"},
                    "msgContent": {"conversation": "mensagem nova"},
                },
            )
        with patch.object(chat_router.wapi_connect, "status", AsyncMock(return_value={"status": "conectado"})):
            delta = await chat_router.obter_conversas(since=read_cursor, limit=100, user=chat_user())
        self.assertEqual(1, len(delta["items"]))
        self.assertEqual("mensagem nova", delta["items"][0]["ultimoTexto"])
        self.assertGreater(delta["cursor"], read_cursor)


if __name__ == "__main__":
    unittest.main()
