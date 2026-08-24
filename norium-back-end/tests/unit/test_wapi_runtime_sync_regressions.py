from __future__ import annotations

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
