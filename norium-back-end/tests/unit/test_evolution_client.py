"""Synthetic Evolution contracts. No provider, real session or external sends."""
from __future__ import annotations

import base64
import os
import unittest
from unittest.mock import AsyncMock, PropertyMock, patch

import httpx

from app.services.evolution_client import EvolutionClient, normalize_webhook
from app.services.wapi_client import WapiError
from app.services import wapi_webhook
from app.modules.chat import router
from app.services.conversation_store import new_conversation

REMOTE = "5511999990000@s.whatsapp.net"
KEY = {"id": "SYNTHETIC-MSG", "remoteJid": REMOTE, "fromMe": False}


class EvolutionContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ, {"EVOLUTION_BASE_URL": "http://evolution-api:8080",
                                    "EVOLUTION_PRIVATE_NETWORK_ENABLED": "1"}):
            self.client = EvolutionClient()

    async def test_media_download_uses_complete_owned_reference(self):
        media = {"audioMessage": {"mediaKey": "c3ludGhldGlj", "directPath": "/synthetic",
                                  "mimetype": "audio/ogg; codecs=opus", "seconds": 7}}
        self.client._call = AsyncMock(side_effect=[{"messages": {"records": [{"key": KEY, "message": media}]}},
                                                  {"base64": "T2dnUw==", "mimetype": "audio/ogg"}])
        result = await self.client.download_media("synthetic", "synthetic-token", media_key="unused",
                    direct_path="/unused", media_type="audio", mimetype="audio/ogg",
                    phone=REMOTE, message_id=KEY["id"])
        self.assertEqual("T2dnUw==", result["base64"])
        sent = self.client._call.call_args.kwargs["body"]
        self.assertEqual(KEY, sent["message"]["key"])
        self.assertEqual({**media["audioMessage"], "url": "https://mmg.whatsapp.net/synthetic"}, sent["message"]["message"]["audioMessage"])

    async def test_media_cannot_redirect_gateway_to_an_arbitrary_origin(self):
        for direct in ("@127.0.0.1/private", "//internal/private", "/synthetic\r\nHeader:value"):
            with self.subTest(direct=direct):
                self.client._call = AsyncMock(return_value={"messages": {"records": [{"key": KEY,
                    "message": {"audioMessage": {"directPath": direct, "url": "http://internal/private"}}}]}})
                with self.assertRaises(WapiError) as error:
                    await self.client.download_media("synthetic", "token", media_key="", direct_path="",
                        media_type="audio", mimetype="audio/ogg", phone=REMOTE, message_id=KEY["id"])
                self.assertEqual("invalid_media", error.exception.code)
                self.assertEqual(1, self.client._call.await_count)

    async def test_reaction_accepts_privacy_alias_after_scoped_lookup(self):
        key = {**KEY, "remoteJid": "123456789@lid", "remoteJidAlt": REMOTE}
        self.client._call = AsyncMock(side_effect=[{"messages": {"records": [{"key": key}]}},
                                                  {"key": {"id": "SYNTHETIC-REACTION"}}])
        result = await self.client.send_reaction("synthetic", "token", REMOTE.split("@")[0], KEY["id"], "👍")
        self.assertEqual("SYNTHETIC-REACTION", result["messageId"])
        lookup = self.client._call.call_args_list[0].kwargs["body"]
        self.assertEqual({"id": KEY["id"]}, lookup["where"]["key"])
        self.assertEqual("123456789@lid", self.client._call.call_args.kwargs["body"]["key"]["remoteJid"])

    async def test_reference_from_another_conversation_is_rejected(self):
        self.client._call = AsyncMock(return_value={"messages": {"records": [
            {"key": {**KEY, "remoteJid": "5511888880000@s.whatsapp.net"}}]}})
        with self.assertRaises(WapiError):
            await self.client.send_reaction("synthetic", "token", REMOTE, KEY["id"], "👍")
        self.assertEqual(1, self.client._call.await_count)

    async def test_media_from_another_conversation_is_rejected(self):
        self.client._call = AsyncMock(return_value={"messages": {"records": [
            {"key": {**KEY, "remoteJid": "5511888880000@s.whatsapp.net"}}]}})
        with self.assertRaises(WapiError):
            await self.client.download_media("synthetic", "token", media_key="", direct_path="",
                media_type="audio", mimetype="audio/ogg", phone=REMOTE, message_id=KEY["id"])
        self.assertEqual(1, self.client._call.await_count)

    async def test_zip_mime_alias_is_normalized_without_allowing_new_formats(self):
        for supplied, expected in (("application/x-zip-compressed", "application/zip"),
                                   ("application/pdf", "application/pdf"),
                                   ("application/vnd.android.package-archive", "application/vnd.android.package-archive")):
            self.client._call = AsyncMock(side_effect=[{"messages": {"records": [{"key": KEY,
                "message": {"documentMessage": {"directPath": "/synthetic", "mimetype": supplied}}}]}},
                {"base64": "c3ludGhldGlj", "mimetype": supplied}])
            result = await self.client.download_media("synthetic", "token", media_key="", direct_path="",
                media_type="document", mimetype=supplied, phone=REMOTE, message_id=KEY["id"])
            self.assertEqual(expected, result["mimetype"])

    async def test_reaction_without_confirmation_is_not_reported_as_sent(self):
        self.client._call = AsyncMock(side_effect=[{"messages": {"records": [{"key": KEY}]}}, {}])
        with self.assertRaises(WapiError) as exc:
            await self.client.send_reaction("synthetic", "token", REMOTE, KEY["id"], "👍")
        self.assertEqual("remote_outcome_unknown", exc.exception.code)
        self.assertEqual(2, self.client._call.await_count)

    async def test_reaction_removal_uses_empty_text(self):
        self.client._call = AsyncMock(side_effect=[{"messages": {"records": [{"key": KEY}]}},
                                                  {"key": {"id": "SYNTHETIC-REMOVE"}}])
        await self.client.remove_reaction("synthetic", "token", REMOTE, KEY["id"])
        self.assertEqual("", self.client._call.call_args.kwargs["body"]["reaction"])

    async def test_edit_and_delete_reject_received_messages(self):
        self.client._call = AsyncMock(return_value={"messages": {"records": [{"key": KEY}]}})
        for method in (lambda: self.client.edit_message("synthetic", "token", REMOTE, KEY["id"], "edit"),
                       lambda: self.client.delete_message("synthetic", "token", REMOTE, KEY["id"])):
            self.client._call.reset_mock()
            with self.assertRaises(WapiError):
                await method()
            self.assertEqual(1, self.client._call.await_count)

    async def test_outgoing_media_routes_and_confirmations(self):
        for kind, route in (("audio", "sendWhatsAppAudio"), ("image", "sendMedia"),
                            ("video", "sendMedia"), ("document", "sendMedia"), ("sticker", "sendSticker")):
            with self.subTest(kind=kind):
                self.client._call = AsyncMock(return_value={"key": {"id": "SYNTHETIC-SEND"}})
                result = await self.client.send_media("synthetic", "token", kind, REMOTE, "data:audio/ogg;base64,T2dnUw==")
                self.assertEqual("SYNTHETIC-SEND", result["messageId"])
                self.assertEqual("/message/"+route+"/synthetic", self.client._call.call_args.args[1])
                self.assertFalse(self.client._call.call_args.kwargs["read_only"])

    async def test_history_preserves_media_metadata_and_timestamp(self):
        self.client._call = AsyncMock(return_value={"messages": {"records": [{"key": KEY,
            "messageTimestamp": 1800000000, "message": {"audioMessage": {"mediaKey": {"type": "Buffer", "data": [1, 2, 3]},
            "directPath": "/synthetic", "mimetype": "audio/ogg", "seconds": 12}}}], "pages": 1}})
        result = await self.client.fetch_chat("synthetic", "token", REMOTE)
        record = result["messages"][0]
        self.assertEqual(1800000000, record["timestamp"])
        self.assertEqual(12, record["duration"])
        self.assertEqual(base64.b64encode(bytes([1, 2, 3])).decode(), record["message"]["audioMessage"]["mediaKey"])

    def test_wrapped_media_reaches_existing_pipeline(self):
        for kind, expected in (("audio", "audio"), ("image", "midia"), ("video", "midia"),
                               ("document", "documento"), ("sticker", "sticker")):
            with self.subTest(kind=kind):
                payload = normalize_webhook({"instance": "synthetic", "event": "messages.upsert", "apikey": "must-not-leak",
                    "data": {"key": KEY, "messageTimestamp": 1800000000, "message": {"deviceSentMessage": {"message": {
                        kind+"Message": {"mediaKey": "c3ludGhldGlj", "directPath": "/synthetic", "mimetype": kind+"/synthetic"}}}}}})
                self.assertNotIn("apikey", payload)
                adapted = wapi_webhook.adapt_incoming(payload)
                self.assertIsNotNone(adapted)
                self.assertEqual(expected, adapted["tipo"])
                self.assertEqual(kind, adapted["midiaMeta"]["type"])

    def test_history_reaction_updates_target_instead_of_creating_bubble(self):
        conv = new_conversation(REMOTE, channel="whatsapp")
        router.sync_catalog_messages(conv, {"id": REMOTE, "messages": [
            {"key": KEY, "timestamp": 1800000000, "message": {"conversation": "synthetic"}},
            {"key": {**KEY, "id": "SYNTHETIC-REACTION"}, "timestamp": 1800000001,
             "message": {"reactionMessage": {"key": KEY, "text": "👍"}}}]})
        self.assertEqual([KEY["id"]], [msg["id"] for msg in conv["mensagens"]])
        self.assertEqual("👍", conv["mensagens"][0]["reacoes"][0]["emoji"])

    async def test_phone_reaction_from_me_keeps_other_participants(self):
        conv = {"id": REMOTE, "mensagens": [{"id": KEY["id"], "reacoes": [
            {"emoji": "👍", "count": 1, "fromMe": False, "senders": ["participant"]}]}]}
        with patch.object(router, "load_conversations", AsyncMock(return_value={REMOTE: conv})), \
             patch.object(router, "save_conversations", AsyncMock()), \
             patch.object(router, "mark_whatsapp_conversation_updated", AsyncMock()):
            await router._wapi_apply_reaction("synthetic-user", {"chatId": REMOTE, "reactionTargetId": KEY["id"],
                                                "texto": "❤️", "fromMe": True})
        reactions = conv["mensagens"][0]["reacoes"]
        self.assertEqual(2, len(reactions))
        self.assertTrue(next(row for row in reactions if row["emoji"] == "❤️")["fromMe"])

    def test_group_reactions_preserve_other_authors_and_remove_only_one(self):
        reactions = []
        for sender in ("participant-a", "participant-b"):
            reactions = wapi_webhook.updated_reactions(reactions, {"senderId": sender, "texto": "👍"})
        self.assertEqual(2, reactions[0]["count"])
        reactions = wapi_webhook.updated_reactions(reactions, {"senderId": "participant-a", "texto": ""})
        self.assertEqual(["participant-b"], reactions[0]["senders"])
        self.assertEqual(1, reactions[0]["count"])

    async def test_reference_cannot_update_a_different_local_conversation(self):
        conv = {"id": "other-chat", "mensagens": [{"id": KEY["id"], "reacoes": []}]}
        save = AsyncMock()
        with patch.object(router, "load_conversations", AsyncMock(return_value={"other-chat": conv})), \
             patch.object(router, "save_conversations", save):
            result = await router._wapi_apply_reaction("synthetic-user", {"chatId": REMOTE,
                "reactionTargetId": KEY["id"], "texto": "👍"})
        self.assertEqual("ignored", result["status"])
        save.assert_not_awaited()

    async def test_network_failure_does_not_repeat_external_write(self):
        attempts = []
        def transport(request):
            attempts.append(request.method)
            raise httpx.ConnectError("synthetic transport failure")
        original = httpx.AsyncClient
        with patch.object(EvolutionClient, "configured", new_callable=PropertyMock, return_value=True), \
             patch("app.services.evolution_client.httpx.AsyncClient", side_effect=lambda **kwargs: original(transport=httpx.MockTransport(transport))):
            with self.assertRaises(WapiError):
                await self.client._call("POST", "/message/sendReaction/synthetic", token="synthetic-only", body={})
        self.assertEqual(["POST"], attempts)


if __name__ == "__main__":
    unittest.main()
