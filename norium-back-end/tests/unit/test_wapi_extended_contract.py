from __future__ import annotations

import asyncio
import base64
import os
import tempfile
import time
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

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

    async def test_extract_photo_url_accepts_nested_wapi_aliases(self) -> None:
        cases = [
            ({"profilePicture": "https://cdn.example/direct.jpg"}, "https://cdn.example/direct.jpg"),
            ({"contact": {"profilePicture": "https://cdn.example/contact.jpg"}}, "https://cdn.example/contact.jpg"),
            ({"sender": {"profilePicUrl": "https://cdn.example/sender.jpg"}}, "https://cdn.example/sender.jpg"),
            ({"sender": {"contact": {"imgUrl": "https://cdn.example/sender-contact.jpg"}}}, "https://cdn.example/sender-contact.jpg"),
        ]

        for payload, expected in cases:
            with self.subTest(payload=payload):
                self.assertEqual(expected, chat_router.extract_photo_url(payload))

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

    async def test_channels_list_returns_only_cached_newsletters_in_frontend_shape(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": time.time(),
                "channels": [
                    {
                        "id": "120363400000000001@newsletter",
                        "subject": "Noticias da Norium",
                        "description": "Atualizacoes do produto",
                        "profilePictureUrl": "https://cdn.example/norium.jpg",
                        "isVerified": True,
                        "unreadCount": "4",
                        "lastMessageTime": 1_725_000_123,
                    },
                    {"newsletter": {"id": "120363400000000001@newsletter", "subject": "Noticias duplicadas"}},
                    {"id": "5511999999999@s.whatsapp.net", "notify": "Maria"},
                ],
            },
        )

        result = await chat_router.listar_canais_whatsapp(user=chat_user())

        self.assertEqual(
            {
                "items": [
                    {
                        "id": "120363400000000001@newsletter",
                        "name": "Noticias da Norium",
                        "description": "Atualizacoes do produto",
                        "photoUrl": "https://cdn.example/norium.jpg",
                        "verified": True,
                        "unreadCount": 4,
                        "timestamp": 1_725_000_123,
                    }
                ]
            },
            result,
        )

    async def test_channels_list_includes_normalized_messages_for_selected_channel(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": time.time(),
                "channels": [
                    {
                        "id": "120363400000000010@newsletter",
                        "subject": "Ofertas Norium",
                        "messages": [
                            {
                                "messageId": "CHANNEL-UPDATE-2",
                                "moment": 1_725_000_200,
                                "fromMe": False,
                                "msgContent": {"conversation": "Segunda atualizacao do canal"},
                            },
                            {
                                "messageId": "CHANNEL-UPDATE-1",
                                "moment": 1_725_000_100,
                                "fromMe": False,
                                "msgContent": {"conversation": "Primeira atualizacao do canal"},
                            },
                        ],
                    }
                ],
            },
        )

        result = await chat_router.listar_canais_whatsapp(user=chat_user())

        messages = result["items"][0].get("messages")
        self.assertEqual(
            [
                {
                    "id": "CHANNEL-UPDATE-1",
                    "texto": "Primeira atualizacao do canal",
                    "tipo": "texto",
                    "timestamp": 1_725_000_100,
                    "remetente": "contato",
                },
                {
                    "id": "CHANNEL-UPDATE-2",
                    "texto": "Segunda atualizacao do canal",
                    "tipo": "texto",
                    "timestamp": 1_725_000_200,
                    "remetente": "contato",
                },
            ],
            [
                {
                    "id": message.get("id"),
                    "texto": message.get("texto"),
                    "tipo": message.get("tipo"),
                    "timestamp": message.get("timestamp"),
                    "remetente": message.get("remetente"),
                }
                for message in (messages or [])
            ],
        )

    async def test_channel_catalog_media_uses_private_route_without_persisting_conversation(self) -> None:
        channel_id = "120363400000000012@newsletter"
        message_id = f"CHANNEL-CATALOG-MEDIA-{uuid.uuid4().hex}"
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": time.time(),
                "channels": [
                    {
                        "id": channel_id,
                        "subject": "Canal com imagem",
                        "messages": [
                            {
                                "messageId": message_id,
                                "moment": 1_725_000_250,
                                "fromMe": False,
                                "msgContent": {
                                    "imageMessage": {
                                        "caption": "Imagem do catalogo",
                                        "mediaKey": "catalog-key",
                                        "directPath": "/catalog/image",
                                        "mimetype": "image/jpeg",
                                    }
                                },
                            }
                        ],
                    }
                ],
            },
        )

        result = await chat_router.listar_canais_whatsapp(user=chat_user())

        message = result["items"][0]["messages"][0]
        media_url = urlparse(message["arquivoUrl"])
        self.assertEqual(f"/api/chat/midia/{message_id}", media_url.path)
        self.assertEqual([channel_id], parse_qs(media_url.query).get("conversa_id"))
        self.assertEqual({}, await load_conversations("user-a"))

        image = b"\xff\xd8\xffchannel-catalog"
        download = AsyncMock(return_value={"base64": base64.b64encode(image).decode()})
        with patch.object(chat_router.wapi_client, "download_media", download):
            response = await chat_router.obter_midia_whatsapp(
                message_id,
                conversa_id=channel_id,
                user=chat_user(),
            )

        self.assertEqual(image, response.body)
        self.assertEqual("image/jpeg", response.media_type)
        download.assert_awaited_once_with(
            "INST-A",
            "tok-a",
            media_key="catalog-key",
            direct_path="/catalog/image",
            media_type="image",
            mimetype="image/jpeg",
        )
        self.assertEqual({}, await load_conversations("user-a"))

    async def test_channels_merge_last_message_with_messages_persisted_by_webhook(self) -> None:
        channel_id = "120363400000000011@newsletter"
        conversation = new_conversation(channel_id, contato="Canal com historico", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "CHANNEL-WEBHOOK-1",
                "remetente": "contato",
                "texto": "Atualizacao recebida pelo webhook",
                "tipo": "texto",
                "horario": "10:40",
                "timestamp": 1_725_000_400,
                "canal": "whatsapp",
                "channel": "whatsapp",
            }
        ]
        await save_conversations({channel_id: conversation}, "user-a")
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": time.time(),
                "channels": [
                    {
                        "id": channel_id,
                        "subject": "Canal com historico",
                        "lastMessage": {
                            "messageId": "CHANNEL-CATALOG-LAST",
                            "moment": 1_725_000_300,
                            "fromMe": False,
                            "msgContent": {"conversation": "Ultima publicacao do catalogo"},
                        },
                    }
                ],
            },
        )

        result = await chat_router.listar_canais_whatsapp(user=chat_user())

        messages = result["items"][0]["messages"]
        self.assertEqual(
            ["CHANNEL-CATALOG-LAST", "CHANNEL-WEBHOOK-1"],
            [message["id"] for message in messages],
        )
        self.assertEqual(
            ["Ultima publicacao do catalogo", "Atualizacao recebida pelo webhook"],
            [message["texto"] for message in messages],
        )

    async def test_stale_channels_list_schedules_catalog_sync_without_remote_request(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": 0,
                "channels": [{"id": "120363400000000002@newsletter", "name": "Ofertas"}],
            },
        )

        with (
            patch.object(chat_router, "schedule_contact_sync", return_value={"status": "syncing"}) as schedule,
            patch.object(chat_router.wapi_client, "fetch_contacts", AsyncMock()) as fetch_contacts,
            patch.object(chat_router.wapi_client, "fetch_chats", AsyncMock()) as fetch_chats,
        ):
            result = await chat_router.listar_canais_whatsapp(user=chat_user())

        self.assertEqual("Ofertas", result["items"][0]["name"])
        schedule.assert_called_once_with("user-a", force=True)
        fetch_contacts.assert_not_awaited()
        fetch_chats.assert_not_awaited()

    async def test_channels_list_reads_legacy_newsletter_until_catalog_migration(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "channelsSyncedAt": time.time(),
                "contacts": [
                    {
                        "id": "120363400000000009@newsletter",
                        "notify": "Canal legado",
                    }
                ],
            },
        )

        result = await chat_router.listar_canais_whatsapp(user=chat_user())

        self.assertEqual(
            ["120363400000000009@newsletter"],
            [item["id"] for item in result["items"]],
        )

    async def test_catalog_sync_keeps_newsletters_out_of_contacts_and_conversations(self) -> None:
        now = int(time.time())
        contacts_payload = [
            {"id": "5511999999999@s.whatsapp.net", "notify": "Maria"},
            {"id": "120363400000000003@newsletter", "notify": "Canal Norium"},
        ]
        chats_payload = [
            {
                "id": "5511999999999@s.whatsapp.net",
                "notify": "Maria",
                "lastMessageTime": now,
            },
            {
                "id": "120363400000000003@newsletter",
                "subject": "Canal Norium",
                "description": "Novidades semanais",
                "lastMessageTime": now,
            },
        ]
        with (
            patch.object(chat_router, "fetch_all_wapi_contacts", AsyncMock(return_value=contacts_payload)),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=chats_payload)),
            patch.object(chat_router, "schedule_contact_sync", return_value={"status": "syncing"}),
        ):
            await chat_router._run_contact_sync("user-a")
            channels = await chat_router.listar_canais_whatsapp(user=chat_user())
            conversations = await chat_router.obter_conversas(
                since=None, limit=100, refresh=False, user=chat_user()
            )
            contacts = await chat_router.obter_contatos_disponiveis(user=chat_user())

        self.assertEqual(
            ["120363400000000003@newsletter"],
            [item["id"] for item in channels["items"]],
        )
        self.assertEqual(
            ["5511999999999@s.whatsapp.net"],
            [item["id"] for item in conversations],
        )
        self.assertEqual(
            ["5511999999999@s.whatsapp.net"],
            [item["id"] for item in contacts],
        )

    async def test_conversations_list_excludes_newsletters_persisted_by_webhooks(self) -> None:
        contact_id = "5511999999999@s.whatsapp.net"
        channel_id = "120363400000000013@newsletter"
        now = int(time.time())
        contact = new_conversation(contact_id, contato="Maria", channel="whatsapp")
        contact["timestampUltimaMsg"] = now - 1
        channel = new_conversation(channel_id, contato="Canal persistido", channel="whatsapp")
        channel["timestampUltimaMsg"] = now
        await save_conversations(
            {
                contact_id: contact,
                channel_id: channel,
            },
            "user-a",
        )
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "catalogSyncedAt": time.time(),
            },
        )

        result = await chat_router.obter_conversas(
            since=None,
            limit=100,
            refresh=False,
            user=chat_user(),
        )

        self.assertEqual([contact_id], [item["id"] for item in result])

    async def test_conversations_delta_excludes_newsletters_persisted_by_webhooks(self) -> None:
        contact_id = "5511888888888@s.whatsapp.net"
        channel_id = "120363400000000014@newsletter"
        now = int(time.time())
        contact = new_conversation(contact_id, contato="Ana", channel="whatsapp")
        contact["timestampUltimaMsg"] = now
        channel = new_conversation(channel_id, contato="Canal no delta", channel="whatsapp")
        channel["timestampUltimaMsg"] = now + 1
        await save_conversations(
            {
                contact_id: contact,
                channel_id: channel,
            },
            "user-a",
        )

        result = await chat_router.obter_conversas(
            since=now - 10,
            limit=100,
            refresh=False,
            user=chat_user(),
        )

        self.assertEqual([contact_id], [item["id"] for item in result["items"]])
        self.assertEqual(now, result["cursor"])

    async def test_profile_photo_endpoint_prefers_group_metadata(self) -> None:
        group_id = "120363000000000777@g.us"
        fresh_photo = "https://cdn.example/fresh-group.jpg"
        metadata = AsyncMock(return_value={"group": {"id": group_id, "profilePicUrl": fresh_photo}})
        fallback = AsyncMock(return_value="https://cdn.example/contact-fallback.jpg")

        with (
            patch.object(chat_router.wapi_client, "group_metadata", metadata),
            patch.object(chat_router, "fetch_profile_picture", fallback),
        ):
            result = await chat_router.obter_foto_perfil(phone=group_id, user=chat_user())

        self.assertEqual(fresh_photo, result["photoUrl"])
        metadata.assert_awaited_once_with("INST-A", "tok-a", group_id)
        fallback.assert_not_awaited()

    async def test_profile_photo_endpoint_falls_back_when_group_metadata_has_no_photo(self) -> None:
        group_id = "120363000000000778@g.us"
        fallback_photo = "https://cdn.example/group-contact-fallback.jpg"
        metadata = AsyncMock(return_value={"group": {"id": group_id, "subject": "Equipe"}})
        fallback = AsyncMock(return_value=fallback_photo)

        with (
            patch.object(chat_router.wapi_client, "group_metadata", metadata),
            patch.object(chat_router, "fetch_profile_picture", fallback),
        ):
            result = await chat_router.obter_foto_perfil(phone=group_id, user=chat_user())

        self.assertEqual(fallback_photo, result["photoUrl"])
        metadata.assert_awaited_once_with("INST-A", "tok-a", group_id)
        fallback.assert_awaited_once_with("user-a", group_id)

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

    async def test_status_route_enriches_photo_from_nested_contact_cache(self) -> None:
        photo_url = "https://cdn.example/maria-from-cache.jpg"
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": time.time(),
                "contacts": [
                    {
                        "contact": {
                            "id": "5511999999999@s.whatsapp.net",
                            "profilePicUrl": photo_url,
                        }
                    }
                ],
            },
        )
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": "STATUS-WITH-CACHED-PHOTO",
                        "contactId": "5511999999999@s.whatsapp.net",
                        "contactName": "Maria",
                        "tipo": "texto",
                        "texto": "Status sem foto no evento",
                        "timestamp": 9_999_999_999,
                        "visualizado": False,
                        "fromMe": False,
                    }
                ]
            },
        )

        result = await chat_router.listar_status_whatsapp(chat_user())

        self.assertEqual(photo_url, result["items"][0].get("photoUrl"))

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

    async def test_external_media_private_redirect_is_rejected_without_following(self) -> None:
        requests = []

        def redirect_response(request):
            requests.append(request)
            return chat_router.httpx.Response(
                302,
                headers={"Location": "https://127.0.0.1/private"},
            )

        client = chat_router.httpx.AsyncClient(
            transport=chat_router.httpx.MockTransport(redirect_response),
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
                    connect_timeout=3.0,
                    read_timeout=10.0,
                )

        self.assertEqual(404, error.exception.status_code)
        self.assertEqual(1, len(requests))

    async def test_external_media_wapi_redirect_is_also_rejected_without_following(self) -> None:
        requests = []

        def redirect_response(request):
            requests.append(request)
            return chat_router.httpx.Response(
                302,
                headers={"Location": "https://cdn.w-api.app/media/status.jpeg"},
            )

        client = chat_router.httpx.AsyncClient(
            transport=chat_router.httpx.MockTransport(redirect_response),
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
                    connect_timeout=3.0,
                    read_timeout=10.0,
                )

        self.assertEqual(404, error.exception.status_code)
        self.assertEqual(1, len(requests))

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

        with (
            patch.object(chat_router, "WHATSAPP_MEDIA_HOSTS", {"media.example.test"}),
            patch.object(chat_router.socket, "getaddrinfo", return_value=private_dns),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.fetch_external_whatsapp_media(
                    "https://media.example.test/status.jpeg",
                    connect_timeout=3.0,
                    read_timeout=10.0,
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
        with tempfile.TemporaryDirectory() as media_directory:
            artifact_path = Path(media_directory) / "status.jpeg"
            artifact_path.write_bytes(image)
            response_payload = chat_router.DownloadedRemoteMedia(
                path=artifact_path,
                mime_type="image/jpeg",
                size=len(image),
            )
            safe_fetch = AsyncMock(return_value=response_payload)

            with patch.object(chat_router, "fetch_external_whatsapp_media", safe_fetch):
                response = await chat_router.obter_midia_whatsapp(
                    message_id,
                    conversa_id="status@broadcast",
                    user=chat_user(),
                )

            self.assertFalse(artifact_path.exists())

        self.assertEqual(image, response.body)
        safe_fetch.assert_awaited_once_with(
            "https://cdn.w-api.app/media/status.jpeg",
            connect_timeout=5.0,
            read_timeout=60.0,
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

    async def test_groups_default_returns_local_snapshot_without_waiting_for_provider(self) -> None:
        group_id = "120363000000000777@g.us"
        group = new_conversation(
            group_id,
            contato="Grupo local",
            channel="whatsapp",
            is_group=True,
        )
        group["timestampUltimaMsg"] = int(time.time())
        await save_conversations({group_id: group}, "user-a")
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "catalogSyncedAt": time.time(),
                "contactsSyncedAt": time.time(),
            },
        )
        provider = AsyncMock()
        with patch.object(chat_router.wapi_client, "get_all_groups", provider):
            result = await chat_router.listar_grupos(chat_user())

        provider.assert_not_awaited()
        self.assertEqual([group_id], [item["id"] for item in result["items"]])
        self.assertEqual("Grupo local", result["items"][0]["contato"])

    async def test_groups_list_returns_chat_conversations(self) -> None:
        payload = {
            "groups": [
                {
                    "id": "120363000000000000@g.us",
                    "subject": "Familia",
                    "description": "Grupo da familia",
                    "profilePicUrl": "https://cdn.example/group-photo.jpg",
                    "participants": [{"id": "5511999999999"}],
                }
            ]
        }
        with patch.object(chat_router.wapi_client, "get_all_groups", AsyncMock(return_value=payload)):
            result = await chat_router.listar_grupos(chat_user(), live=True)
        group = result["items"][0]
        self.assertEqual("120363000000000000@g.us", group["id"])
        self.assertEqual("Familia", group["contato"])
        self.assertTrue(group["esGrupo"])
        self.assertEqual("Grupo da familia", group["metadados"]["descricaoGrupo"])
        self.assertEqual("https://cdn.example/group-photo.jpg", group["photoUrl"])
        self.assertEqual("https://cdn.example/group-photo.jpg", group["metadados"]["photoUrl"])

    async def test_groups_list_uses_cached_photo_when_live_payload_omits_it(self) -> None:
        group_id = "120363000000000099@g.us"
        photo_url = "https://cdn.example/group-photo-from-cache.jpg"
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": time.time(),
                "chats": [
                    {
                        "id": group_id,
                        "subject": "Grupo em cache",
                        "imgUrl": photo_url,
                    }
                ],
            },
        )
        payload = {
            "groups": [
                {
                    "id": group_id,
                    "subject": "Grupo em cache",
                    "participants": [],
                }
            ]
        }

        with patch.object(chat_router.wapi_client, "get_all_groups", AsyncMock(return_value=payload)):
            result = await chat_router.listar_grupos(chat_user(), live=True)

        self.assertEqual(photo_url, result["items"][0].get("photoUrl"))
        self.assertEqual(photo_url, result["items"][0]["metadados"].get("photoUrl"))

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
