from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.conversation_store import load_conversations, new_conversation, save_conversations
from app.services.wapi_client import WapiConfig, WapiError
from app.services.wapi_connect import WapiConnectService


def chat_user(user_id: str = "user-runtime") -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class WapiRuntimeSyncRegressionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        data_dir = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": data_dir}, clear=False))
        wb.save_binding(
            "user-runtime",
            wb.InstanceBinding(instance_id="INST-RUNTIME", token="tok-runtime", state="connected"),
        )
        chat_router.whatsapp_contact_sync_states.clear()
        chat_router.whatsapp_contact_sync_tasks.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()

    def tearDown(self) -> None:
        for task in chat_router.whatsapp_contact_sync_tasks.values():
            task.cancel()
        chat_router.whatsapp_contact_sync_tasks.clear()
        chat_router.whatsapp_contact_sync_states.clear()
        chat_router.whatsapp_conversation_mutation_locks.clear()
        self.stack.close()

    def test_catalog_accepts_msgcontent_and_text_but_keeps_existing_on_empty_stub(self) -> None:
        conversation = new_conversation("5511999990000", contato="Maria", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "EMPTY-STUB",
                "texto": "mensagem já carregada",
                "timestamp": 1_700_000_001,
                "remetente": "contato",
                "tipo": "texto",
                "canal": "whatsapp",
                "channel": "whatsapp",
            }
        ]
        changed = chat_router.sync_catalog_messages(
            conversation,
            {
                "id": "5511999990000@s.whatsapp.net",
                "messages": [
                    {
                        "messageId": "MSG-CONTENT",
                        "moment": 1_700_000_002,
                        "fromMe": "false",
                        "msgContent": {"conversation": "recebida pelo catálogo"},
                    },
                    {
                        "messageId": "MSG-TEXT",
                        "moment": 1_700_000_003,
                        "fromMe": True,
                        "text": "enviada pelo celular",
                    },
                    {
                        "messageId": "EMPTY-STUB",
                        "moment": 1_700_000_004,
                        "fromMe": False,
                        "msgContent": {"protocolMessage": {"type": "HISTORY_SYNC"}},
                    },
                ],
            },
        )

        self.assertTrue(changed)
        by_id = {message["id"]: message for message in conversation["mensagens"]}
        self.assertEqual("mensagem já carregada", by_id["EMPTY-STUB"]["texto"])
        self.assertEqual("contato", by_id["MSG-CONTENT"]["remetente"])
        self.assertEqual("usuario", by_id["MSG-TEXT"]["remetente"])
        self.assertNotIn("", [message["texto"] for message in conversation["mensagens"]])

    def test_catalog_accepts_last_messages_as_minimum_preconnection_history(self) -> None:
        conversation = new_conversation(
            "5511999990000@s.whatsapp.net",
            contato="Maria",
            channel="whatsapp",
        )

        changed = chat_router.sync_catalog_messages(
            conversation,
            {
                "id": "5511999990000@s.whatsapp.net",
                "lastMessages": [
                    {
                        "messageId": "CATALOG-PRECONNECTION",
                        "moment": 1_699_999_900,
                        "fromMe": False,
                        "msgContent": {"conversation": "mensagem anterior via catálogo"},
                    }
                ],
            },
        )

        self.assertTrue(changed)
        self.assertEqual(
            ["CATALOG-PRECONNECTION"],
            [message["id"] for message in conversation["mensagens"]],
        )

    def test_sparse_last_message_does_not_downgrade_rich_existing_state(self) -> None:
        conversation = new_conversation("5511999990000@s.whatsapp.net", contato="Maria", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "READ-MESSAGE",
                "texto": "mensagem confirmada",
                "timestamp": 1_700_000_010,
                "remetente": "usuario",
                "tipo": "midia",
                "arquivoUrl": "/api/chat/midia/READ-MESSAGE",
                "status": "lido",
                "reacoes": [{"emoji": "❤️", "count": 1, "fromMe": True}],
                "citada": {"id": "quoted", "content": "contexto"},
                "midiaMeta": {"mediaKey": "key", "directPath": "/media", "type": "image"},
                "canal": "whatsapp",
                "channel": "whatsapp",
            }
        ]

        chat_router.sync_catalog_messages(
            conversation,
            {
                "id": "5511999990000@s.whatsapp.net",
                "lastMessage": {
                    "messageId": "READ-MESSAGE",
                    "moment": 1_700_000_010,
                    "fromMe": True,
                    "msgContent": {"conversation": "mensagem confirmada"},
                },
            },
        )

        stored = conversation["mensagens"][0]
        self.assertEqual("lido", stored["status"])
        self.assertEqual([{"emoji": "❤️", "count": 1, "fromMe": True, "senders": []}], stored["reacoes"])
        self.assertEqual({"id": "quoted", "content": "contexto"}, stored["citada"])
        self.assertEqual(
            {"mediaKey": "key", "directPath": "/media", "type": "image"},
            stored["midiaMeta"],
        )
        self.assertEqual("/api/chat/midia/READ-MESSAGE", stored["arquivoUrl"])

    async def test_pro_contacts_failure_uses_chats_and_cache_as_partial(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contacts": [
                    {"id": "5511999990000@s.whatsapp.net", "savedName": "Maria da agenda"}
                ],
                "chats": [],
            },
        )
        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(side_effect=WapiError("Acesso negado", status=403)),
            ),
            patch.object(
                chat_router,
                "fetch_all_wapi_chats",
                AsyncMock(
                    return_value=[
                        {
                            "id": "5511999990000@s.whatsapp.net",
                            "notify": "Maria",
                            "lastMessage": {
                                "messageId": "PHONE-SENT",
                                "moment": 1_700_000_005,
                                "fromMe": True,
                                "msgContent": {"conversation": "mensagem enviada"},
                            },
                        }
                    ]
                ),
            ),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("partial", result["status"])
        self.assertEqual(99, result["progress"])
        self.assertTrue(result["partial"])
        self.assertIn("contatos em cache/chats", result["warnings"])
        self.assertTrue(result["requiresPro"])
        self.assertTrue(result["reconnectRequired"])
        stored = await load_conversations("user-runtime")
        self.assertEqual("Maria da agenda", stored["5511999990000@s.whatsapp.net"]["contato"])
        self.assertEqual("usuario", stored["5511999990000@s.whatsapp.net"]["mensagens"][0]["remetente"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertEqual("Maria da agenda", cache["contacts"][0]["savedName"])
        self.assertTrue(cache["catalogPartial"])
        self.assertIn("contatos em cache/chats", cache["catalogWarnings"])
        self.assertGreater(float(cache["contactSyncAttemptedAt"]), 0)

    async def test_contact_sync_rehydrates_group_sender_from_saved_contact(self) -> None:
        group_id = "120363000000000000@g.us"
        sender_id = "5511999990000@s.whatsapp.net"
        conversation = new_conversation(
            group_id,
            contato="Equipe",
            channel="whatsapp",
            is_group=True,
        )
        conversation["mensagens"] = [
            {
                "id": "GROUP-HISTORY-1",
                "remetente": "contato",
                "remetenteId": sender_id,
                "remetenteNome": "Maria do perfil",
                "timestamp": 1_700_000_005,
            }
        ]
        conversation["ultimoRemetenteNome"] = "Maria do perfil"
        conversation["timestampUltimaMsg"] = 1_700_000_005
        await save_conversations({group_id: conversation}, "user-runtime")

        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(
                    return_value=[
                        {
                            "id": sender_id,
                            "savedName": "Maria da agenda",
                        }
                    ]
                ),
            ),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("complete", result["status"])
        stored = await load_conversations("user-runtime")
        group = stored[group_id]
        self.assertEqual("Maria da agenda", group["mensagens"][0]["remetenteNome"])
        self.assertEqual("Maria da agenda", group["ultimoRemetenteNome"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertEqual("Maria da agenda", cache["savedContactNames"][sender_id])

    async def test_contact_sync_rehydrates_message_arriving_during_catalog_publication(self) -> None:
        group_id = "120363000000000001@g.us"
        sender_id = "5511999990001@s.whatsapp.net"
        original_save_catalog = chat_router.save_whatsapp_catalog_cache
        injected = False

        async def save_catalog_with_waiting_message(user_id: str, payload: dict) -> None:
            nonlocal injected
            await original_save_catalog(user_id, payload)
            if injected or not payload.get("contactsSyncedAt"):
                return
            injected = True
            db = await load_conversations(user_id)
            conversation = new_conversation(
                group_id,
                contato="Equipe concorrente",
                channel="whatsapp",
                is_group=True,
            )
            conversation["mensagens"] = [
                {
                    "id": "GROUP-RACE-1",
                    "remetente": "contato",
                    "remetenteId": sender_id,
                    "remetenteNome": "Maria do perfil",
                    "timestamp": 1_700_000_006,
                }
            ]
            conversation["ultimoRemetenteNome"] = "Maria do perfil"
            conversation["timestampUltimaMsg"] = 1_700_000_006
            db[group_id] = conversation
            await save_conversations(db, user_id)

        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(
                    return_value=[
                        {
                            "id": sender_id,
                            "savedName": "Maria da agenda",
                        }
                    ]
                ),
            ),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
            patch.object(
                chat_router,
                "save_whatsapp_catalog_cache",
                AsyncMock(side_effect=save_catalog_with_waiting_message),
            ),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("complete", result["status"])
        stored = (await load_conversations("user-runtime"))[group_id]
        self.assertEqual("Maria da agenda", stored["mensagens"][0]["remetenteNome"])
        self.assertEqual("Maria da agenda", stored["ultimoRemetenteNome"])

    async def test_history_loads_messages_from_provider_chat_created_before_connection(self) -> None:
        conversation_id = "5511999990000@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Maria", channel="whatsapp")
        await save_conversations({conversation_id: conversation}, "user-runtime")
        provider_history = AsyncMock(
            return_value={
                "chat": {
                    "id": conversation_id,
                    "messages": [
                        {
                            "messageId": "HISTORY-BEFORE-CONNECTION",
                            "moment": 1_699_999_999,
                            "fromMe": False,
                            "msgContent": {
                                "conversation": "mensagem anterior à conexão da instância"
                            },
                        }
                    ],
                }
            }
        )

        with patch.object(chat_router.wapi_client, "fetch_chat", provider_history):
            page = await chat_router.obter_historico_conversa(
                conversation_id,
                before=None,
                limit=50,
                user=chat_user(),
            )

        self.assertEqual(
            ["HISTORY-BEFORE-CONNECTION"],
            [message["id"] for message in page["items"]],
        )
        provider_history.assert_awaited_once_with(
            "INST-RUNTIME",
            "tok-runtime",
            conversation_id,
        )

    async def test_group_history_uses_saved_contact_name(self) -> None:
        group_id = "120363000000000000@g.us"
        sender_id = "5511999990000@s.whatsapp.net"
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "contacts": [
                    {
                        "id": sender_id,
                        "savedName": "Maria da agenda",
                    }
                ],
                "chats": [],
            },
        )
        conversation = new_conversation(
            group_id,
            contato="Equipe",
            channel="whatsapp",
            is_group=True,
        )
        await save_conversations({group_id: conversation}, "user-runtime")
        provider_history = AsyncMock(
            return_value={
                "chat": {
                    "id": group_id,
                    "messages": [
                        {
                            "messageId": "GROUP-HISTORY-NAME",
                            "moment": 1_699_999_999,
                            "fromMe": False,
                            "sender": {
                                "id": sender_id,
                                "pushName": "Maria do perfil",
                            },
                            "msgContent": {"conversation": "mensagem antiga"},
                        }
                    ],
                }
            }
        )

        with patch.object(chat_router.wapi_client, "fetch_chat", provider_history):
            page = await chat_router.obter_historico_conversa(
                group_id,
                before=None,
                limit=50,
                user=chat_user(),
            )

        self.assertEqual("Maria da agenda", page["items"][0]["remetenteNome"])
        stored = (await load_conversations("user-runtime"))[group_id]
        self.assertEqual("Maria da agenda", stored["mensagens"][0]["remetenteNome"])

    async def test_metadata_only_history_response_is_cached_without_repeated_calls(self) -> None:
        conversation_id = "5511888880000@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Sem histórico", channel="whatsapp")
        await save_conversations({conversation_id: conversation}, "user-runtime")
        metadata_only = AsyncMock(
            return_value={
                "data": {
                    "chat": {
                        "id": conversation_id,
                        "name": "Sem histórico",
                    }
                }
            }
        )

        with patch.object(chat_router.wapi_client, "fetch_chat", metadata_only):
            first = await chat_router.obter_historico_conversa(
                conversation_id,
                before=None,
                limit=50,
                user=chat_user(),
            )
            second = await chat_router.obter_historico_conversa(
                conversation_id,
                before=None,
                limit=50,
                user=chat_user(),
            )

        self.assertEqual([], first["items"])
        self.assertEqual([], second["items"])
        metadata_only.assert_awaited_once_with(
            "INST-RUNTIME",
            "tok-runtime",
            conversation_id,
        )
        stored = await load_conversations("user-runtime")
        self.assertEqual(
            chat_router.WHATSAPP_HISTORY_SCHEMA_VERSION,
            stored[conversation_id]["metadados"]["historicoSchema"],
        )
        self.assertGreater(
            float(stored[conversation_id]["metadados"]["historicoSincronizadoEm"]),
            0,
        )

    async def test_history_deduplicates_and_pages_persisted_provider_messages(self) -> None:
        conversation_id = "5511777770000@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Histórico", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "HISTORY-2",
                "texto": "cópia local",
                "timestamp": 1_700_000_002,
                "remetente": "contato",
                "tipo": "texto",
                "canal": "whatsapp",
                "channel": "whatsapp",
            }
        ]
        await save_conversations({conversation_id: conversation}, "user-runtime")
        provider_history = AsyncMock(
            return_value={
                "chat": {
                    "id": conversation_id,
                    "messages": [
                        {
                            "messageId": f"HISTORY-{index}",
                            "moment": 1_700_000_000 + index,
                            "fromMe": False,
                            "msgContent": {"conversation": f"mensagem {index}"},
                        }
                        for index in range(1, 5)
                    ],
                }
            }
        )

        with patch.object(chat_router.wapi_client, "fetch_chat", provider_history):
            recent = await chat_router.obter_historico_conversa(
                conversation_id,
                before=None,
                limit=2,
                user=chat_user(),
            )
            older = await chat_router.obter_historico_conversa(
                conversation_id,
                before=recent["cursor"],
                limit=2,
                user=chat_user(),
            )

        self.assertEqual(["HISTORY-3", "HISTORY-4"], [item["id"] for item in recent["items"]])
        self.assertTrue(recent["hasMore"])
        self.assertEqual(["HISTORY-1", "HISTORY-2"], [item["id"] for item in older["items"]])
        self.assertFalse(older["hasMore"])
        provider_history.assert_awaited_once()
        stored = await load_conversations("user-runtime")
        ids = [item["id"] for item in stored[conversation_id]["mensagens"]]
        self.assertEqual(["HISTORY-1", "HISTORY-2", "HISTORY-3", "HISTORY-4"], ids)

    def test_history_record_ignores_other_chat_and_routes_alias_to_requested_id(self) -> None:
        requested_id = "5511777770000@s.whatsapp.net"
        selected = chat_router.whatsapp_history_chat_record(
            {
                "data": [
                    {
                        "id": "5511666660000@s.whatsapp.net",
                        "messages": [{"messageId": "WRONG-CHAT"}],
                    },
                    {
                        "id": "5511777770000",
                        "messages": [{"messageId": "RIGHT-CHAT"}],
                    },
                ]
            },
            requested_id,
        )

        self.assertEqual(requested_id, chat_router._contact_primary_id(selected))
        self.assertEqual(
            ["RIGHT-CHAT"],
            [message["messageId"] for message in selected["messages"]],
        )

    async def test_history_discards_provider_payload_after_disconnect(self) -> None:
        conversation_id = "5511555550000@s.whatsapp.net"
        original_binding = wb.get_binding("user-runtime")
        await save_conversations(
            {
                conversation_id: new_conversation(
                    conversation_id,
                    contato="Histórico em voo",
                    channel="whatsapp",
                )
            },
            "user-runtime",
        )
        fetch_started = asyncio.Event()
        release_fetch = asyncio.Event()

        async def delayed_history(*_args):
            fetch_started.set()
            await release_fetch.wait()
            return {
                "chat": {
                    "id": conversation_id,
                    "messages": [
                        {
                            "messageId": "STALE-HISTORY",
                            "moment": 1_700_000_100,
                            "fromMe": False,
                            "msgContent": {"conversation": "não deve reaparecer"},
                        }
                    ],
                }
            }

        with patch.object(
            chat_router.wapi_client,
            "fetch_chat",
            AsyncMock(side_effect=delayed_history),
        ):
            history_task = asyncio.create_task(
                chat_router.obter_historico_conversa(
                    conversation_id,
                    before=None,
                    limit=50,
                    user=chat_user(),
                )
            )
            await asyncio.wait_for(fetch_started.wait(), timeout=1)
            await chat_router.desconectar_whatsapp(user=chat_user())
            wb.save_binding(
                "user-runtime",
                wb.InstanceBinding(
                    instance_id=original_binding.instance_id,
                    token=original_binding.token,
                    state="connected",
                    created_at=original_binding.created_at + 1,
                ),
            )
            release_fetch.set()
            page = await asyncio.wait_for(history_task, timeout=1)

        self.assertEqual([], page["items"])
        self.assertEqual({}, await load_conversations("user-runtime"))

    async def test_history_error_backoff_coalesces_concurrent_failures_without_marking_complete(self) -> None:
        conversation_id = "5511444440000@s.whatsapp.net"
        await save_conversations(
            {
                conversation_id: new_conversation(
                    conversation_id,
                    contato="Sem endpoint de histórico",
                    channel="whatsapp",
                )
            },
            "user-runtime",
        )
        provider = AsyncMock(side_effect=WapiError("Acesso negado", status=403))

        with patch.object(chat_router.wapi_client, "fetch_chat", provider):
            first, second = await asyncio.gather(
                chat_router.obter_historico_conversa(
                    conversation_id,
                    before=None,
                    limit=50,
                    user=chat_user(),
                ),
                chat_router.obter_historico_conversa(
                    conversation_id,
                    before=None,
                    limit=50,
                    user=chat_user(),
                ),
            )

        self.assertEqual([], first["items"])
        self.assertEqual([], second["items"])
        provider.assert_awaited_once()
        stored = await load_conversations("user-runtime")
        self.assertIsNone(
            stored[conversation_id]["metadados"].get("historicoSincronizadoEm")
        )

    async def test_catalog_status_alias_is_saved_to_feed_not_conversations_or_cache(self) -> None:
        now = int(time.time())
        with (
            patch.object(chat_router, "fetch_all_wapi_contacts", AsyncMock(return_value=[])),
            patch.object(
                chat_router,
                "fetch_all_wapi_chats",
                AsyncMock(
                    return_value=[
                        {
                            "id": "status",
                            "messages": [
                                {
                                    "messageId": "CATALOG-STATUS-1",
                                    "moment": now,
                                    "sender": {"id": "5511666665555"},
                                    "msgContent": {
                                        "imageMessage": {
                                            "caption": "status pelo catálogo",
                                            "mimetype": "image/jpeg",
                                            "mediaKey": "catalog-key",
                                            "directPath": "/catalog/status",
                                        }
                                    },
                                }
                            ],
                        },
                        {
                            "id": "5511666665555@s.whatsapp.net",
                            "notify": "Bia",
                        },
                        {
                            "id": "5511999990000@s.whatsapp.net",
                            "notify": "Contato normal",
                        },
                    ]
                ),
            ),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("complete", result["status"])
        conversations = await load_conversations("user-runtime")
        self.assertNotIn("status", conversations)
        self.assertIn("5511999990000@s.whatsapp.net", conversations)
        feed = await chat_router.load_whatsapp_status_feed("user-runtime")
        stored = next(item for item in feed["items"] if item["id"] == "CATALOG-STATUS-1")
        self.assertEqual("Bia", stored["contactName"])
        self.assertEqual("status pelo catálogo", stored["texto"])
        self.assertIn("/api/chat/midia/", stored["arquivoUrl"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertNotIn("status", {str(item.get("id") or "") for item in cache["chats"]})

    async def test_contact_sync_enriches_existing_status_without_new_status_payload(self) -> None:
        now = int(time.time())
        await chat_router.save_whatsapp_status_feed(
            "user-runtime",
            {
                "items": [
                    {
                        "id": "STATUS-BEFORE-CONTACTS",
                        "contactId": "5511666665555",
                        "contactName": "5511666665555",
                        "timestamp": now,
                        "texto": "chegou antes do catálogo",
                        "tipo": "texto",
                        "visualizado": False,
                    }
                ]
            },
        )

        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(
                    return_value=[
                        {
                            "id": "5511666665555@s.whatsapp.net",
                            "notify": "Bia da agenda",
                            "profilePictureUrl": "https://cdn.example/bia.jpg",
                        }
                    ]
                ),
            ),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("complete", result["status"])
        feed = await chat_router.load_whatsapp_status_feed("user-runtime")
        stored = next(item for item in feed["items"] if item["id"] == "STATUS-BEFORE-CONTACTS")
        self.assertEqual("Bia da agenda", stored["contactName"])
        self.assertEqual("https://cdn.example/bia.jpg", stored["photoUrl"])

    async def test_legacy_status_conversation_migrates_before_removal_without_name_false_positive(self) -> None:
        now = int(time.time())
        technical = new_conversation("status", contato="T", channel="whatsapp")
        technical["lida"] = False
        technical["mensagens"] = [
            {
                "id": "LEGACY-STATUS-1",
                "remetente": "contato",
                "remetenteId": "5511555554444",
                "remetenteNome": "Tarcísia",
                "texto": "legado preservado",
                "tipo": "midia",
                "arquivoUrl": "/api/chat/midia/LEGACY-STATUS-1?conversa_id=status",
                "arquivoMime": "image/jpeg",
                "midiaMeta": {
                    "mediaKey": "legacy-key",
                    "directPath": "/legacy/status",
                    "type": "image",
                    "mimetype": "image/jpeg",
                },
                "timestamp": now,
                "horario": "15:00",
                "canal": "whatsapp",
                "channel": "whatsapp",
            }
        ]
        human = new_conversation(
            "5511444443333@s.whatsapp.net",
            contato="Status",
            channel="whatsapp",
        )
        human["timestampUltimaMsg"] = now
        human["horario"] = "15:01"
        await save_conversations(
            {"status": technical, "5511444443333@s.whatsapp.net": human},
            "user-runtime",
        )
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "authenticatedAt": time.time(),
                "catalogSyncedAt": time.time(),
                "contactsSyncedAt": time.time(),
                "contacts": [],
                "chats": [],
            },
        )

        with patch.object(
            chat_router.wapi_connect,
            "status",
            AsyncMock(return_value={"status": "conectado"}),
        ):
            conversations = await chat_router.obter_conversas(
                since=None,
                limit=100,
                refresh=False,
                user=chat_user(),
            )

        self.assertNotIn("status", {item["id"] for item in conversations})
        self.assertIn("5511444443333@s.whatsapp.net", {item["id"] for item in conversations})
        stored_db = await load_conversations("user-runtime")
        self.assertNotIn("status", stored_db)
        self.assertEqual("Status", stored_db["5511444443333@s.whatsapp.net"]["contato"])
        feed = await chat_router.load_whatsapp_status_feed("user-runtime")
        migrated = next(item for item in feed["items"] if item["id"] == "LEGACY-STATUS-1")
        self.assertEqual("Tarcísia", migrated["contactName"])
        self.assertEqual("5511555554444", migrated["contactId"])
        self.assertEqual("legado preservado", migrated["texto"])
        self.assertEqual("/api/chat/midia/LEGACY-STATUS-1?conversa_id=status", migrated["arquivoUrl"])
        self.assertEqual("image/jpeg", migrated["arquivoMime"])
        self.assertFalse(migrated["visualizado"])

    async def test_conversation_delta_never_waits_for_remote_connection_status(self) -> None:
        now = int(time.time())
        conversation_id = "5511333332222@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Contato delta", channel="whatsapp")
        conversation["timestampUltimaMsg"] = now
        conversation["horario"] = "15:10"
        await save_conversations({conversation_id: conversation}, "user-runtime")
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "conversationUpdates": {conversation_id: now},
            },
        )
        remote_status = AsyncMock(side_effect=AssertionError("delta abriu consulta remota"))

        with patch.object(chat_router.wapi_connect, "status", remote_status):
            result = await chat_router.obter_conversas(
                since=now - 1,
                limit=100,
                refresh=False,
                user=chat_user(),
            )

        self.assertEqual([conversation_id], [item["id"] for item in result["items"]])
        self.assertEqual(now, result["cursor"])
        remote_status.assert_not_awaited()

    async def test_whole_chat_catalog_failure_is_partial_and_preserves_cache(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "catalogSyncedAt": 123.0,
                "contacts": [],
                "chats": [{"id": "5511888880000@s.whatsapp.net", "notify": "Chat em cache"}],
            },
        )
        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(return_value=[{"id": "5511999990000@s.whatsapp.net", "savedName": "Contato novo"}]),
            ),
            patch.object(
                chat_router,
                "fetch_all_wapi_chats",
                AsyncMock(side_effect=WapiError("chats indisponiveis", status=503)),
            ),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("partial", result["status"])
        self.assertIn("conversas em cache", result["warnings"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertTrue(cache["catalogPartial"])
        self.assertEqual(123.0, cache["catalogSyncedAt"])
        self.assertEqual("Chat em cache", cache["chats"][0]["notify"])
        self.assertIn("conversas em cache", cache["catalogWarnings"])

    async def test_sync_preserves_conversation_update_written_during_remote_fetch(self) -> None:
        async def contacts_with_webhook_update(_user_id: str):
            await chat_router.mark_whatsapp_conversation_updated(
                "user-runtime", "5511777770000@s.whatsapp.net"
            )
            return []

        with (
            patch.object(
                chat_router,
                "fetch_all_wapi_contacts",
                AsyncMock(side_effect=contacts_with_webhook_update),
            ),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("complete", result["status"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertIn(
            "5511777770000@s.whatsapp.net",
            cache.get("conversationUpdates", {}),
        )

    async def test_intermediate_page_failure_is_partial_and_preserves_cached_contact(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": 123.0,
                "contacts": [
                    {"id": "5511999990002@s.whatsapp.net", "savedName": "Contato em cache"}
                ],
                "chats": [],
            },
        )

        async def fetch_contacts(_instance: str, _token: str, **params):
            page = params["page"]
            if page == 2:
                raise WapiError("pagina indisponivel", status=503)
            suffix = "1" if page == 1 else "3"
            return {
                "contacts": [
                    {
                        "id": f"551199999000{suffix}@s.whatsapp.net",
                        "savedName": f"Contato {suffix}",
                    }
                ],
                "totalPages": 3,
            }

        with (
            patch.object(chat_router.wapi_client, "fetch_contacts", AsyncMock(side_effect=fetch_contacts)),
            patch.object(chat_router, "fetch_all_wapi_chats", AsyncMock(return_value=[])),
        ):
            result = await chat_router._run_contact_sync("user-runtime")

        self.assertEqual("partial", result["status"])
        self.assertEqual(99, result["progress"])
        self.assertTrue(result["partial"])
        self.assertIn("paginas de contatos indisponiveis: 2", result["warnings"])
        cache = await chat_router.load_whatsapp_catalog_cache("user-runtime")
        self.assertTrue(cache["catalogPartial"])
        self.assertEqual(123.0, cache["contactsSyncedAt"])
        self.assertEqual(
            {
                "5511999990001@s.whatsapp.net",
                "5511999990002@s.whatsapp.net",
                "5511999990003@s.whatsapp.net",
            },
            {contact["id"] for contact in cache["contacts"]},
        )

    async def test_contact_picker_merges_cached_chats_and_local_named_conversations(self) -> None:
        now = time.time()
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": now,
                "contacts": [],
                "chats": [
                    {
                        "id": "5511999990000@s.whatsapp.net",
                        "savedName": "Maria da agenda",
                        "lid": "12345@lid",
                    }
                ],
            },
        )
        local = new_conversation("5511888880000@s.whatsapp.net", contato="João local", channel="whatsapp")
        await save_conversations({local["id"]: local}, "user-runtime")

        with patch.object(chat_router, "schedule_contact_sync") as schedule:
            contacts = await chat_router.obter_contatos_disponiveis(user=chat_user())

        by_name = {contact["name"]: contact for contact in contacts}
        self.assertIn("Maria da agenda", by_name)
        self.assertIn("João local", by_name)
        self.assertIn("5511999990000@s.whatsapp.net", by_name["Maria da agenda"]["aliases"])
        self.assertEqual("12345@lid", by_name["Maria da agenda"]["lid"])
        self.assertEqual("Maria da agenda", by_name["Maria da agenda"]["savedName"])
        schedule.assert_not_called()

    async def test_non_contact_notify_is_not_exposed_as_saved_contact_name(self) -> None:
        now = time.time()
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": now,
                "contacts": [
                    {
                        "id": "5511999990000@s.whatsapp.net",
                        "notify": "Nome escolhido no perfil",
                        "isMyContact": False,
                    }
                ],
                "chats": [],
            },
        )

        with patch.object(chat_router, "schedule_contact_sync") as schedule:
            contacts = await chat_router.obter_contatos_disponiveis(user=chat_user())

        contact = next(item for item in contacts if item["id"] == "5511999990000@s.whatsapp.net")
        self.assertIsNone(contact["savedName"])
        schedule.assert_not_called()

    async def test_status_polling_respects_contact_sync_retry_window(self) -> None:
        await chat_router.save_whatsapp_catalog_cache(
            "user-runtime",
            {
                "schemaVersion": chat_router.WHATSAPP_CATALOG_SCHEMA_VERSION,
                "contactsSyncedAt": 0,
                "contactSyncAttemptedAt": time.time(),
                "contacts": [],
                "chats": [{"id": "5511999990000@s.whatsapp.net", "notify": "Maria"}],
            },
        )
        with (
            patch.object(chat_router.wapi_connect, "status", AsyncMock(return_value={"status": "conectado"})),
            patch.object(chat_router, "schedule_contact_sync") as schedule,
        ):
            await chat_router.obter_status_canais(user=chat_user())
            await chat_router.obter_status_canais(user=chat_user())
        schedule.assert_not_called()

    async def test_pro_reconnect_does_not_reuse_declared_lite_instance(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.list_instances.return_value = {
            "instances": [
                {
                    "instanceName": "norium-new-user",
                    "instanceId": "OLD-LITE",
                    "token": "old-token",
                    "lite": True,
                }
            ]
        }
        client.create_instance.return_value = {"instanceId": "NEW-PRO", "token": "new-token"}
        service = WapiConnectService(client=client)

        with patch.dict(os.environ, {"WAPI_INSTANCE_LITE": "false"}, clear=False):
            binding = await service.ensure_instance("new-user")

        self.assertEqual("NEW-PRO", binding.instance_id)
        self.assertEqual("norium-new-user-pro", client.create_instance.await_args.kwargs["instance_name"])
        self.assertFalse(client.create_instance.await_args.kwargs["lite"])


if __name__ == "__main__":
    unittest.main()
