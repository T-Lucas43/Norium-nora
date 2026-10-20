"""Synthetic names/profile/catalog regressions; no live WhatsApp data."""
import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

from app.modules.chat import router
from app.services.evolution_client import EvolutionClient, normalize_webhook
from app.services.wapi_client import WapiError
from app.services.conversation_store import new_conversation

REMOTE = "5511999990000@s.whatsapp.net"
GROUP = "120363400000000000@g.us"


class EvolutionCatalogTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        router.whatsapp_conversation_mutation_locks.clear()

    def test_metadata_webhook_strips_secrets_and_preserves_identity(self):
        result = normalize_webhook({"instance": "synthetic", "event": "CONTACTS_UPDATE", "apikey": "do-not-forward",
            "data": [{"remoteJid": REMOTE, "pushName": "Pessoa sintética", "profilePicUrl": "https://cdn.example.test/photo",
                      "apikey": "do-not-forward", "session": "do-not-forward", "message": {"conversation": "private"}}]})
        self.assertEqual("catalog", result["event"])
        self.assertEqual("contacts", result["catalogType"])
        self.assertEqual(REMOTE, result["catalogItems"][0]["id"])
        self.assertNotIn("do-not-forward", str(result))
        self.assertNotIn("private", str(result))

    async def test_catalog_prefers_saved_name_and_preserves_explicit_lid_alias(self):
        with patch("app.services.evolution_client._origin", return_value="http://evolution-api:8080"):
            client = EvolutionClient()
        client._call = AsyncMock(return_value=[{"remoteJid": REMOTE, "savedName": "Nome salvo", "pushName": "Nome de perfil",
            "lastMessage": {"key": {"remoteJid": REMOTE, "remoteJidAlt": "123456789@lid"}}}])
        result = await client.fetch_chats("synthetic", "token")
        self.assertEqual("Nome salvo", result["data"][0]["name"])
        self.assertEqual("123456789@lid", result["data"][0]["remoteJidAlt"])

    async def test_groups_use_long_background_timeout(self):
        with patch("app.services.evolution_client._origin", return_value="http://evolution-api:8080"):
            client = EvolutionClient()
        client._call = AsyncMock(return_value=[])
        await client.get_all_groups("synthetic", "token")
        self.assertEqual(150, client._call.call_args.kwargs["timeout"])
        self.assertEqual({"getParticipants": "false"}, client._call.call_args.kwargs["params"])

    async def test_device_profile_includes_own_name_photo_and_bio(self):
        with patch("app.services.evolution_client._origin", return_value="http://evolution-api:8080"):
            client = EvolutionClient()
        client._call = AsyncMock(side_effect=[[{"name": "synthetic", "ownerJid": "5511999990000:7@s.whatsapp.net",
            "profileName": "Meu perfil", "profilePicUrl": "https://cdn.example.test/photo", "connectionStatus": "open"}],
            {"name": "Nome alternativo", "picture": "https://cdn.example.test/new-photo", "status": "Recado sintético"}])
        device = await client.device("synthetic", "token")
        self.assertEqual("Meu perfil", device["name"])
        self.assertEqual("5511999990000", device["connectedPhone"])
        self.assertEqual("Recado sintético", device["bio"])
        self.assertEqual("https://cdn.example.test/new-photo", device["profilePictureUrl"])

    async def test_profile_is_saved_before_slow_groups_finish(self):
        groups_future = asyncio.get_running_loop().create_future()
        async def groups(*args, **kwargs):
            return await groups_future
        save = AsyncMock()
        with patch.object(router, "is_evolution", return_value=True), patch.object(router, "wapi_creds", return_value=("synthetic", "token")), \
             patch.object(router.wapi_client, "get_all_groups", side_effect=groups), \
             patch.object(router.wapi_client, "device", AsyncMock(return_value={"name": "Meu perfil", "connectedPhone": "5511999990000"})), \
             patch.object(router, "load_whatsapp_catalog_cache", AsyncMock(return_value={})), patch.object(router, "save_whatsapp_catalog_cache", save):
            task = asyncio.create_task(router._evolution_metadata_snapshot("synthetic-user", {"evolutionWebhookVersion": 1}))
            for _ in range(20):
                if save.await_count: break
                await asyncio.sleep(0)
            self.assertTrue(save.await_count)
            self.assertFalse(task.done())
            groups_future.set_result([{"id": GROUP, "subject": "Equipe sintética", "size": 5}])
            result = await task
        self.assertEqual("Equipe sintética", result["groups"][0]["name"])
        self.assertEqual("Meu perfil", result["updates"]["evolutionProfile"]["name"])

    async def test_fresh_metadata_does_not_repeat_remote_reads(self):
        cache = {"evolutionMetadataVersion": 1, "evolutionMetadataSyncedAt": time.time(), "evolutionGroups": [{"id": GROUP}]}
        with patch.object(router, "is_evolution", return_value=True), patch.object(router.wapi_client, "get_all_groups", AsyncMock()) as fetch:
            result = await router._evolution_metadata_snapshot("synthetic-user", cache)
        fetch.assert_not_awaited()
        self.assertEqual(cache["evolutionGroups"], result["groups"])

    async def test_metadata_failure_preserves_known_groups(self):
        cache = {"evolutionWebhookVersion": 1, "evolutionGroups": [{"id": GROUP, "name": "Equipe conhecida"}]}
        with patch.object(router, "is_evolution", return_value=True), patch.object(router, "wapi_creds", return_value=("synthetic", "token")), \
             patch.object(router.wapi_client, "get_all_groups", AsyncMock(side_effect=WapiError("synthetic timeout"))), \
             patch.object(router.wapi_client, "device", AsyncMock(return_value={"name": "Meu perfil"})), \
             patch.object(router, "load_whatsapp_catalog_cache", AsyncMock(return_value={})), patch.object(router, "save_whatsapp_catalog_cache", AsyncMock()):
            result = await router._evolution_metadata_snapshot("synthetic-user", cache)
        self.assertEqual(cache["evolutionGroups"], result["groups"])
        self.assertTrue(result["warnings"])
        self.assertNotIn("evolutionMetadataSyncedAt", result["updates"])

    async def test_contact_event_updates_name_without_losing_messages(self):
        conv = new_conversation(REMOTE, channel="whatsapp")
        conv["mensagens"] = [{"id": "SYNTHETIC-MESSAGE", "texto": "Exemplo"}]
        cache = {"contacts": [{"id": REMOTE, "name": REMOTE}]}
        save = AsyncMock()
        with patch.object(router, "_webhook_binding_is_current", return_value=True), \
             patch.object(router, "load_whatsapp_catalog_cache", AsyncMock(return_value=cache)), \
             patch.object(router, "save_whatsapp_catalog_cache", save), \
             patch.object(router, "load_conversations", AsyncMock(return_value={REMOTE: conv})), \
             patch.object(router, "save_conversations", AsyncMock()):
            result = await router._apply_evolution_catalog_event("synthetic-user", {"instanceId": "synthetic", "catalogType": "contacts",
                "catalogItems": [{"id": REMOTE, "remoteJid": REMOTE, "pushName": "Pessoa sintética"}]})
        self.assertEqual("success", result["status"])
        self.assertEqual("Pessoa sintética", conv["contato"])
        self.assertEqual("SYNTHETIC-MESSAGE", conv["mensagens"][0]["id"])
        self.assertEqual("synthetic-user", save.call_args.args[0])

    async def test_stale_metadata_cannot_write_to_user_store(self):
        save = AsyncMock()
        with patch.object(router, "_webhook_binding_is_current", return_value=False), patch.object(router, "save_whatsapp_catalog_cache", save):
            result = await router._apply_evolution_catalog_event("synthetic-user", {"catalogType": "contacts", "catalogItems": [{"id": REMOTE}]})
        self.assertEqual("stale_binding", result["event"])
        save.assert_not_awaited()

    async def test_cached_profile_returns_name_and_photo_without_remote_call(self):
        user = {"id": "synthetic-user", "role": "owner", "plan": "enterprise", "status": "ativo", "permissions": {"chat": True, "integracao_whatsapp": True}}
        cache = {"evolutionProfile": {"name": "Meu perfil", "photoUrl": "https://cdn.example.test/photo"}}
        with patch.object(router, "is_evolution", return_value=True), \
             patch.object(router.wapi_connect, "cached_status", return_value={"status": "conectado"}), \
             patch.object(router, "load_whatsapp_catalog_cache", AsyncMock(return_value=cache)), \
             patch.object(router, "contact_sync_retry_due", return_value=False), \
             patch.object(router, "remember_remote_media_references"), patch.object(router.wapi_client, "device", AsyncMock()) as device:
            result = await router.obter_perfil_whatsapp(user=user)
        self.assertEqual("Meu perfil", result["name"])
        self.assertTrue(result["cached"])
        device.assert_not_awaited()
