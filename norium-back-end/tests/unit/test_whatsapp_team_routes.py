from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.testclient import TestClient
from app.modules.auth import router as auth
from app.modules.chat import router as chat
from app.modules.chat.history import binding_signature
from app.modules.whatsapp_team import access, repository, router as team, service
from app.services.conversation_store import normalize_conversation
from tests.unit.test_whatsapp_team import Fixture


class TeamRouteTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.scope = repository.Scope("owner", "primary", "owner", binding_signature("synthetic-instance", 1))
        self.owner_access = access.Access(self.owner, self.owner, self.scope, self.roster)
        self.actor = self.owner
        self.directory = {"users": list(self.roster)}
        self.database = {identifier: normalize_conversation(identifier, {"contato": name, "mensagens": [
            {"id": identifier + "-message", "timestamp": 100, "texto": "Synthetic text", "tipo": "audio", "arquivoUrl": "/api/chat/midia/private"}]})
                         for identifier, name in (("chat-a", "Private Alice"), ("chat-b", "Unassigned"))}
        for active in (patch.object(chat, "read_user_store", AsyncMock(side_effect=lambda: copy.deepcopy(self.directory))),
                       patch.object(chat, "wapi_owned_binding", return_value=SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=1)),
                       patch.object(chat, "load_conversations", AsyncMock(side_effect=lambda _: copy.deepcopy(self.database))),
                       patch.object(chat, "load_whatsapp_catalog_cache", AsyncMock(return_value={})),
                       patch.object(team, "changed", AsyncMock())):
            active.start(); self.addCleanup(active.stop)
        notifier = patch("app.modules.whatsapp_team.notifications.changed", AsyncMock())
        notifier.start(); self.addCleanup(notifier.stop)
        application = FastAPI()
        application.include_router(team.router)
        application.dependency_overrides[auth.current_user] = lambda: self.actor
        self.client = TestClient(application)
        self.addCleanup(self.client.close)
        self.base = "/api/chat/caixas/" + self.scope.inbox_id

    def enable_box(self):
        response = self.client.patch("/api/chat/caixas/configuracao", json={"enabled": True, "expectedRevision": 0})
        self.assertEqual(200, response.status_code, response.text)

    def assign_alice(self):
        self.enable_box()
        response = self.client.patch(self.base + "/conversas/chat-a/atendimento", json={"expectedVersion": 0, "assigneeUserId": "alice"})
        self.assertEqual(200, response.status_code, response.text)

    def test_default_and_owner_only_explicit_sharing(self):
        result = self.client.get("/api/chat/caixas").json()
        self.assertEqual([], result["items"])
        self.assertFalse(result["configuration"]["enabled"])
        self.actor = self.alice
        denied = self.client.patch("/api/chat/caixas/configuracao", json={"enabled": True, "expectedRevision": 0})
        self.assertEqual(403, denied.status_code)
        self.assertIsNone(self.client.get("/api/chat/caixas").json()["configuration"])
        self.actor = self.owner
        self.enable_box()
        self.actor = self.alice
        self.assertEqual(self.scope.inbox_id, self.client.get("/api/chat/caixas").json()["items"][0]["id"])

    def test_filters_counts_and_search_never_include_another_assignee(self):
        self.assign_alice()
        self.actor = self.bob
        result = self.client.get(self.base + "/conversas").json()
        self.assertEqual(["chat-b"], [row["id"] for row in result["items"]])
        self.assertEqual((1, 1, 0), (result["total"], result["counts"]["all"], result["counts"]["me"]))
        self.assertEqual(0, self.client.get(self.base + "/conversas?search=Alice").json()["total"])
        self.actor = self.alice
        result = self.client.get(self.base + "/conversas?responsavel=me&estado=open").json()
        self.assertEqual(["chat-a"], [row["id"] for row in result["items"]])
        self.assertEqual(2, result["counts"]["all"])
        self.assertTrue(result["items"][0]["attendanceRef"])
        self.actor = self.manager
        self.assertEqual(2, self.client.get(self.base + "/conversas").json()["total"])

    def test_notes_and_audit_are_internal_and_only_accessible_in_allowed_conversation(self):
        self.assign_alice()
        self.actor = self.alice
        with patch.object(chat.whatsapp_integration, "send", AsyncMock(side_effect=AssertionError("No external send"))) as send:
            result = self.client.post(self.base + "/conversas/chat-a/notas", json={"body": "Private synthetic note", "mentions": ["manager"]})
            self.assertEqual(201, result.status_code, result.text)
            send.assert_not_called()
        history = self.client.get(self.base + "/conversas/chat-a/historico")
        self.assertEqual(200, history.status_code, history.text)
        self.assertNotIn("Private synthetic note", history.text)
        self.assertEqual("Private synthetic note", self.client.get(self.base + "/conversas/chat-a/notas").json()["items"][0]["body"])
        self.actor = self.bob
        for suffix in ("notas", "historico", "mensagens", "foto"):
            self.assertEqual(404, self.client.get(self.base + "/conversas/chat-a/" + suffix).status_code)
        self.assertEqual(404, self.client.post(self.base + "/conversas/unknown/notas", json={"body": "Synthetic"}).status_code)

    def test_media_checks_message_membership_before_owner_adapter(self):
        self.assign_alice()
        self.actor = self.bob
        with patch.object(chat, "obter_midia_whatsapp", AsyncMock(return_value=Response(b"synthetic", media_type="audio/ogg"))) as stream:
            self.assertEqual(404, self.client.get(self.base + "/conversas/chat-b/mensagens/chat-a-message/midia").status_code)
            stream.assert_not_called()
            response = self.client.get(self.base + "/conversas/chat-b/mensagens/chat-b-message/midia")
            self.assertEqual(200, response.status_code, response.text)
            self.assertEqual("private, no-store", response.headers["cache-control"])
            self.assertEqual("owner", stream.call_args.kwargs["user"]["id"])

    def test_late_reassignment_discards_media_response(self):
        self.enable_box()
        self.actor = self.bob
        async def stream(*args, **kwargs):
            service.update_assignment(self.owner_access, "chat-b", expected_version=0, changes={"assigneeUserId": "alice"})
            return Response(b"must not leave server", media_type="audio/ogg")
        with patch.object(chat, "obter_midia_whatsapp", AsyncMock(side_effect=stream)):
            result = self.client.get(self.base + "/conversas/chat-b/mensagens/chat-b-message/midia")
        self.assertEqual(404, result.status_code)
        self.assertNotIn("must not leave server", result.text)

    def test_message_projection_rewrites_private_media_and_strips_keys(self):
        self.enable_box()
        result = {"items": [{"id": "chat-b-message", "tipo": "audio", "arquivoUrl": "/api/chat/midia/private",
                            "midiaMeta": {"mediaKey": "synthetic-not-a-credential"}, "miniaturaUrl": "/private-preview"}],
                  "cursor": 100, "cursorId": "chat-b-message", "hasMore": False}
        self.actor = self.bob
        with patch.object(chat, "obter_historico_conversa", AsyncMock(return_value=result)):
            response = self.client.get(self.base + "/conversas/chat-b/mensagens")
        self.assertEqual(200, response.status_code, response.text)
        message = response.json()["items"][0]
        self.assertNotIn("midiaMeta", message)
        self.assertTrue(message["arquivoUrl"].startswith(self.base + "/conversas/chat-b/"))
        self.assertTrue(message["miniaturaUrl"].startswith(self.base + "/conversas/chat-b/"))

    def test_revocation_and_optout_block_existing_inbox_id(self):
        self.enable_box()
        self.actor = self.alice
        self.directory["users"] = [self.owner, {**self.alice, "status": "inativo"}]
        self.assertEqual(403, self.client.get(self.base + "/conversas").status_code)
        self.directory["users"] = list(self.roster)
        self.actor = self.owner
        response = self.client.patch("/api/chat/caixas/configuracao", json={"enabled": False, "expectedRevision": 1})
        self.assertEqual(200, response.status_code)
        self.actor = self.alice
        self.assertEqual(404, self.client.get(self.base + "/conversas").status_code)

    def test_payloads_reject_unknown_fields_and_boolean_version(self):
        self.enable_box()
        self.assertEqual(422, self.client.patch(self.base + "/conversas/chat-a/atendimento", json={"expectedVersion": True, "status": "open"}).status_code)
        self.assertEqual(422, self.client.post(self.base + "/conversas/chat-a/notas", json={"body": "Synthetic", "owner_id": "foreign"}).status_code)

    def test_manual_send_uses_existing_sender_and_correct_actor(self):
        self.enable_box()
        self.actor = self.alice
        from app.modules.whatsapp_team.bridge import manual_actor
        async def send(owner_id, command):
            self.assertEqual("owner", owner_id)
            self.assertEqual("alice", manual_actor.get())
            self.assertEqual("chat-b", command.conversation_id)
            return SimpleNamespace(status="enviado", channel="whatsapp")
        with patch.object(chat.whatsapp_integration, "send", AsyncMock(side_effect=send)) as sender:
            result = self.client.post(self.base + "/enviar", json={"conversa_id": "chat-b", "texto": "Synthetic message"})
        self.assertEqual(200, result.status_code, result.text)
        sender.assert_awaited_once()
        row = repository.snapshot(self.scope)["assignments"]["chat-b"]
        self.assertEqual("alice", row["assigneeUserId"])
        self.assertEqual("", manual_actor.get())

    def test_denied_or_unconfirmed_send_does_not_claim_or_retry(self):
        self.assign_alice()
        self.actor = self.bob
        with patch.object(chat.whatsapp_integration, "send", AsyncMock(side_effect=HTTPException(503, "Synthetic unavailable"))) as sender:
            result = self.client.post(self.base + "/enviar", json={"conversa_id": "chat-a", "texto": "Denied"})
            self.assertEqual(404, result.status_code)
            sender.assert_not_called()
            result = self.client.post(self.base + "/enviar", json={"conversa_id": "chat-b", "texto": "Synthetic"})
            self.assertEqual(503, result.status_code)
            sender.assert_awaited_once()
        self.assertNotIn("chat-b", repository.snapshot(self.scope)["assignments"])

    def test_private_member_number_does_not_claim_owner_inbox(self):
        from app.modules.whatsapp_team import bridge
        with patch.object(service, "record_outgoing") as record, patch.object(chat.whatsapp_integration, "send", AsyncMock(return_value=SimpleNamespace(status="enviado", channel="whatsapp"))):
            import asyncio
            asyncio.run(chat.enviar_mensagem(chat.EnviarMensagemPayload(conversa_id="chat-b", texto="Synthetic"), user=self.alice))
            record.assert_not_called()

    def test_actions_require_exact_message_membership_before_any_adapter(self):
        self.assign_alice()
        self.actor = self.bob
        for path, handler, verb, extra in (("reagir", "reagir_mensagem", "post", {"emoji": "👍"}),
                                          ("editar-mensagem", "editar_mensagem", "patch", {"texto": "Synthetic edit"}),
                                          ("apagar-mensagem", "apagar_mensagem", "post", {"para_todos": False})):
            with self.subTest(path=path), patch.object(chat, handler, AsyncMock(return_value={"status": "ok"})) as adapter:
                request = getattr(self.client, verb)
                denied = request(self.base + "/" + path, json={"conversa_id": "chat-b", "mensagem_id": "chat-a-message", **extra})
                self.assertEqual(404, denied.status_code, denied.text)
                adapter.assert_not_called()
                allowed = request(self.base + "/" + path, json={"conversa_id": "chat-b", "mensagem_id": "chat-b-message", **extra})
                self.assertEqual(200, allowed.status_code, allowed.text)
                self.assertEqual("owner", adapter.call_args.kwargs["user"]["id"])

    def test_quote_cannot_reference_a_message_from_another_conversation(self):
        self.enable_box()
        self.actor = self.alice
        with patch.object(chat.whatsapp_integration, "send", AsyncMock()) as sender:
            response = self.client.post(self.base + "/enviar", json={"conversa_id": "chat-b", "texto": "Synthetic", "responder_a": "chat-a-message"})
        self.assertEqual(404, response.status_code)
        sender.assert_not_called()

    def test_forward_authorizes_exact_source_and_destination_before_delivery(self):
        self.assign_alice()
        self.actor = self.bob
        with patch.object(chat, "_forward_authorized_sources", AsyncMock(return_value={"status": "encaminhado"})) as forward:
            for source, target in (("chat-a", "chat-b"), ("chat-b", "chat-a")):
                result = self.client.post(self.base + "/encaminhar", json={"origem_id": source, "destino_id": target, "mensagens_ids": [source + "-message"]})
                self.assertEqual(404, result.status_code)
            forward.assert_not_called()
            result = self.client.post(self.base + "/encaminhar", json={"origem_id": "chat-b", "destino_id": "chat-b", "mensagens_ids": ["chat-b-message"]})
            self.assertEqual(200, result.status_code, result.text)
            self.assertEqual("chat-b", forward.call_args.args[2][0][0])

    def test_only_manager_deletes_shared_conversation_and_response_hides_owner(self):
        self.enable_box()
        self.actor = self.alice
        with patch.object(chat, "excluir_conversa", AsyncMock(return_value={"status": "sucesso", "user_id": "owner"})) as delete:
            self.assertEqual(403, self.client.delete(self.base + "/conversas/chat-b").status_code)
            delete.assert_not_called()
            self.actor = self.manager
            result = self.client.delete(self.base + "/conversas/chat-b")
            self.assertEqual({"status": "sucesso"}, result.json())

    def test_connection_projection_never_exposes_owner_qr_or_phone(self):
        self.enable_box()
        with patch.object(chat, "obter_status_canais", AsyncMock(return_value={"whatsapp": {"conectado": True, "provider": "evolution", "numero": "synthetic-number", "qrcode": "synthetic-qr", "instanceId": "private"}})):
            response = self.client.get(self.base + "/status-canais")
        self.assertEqual({"whatsapp": {"conectado": True, "provider": "evolution"}}, response.json())

    def test_details_and_opaque_reference_recheck_conversation_acl(self):
        from app.modules.whatsapp_team.context import conversation_ref
        self.assign_alice()
        self.actor = self.bob
        with patch.object(chat, "obter_detalhes_conversa", AsyncMock(return_value={"id": "chat-b", "mensagens": [{"texto": "must not leak"}], "photoUrl": "/owner-photo", "metadados": {"participantes": [{"id": "p", "photoUrl": "/owner-participant"}]}})):
            result = self.client.get(self.base + "/conversas/chat-b/detalhes")
            self.assertEqual([], result.json()["mensagens"])
            self.assertEqual(None, result.json()["metadados"]["participantes"][0]["photoUrl"])
            self.assertNotIn("owner-photo", result.text)
            self.assertEqual(404, self.client.get(self.base + "/referencias/" + conversation_ref(self.scope.inbox_id, "chat-a")).status_code)
            self.assertEqual(200, self.client.get(self.base + "/referencias/" + conversation_ref(self.scope.inbox_id, "chat-b")).status_code)

    def test_labels_deny_unreadable_contact_before_registry_query(self):
        self.assign_alice()
        self.actor = self.bob
        with patch("app.modules.business.router.contact_label_projection", AsyncMock(return_value={"items": []})) as labels:
            result = self.client.post(self.base + "/contact-labels", json={"contactIds": ["chat-a", "chat-b"]})
            self.assertEqual(404, result.status_code)
            labels.assert_not_called()
            self.assertEqual(200, self.client.post(self.base + "/contact-labels", json={"contactIds": ["chat-b"]}).status_code)

    def test_attendance_projection_contains_only_current_scope_and_private_notes(self):
        self.assign_alice()
        service.create_note(access.Access(self.alice, self.owner, self.scope, self.roster), "chat-a", body="Synthetic internal note", mentions=[])
        with patch("app.modules.whatsapp_team.presence.roster", AsyncMock(return_value=[])), patch("app.modules.whatsapp_team.presence.viewers", AsyncMock(return_value=[])):
            self.actor = self.bob
            self.assertEqual(404, self.client.get(self.base + "/conversas/chat-a/atendimento").status_code)
            self.actor = self.alice
            result = self.client.get(self.base + "/conversas/chat-a/atendimento")
            self.assertEqual(200, result.status_code, result.text)
            self.assertEqual("Synthetic internal note", result.json()["notes"]["items"][0]["body"])


if __name__ == "__main__":
    unittest.main()
