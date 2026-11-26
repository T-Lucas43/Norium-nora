import base64
from io import BytesIO
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from PIL import Image

from app.modules.chat import router as chat
from app.modules.chat.conversation_projection import list_page
from app.modules.chat.realtime import publish_change
from app.modules.chat.thumbnails import thumbnail_bytes
from app.modules.business import router as business
from app.services.conversation_store import normalize_conversation


REMOTE = "5511999990000@s.whatsapp.net"
OWNER = {"id": "synthetic-owner", "role": "owner", "plan": "equipe"}


class ProjectionTests(unittest.TestCase):
    def test_summaries_are_bounded_and_do_not_transport_history(self):
        database = {str(i): normalize_conversation(str(i), {"contato": f"Contato {i}", "mensagens": [
            {"id": str(i), "timestamp": i + 100, "texto": "Última mensagem", "horario": "10:00"}]}) for i in range(237)}
        page = list_page(chat, database, {}, offset=100, limit=100)
        self.assertEqual((237, 200, 100), (page["total"], page["nextOffset"], len(page["items"])))
        self.assertTrue(all(row["mensagens"] == [] and row["ultimoTexto"] == "Última mensagem" for row in page["items"]))
        self.assertEqual("136", page["items"][0]["id"])
        self.assertEqual(237, len(database))

    def test_search_finds_old_local_text_without_returning_it(self):
        row = normalize_conversation(REMOTE, {"contato": "Nome", "mensagens": [
            {"id": "old", "timestamp": 1, "texto": "Contrato antigo"},
            {"id": "new", "timestamp": 2, "texto": "Recente"}]})
        page = list_page(chat, {REMOTE: row}, {}, offset=0, limit=100, search="CONTRATO")
        self.assertEqual([REMOTE], [item["id"] for item in page["items"]])
        self.assertEqual([], page["items"][0]["mensagens"])
        self.assertEqual(2, len(row["mensagens"]))

    def test_catalog_projection_does_not_persist_or_include_channels(self):
        database = {}
        page = list_page(chat, database, {"chats": [
            {"id": REMOTE, "name": "Contato sintético"},
            {"id": "120363400000@g.us", "subject": "Equipe sintética", "isGroup": True},
            {"id": "123@newsletter", "name": "Canal"}, {"id": "status@broadcast"}]}, offset=0, limit=100)
        self.assertEqual({REMOTE, "120363400000@g.us"}, {row["id"] for row in page["items"]})
        self.assertEqual({}, database)

    def test_history_cursor_survives_store_normalization(self):
        metadata = {"historicoProximaPagina": 3, "historicoAte": 1000, "historicoVinculo": "synthetic-binding", "historicoTemMais": True}
        first = normalize_conversation(REMOTE, {"metadados": metadata})
        second = normalize_conversation(REMOTE, first)
        for key, value in metadata.items():
            self.assertEqual(value, second["metadados"][key])

    def test_history_response_omits_decryption_metadata(self):
        message = {"id": "m1", "timestamp": 1, "tipo": "midia", "midiaMeta": {"mediaKey": "synthetic-secret", "thumbnail": "AAAA"}}
        page = chat.whatsapp_history_page({"id": REMOTE, "mensagens": [message]}, before=None, limit=50)
        self.assertIsNone(page["items"][0]["midiaMeta"])
        self.assertTrue(page["items"][0]["miniaturaUrl"].endswith("/mensagens/m1/miniatura"))
        self.assertEqual("synthetic-secret", message["midiaMeta"]["mediaKey"])


class ThumbnailTests(unittest.IsolatedAsyncioTestCase):
    async def test_contact_details_do_not_bypass_paginated_history(self):
        message = {"id": "private", "texto": "Private history", "midiaMeta": {"mediaKey": "synthetic-key"}}
        database = {REMOTE: {"id": REMOTE, "contato": "Contato sintético", "mensagens": [message]}}
        with patch.object(chat, "load_conversations", AsyncMock(return_value=database)), \
             patch.object(chat, "load_whatsapp_catalog_cache", AsyncMock(return_value={})), \
             patch.object(chat, "wapi_creds", return_value=None), \
             patch.object(chat, "fetch_profile_picture", AsyncMock(return_value=None)):
            result = await chat.obter_detalhes_conversa(REMOTE, OWNER)
        self.assertEqual([], result["mensagens"])
        self.assertEqual("Contato sintético", result["contato"])
        saved = database[REMOTE]["mensagens"]
        self.assertEqual(1, len(saved))
        self.assertEqual(message["texto"], saved[0]["texto"])
        self.assertEqual(message["midiaMeta"], saved[0]["midiaMeta"])

    def example(self):
        output = BytesIO()
        Image.new("RGB", (640, 480), "blue").save(output, format="JPEG")
        return {"id": "media", "tipo": "midia", "midiaMeta": {"thumbnail": base64.b64encode(output.getvalue()).decode()}}

    def test_bounded_preview_strips_metadata(self):
        with Image.open(BytesIO(thumbnail_bytes(self.example()))) as preview:
            self.assertEqual((320, 240), preview.size)
            self.assertFalse(preview.getexif())

    def test_rejects_url_view_once_and_invalid_image(self):
        for message in [{**self.example(), "visualizacaoUnica": True},
                        {"tipo": "midia", "midiaMeta": {"thumbnail": "https://untrusted.invalid/private"}},
                        {"tipo": "midia", "midiaMeta": {"thumbnail": "AAAA"}},
                        {"tipo": "audio", "midiaMeta": {"thumbnail": "AAAA"}}]:
            with self.assertRaises(HTTPException) as error:
                thumbnail_bytes(message)
            self.assertEqual(404, error.exception.status_code)

    async def test_thumbnail_reads_only_authenticated_account_and_conversation(self):
        load = AsyncMock(return_value={"another-conversation": {"mensagens": [self.example()]}})
        with patch.object(chat, "load_conversations", load):
            with self.assertRaises(HTTPException) as error:
                await chat.obter_miniatura_whatsapp(REMOTE, "media", OWNER)
        self.assertEqual(404, error.exception.status_code)
        load.assert_awaited_once_with(OWNER["id"])


class LiveEventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_payload_contains_only_private_owner_and_invalidation(self):
        from app.modules.inbox.router import manager
        with patch.object(manager, "broadcast", AsyncMock()) as broadcast:
            await publish_change("synthetic-owner", "labels", 123)
        broadcast.assert_awaited_once_with("synthetic-owner", {"type": "WHATSAPP_CONVERSATION_UPDATED", "ownerId": "synthetic-owner", "area": "labels", "revision": 123})

    async def test_missing_owner_fails_closed(self):
        with self.assertRaises(ValueError):
            await publish_change("")

    async def test_failed_invalidation_does_not_replay_external_action(self):
        from app.modules.inbox.router import manager
        with patch.object(manager, "broadcast", AsyncMock(side_effect=RuntimeError("synthetic failure"))) as broadcast:
            await publish_change("synthetic-owner")
        self.assertEqual(1, broadcast.await_count)


class ContactLabelTests(unittest.IsolatedAsyncioTestCase):
    async def projection(self, owner=OWNER, binding="current"):
        definitions = [{"id": "visible", "name": "Cliente", "color": "#16a34a", "scope": "contact", "createdBy": OWNER["id"]},
                       {"id": "archived", "name": "Antiga", "scope": "contact", "active": False}]
        links = [{"conversationId": REMOTE, "conversationOwnerId": OWNER["id"], "bindingKey": "current", "tagId": "visible"},
                 {"conversationId": REMOTE, "conversationOwnerId": "other-owner", "bindingKey": "current", "tagId": "archived"}]
        def snapshot(user, kind):
            self.assertEqual(owner["id"], user["id"])
            return {"items": definitions if kind == "tags" else links}
        with patch.object(business, "conversation_binding_key", AsyncMock(return_value=binding)), \
             patch.object(business, "owned_conversations", AsyncMock(return_value={REMOTE: {}})), \
             patch("app.modules.business.whatsapp_contacts.contact_alias_index", AsyncMock(return_value={})), \
             patch.object(business, "snapshot", snapshot):
            return await business.contact_label_projection(business.ContactLabelsQuery(contactIds=[REMOTE, "unknown"]), owner)

    async def test_only_current_owner_binding_and_known_contacts(self):
        result = await self.projection()
        self.assertEqual(["visible"], [tag["id"] for tag in result["items"][0]["tags"]])
        self.assertEqual([], result["items"][1]["tags"])

    async def test_other_owner_same_workspace_and_replaced_binding_are_empty(self):
        for owner, binding in [({"id": "other-owner", "teamOwnerId": OWNER["id"], "role": "owner", "plan": "equipe"}, "current"), (OWNER, "replaced")]:
            result = await self.projection(owner, binding)
            self.assertTrue(all(not item["tags"] for item in result["items"]))

    async def test_no_integration_permission_denies_before_loading_tags(self):
        with patch.object(business, "snapshot") as snapshot:
            with self.assertRaises(HTTPException) as error:
                await business.contact_label_projection(business.ContactLabelsQuery(contactIds=[REMOTE]), {"id": "member", "role": "member", "permissions": {"chat": True, "integracao_whatsapp": False}})
        self.assertEqual(403, error.exception.status_code)
        snapshot.assert_not_called()
