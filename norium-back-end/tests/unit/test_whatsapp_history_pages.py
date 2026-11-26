import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.services.evolution_client import EvolutionClient, normalize_webhook
from app.services.wapi_client import WapiError
from app.modules.chat import router
from app.modules.chat.history import backfill_older, binding_signature


REMOTE = "5511999990000@s.whatsapp.net"


class HistoryBoundaryTests(unittest.TestCase):
    def test_same_second_uses_id_boundary_without_losing_messages(self):
        conversation = {"mensagens": [{"id": str(index), "timestamp": 100} for index in range(6)]}
        with patch.object(router, "is_evolution", return_value=False):
            first = router.whatsapp_history_page(conversation, before=None, limit=2)
            second = router.whatsapp_history_page(conversation, before=first["cursor"], before_id=first["cursorId"], limit=2)
            third = router.whatsapp_history_page(conversation, before=second["cursor"], before_id=second["cursorId"], limit=2)
        self.assertEqual(["4", "5"], [row["id"] for row in first["items"]])
        self.assertEqual(["2", "3"], [row["id"] for row in second["items"]])
        self.assertEqual(["0", "1"], [row["id"] for row in third["items"]])
        self.assertFalse(third["hasMore"])

    def test_legacy_timestamp_cursor_remains_exclusive(self):
        with patch.object(router, "is_evolution", return_value=False):
            page = router.whatsapp_history_page({"mensagens": [{"id": "a", "timestamp": 99}, {"id": "b", "timestamp": 100}]}, before=100, limit=2)
        self.assertEqual(["a"], [row["id"] for row in page["items"]])

    def test_unavailable_remote_page_keeps_cursor_for_retry(self):
        with patch.object(router, "is_evolution", return_value=True):
            page = router.whatsapp_history_page({"mensagens": [], "metadados": {"historicoTemMais": True}},
                                                 before=100, before_id="last", limit=50)
        self.assertTrue(page["hasMore"])
        self.assertEqual((100, "last"), (page["cursor"], page["cursorId"]))


class EvolutionHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ, {"EVOLUTION_BASE_URL": "http://evolution-api:8080", "EVOLUTION_PRIVATE_NETWORK_ENABLED": "1"}):
            self.client = EvolutionClient()

    async def test_page_is_scoped_bounded_and_has_stable_upper_date(self):
        records = [{"key": {"id": "owned", "remoteJid": REMOTE}, "messageTimestamp": 100},
                   {"key": {"id": "foreign", "remoteJid": "123@g.us"}, "messageTimestamp": 90}]
        self.client._call = AsyncMock(return_value={"messages": {"records": records, "pages": 3}})
        page = await self.client.fetch_history_page("synthetic-instance", "synthetic-token", REMOTE, page=2, until=1000)
        body = self.client._call.call_args.kwargs["body"]
        self.assertEqual(2, body["page"])
        self.assertEqual(100, body["offset"])
        self.assertEqual({"remoteJid": REMOTE, "remoteJidAlt": REMOTE}, body["where"]["key"])
        self.assertIn("lte", body["where"]["messageTimestamp"])
        self.assertEqual(["owned"], [row["key"]["id"] for row in page["messages"]])
        self.assertTrue(page["hasMore"])
        self.assertEqual(1000, page["anchor"])

    async def test_invalid_page_never_calls_provider(self):
        self.client._call = AsyncMock()
        for page in (0, True, 10001):
            with self.assertRaises(WapiError):
                await self.client.fetch_history_page("synthetic-instance", "synthetic-token", REMOTE, page=page)
        self.client._call.assert_not_awaited()

    async def test_full_history_is_requested_for_new_instance(self):
        self.client._call = AsyncMock(return_value={"instance": {"instanceName": "synthetic-instance", "instanceId": "synthetic-id"}})
        with patch("app.services.evolution_client.webhook_url", return_value="http://app:8000/api/whatsapp/webhook"):
            await self.client.create_instance("synthetic-instance")
        self.assertTrue(self.client._call.call_args.kwargs["body"]["syncFullHistory"])

    def test_history_webhook_never_replays_old_messages_as_new_actions(self):
        result = normalize_webhook({"event": "MESSAGES_SET", "instance": "synthetic-instance", "data": [{"message": {"conversation": "synthetic private history"}}]})
        self.assertEqual({"instanceId": "synthetic-instance", "event": "history_ready"}, result)

    async def test_existing_subscription_is_upgraded_even_when_metadata_is_fresh(self):
        import time
        cache = {"evolutionMetadataVersion": 1, "evolutionWebhookVersion": 1, "evolutionMetadataSyncedAt": time.time()}
        with patch.object(router, "is_evolution", return_value=True), patch.object(router, "wapi_creds", return_value=("synthetic", "token")), \
             patch.object(router.wapi_client, "set_webhook", AsyncMock()) as hook, \
             patch.object(router.wapi_client, "get_all_groups", AsyncMock(return_value=[])), \
             patch.object(router.wapi_client, "device", AsyncMock(return_value={"name": "Synthetic", "connectedPhone": "5511999990000"})), \
             patch.object(router, "load_whatsapp_catalog_cache", AsyncMock(return_value=cache)), \
             patch.object(router, "save_whatsapp_catalog_cache", AsyncMock()), \
             patch("app.services.evolution_client.webhook_url", return_value="http://app:8000/api/whatsapp/webhook"):
            result = await router._evolution_metadata_snapshot("synthetic-user", cache)
        hook.assert_awaited_once_with("synthetic", "token", "received", "http://app:8000/api/whatsapp/webhook")
        self.assertEqual(2, result["updates"]["evolutionWebhookVersion"])

    async def test_history_event_requires_current_binding_and_has_no_external_effect(self):
        save = AsyncMock()
        publish = AsyncMock()
        with patch.object(router, "is_evolution", return_value=True), patch.object(router, "_webhook_binding_is_current", return_value=False), \
             patch.object(router, "save_whatsapp_catalog_cache", save), patch("app.modules.chat.realtime.publish_change", publish):
            result = await router._whatsapp_dispatch_webhook("owner-a", {"event": "history_ready"}, "unknown")
        self.assertEqual("stale_binding", result["event"])
        save.assert_not_awaited()
        publish.assert_not_awaited()

    async def test_older_page_is_discarded_after_instance_switch(self):
        metadata = {"historicoTemMais": True, "historicoProximaPagina": 2,
                    "historicoAte": 1000, "historicoVinculo": binding_signature("old-instance", 1)}
        conversation = {"mensagens": [], "metadados": metadata}
        runtime = SimpleNamespace(
            load_conversations=AsyncMock(return_value={REMOTE: conversation}),
            whatsapp_history_page=lambda *args, **kwargs: {"items": [], "hasMore": False, "cursor": 100},
            whatsapp_history_sync_lock=lambda *_: __import__("asyncio").Lock(),
            whatsapp_conversation_mutation_lock=lambda *_: __import__("asyncio").Lock(),
            wapi_creds=lambda *_: ("old-instance", "synthetic-token"),
            wapi_owned_binding=unittest.mock.Mock(side_effect=[SimpleNamespace(created_at=1), SimpleNamespace(created_at=2)]),
            whatsapp_history_error_backoff_active=lambda *_: False,
            wapi_client=SimpleNamespace(fetch_history_page=AsyncMock(return_value={"messages": [], "hasMore": False})),
            save_conversations=AsyncMock(),
        )
        await backfill_older(runtime, "owner-a", REMOTE, before=100, before_id="last", limit=50)
        runtime.save_conversations.assert_not_awaited()
