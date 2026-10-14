from __future__ import annotations
import copy
import base64
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.modules.team import router as d, chat_nora as n
from app.modules.nora.brain.conversation import answer_from_context
from app.modules.nora.brain.contracts import BrainError
from tests import test_team_collaboration as base_fixture


class TeamChatNoraTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await base_fixture.TeamCollaborationTests.asyncSetUp(self)
        for actor in self.users["users"]:
            actor["permissions"].update(nora=True, central=True, tarefas=True, propostas=True)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(d, "team_chat_path", return_value=str(self.chat_path)))
        self.stack.enter_context(patch.object(d, "read_user_store", AsyncMock(return_value=self.users)))
        self.stack.enter_context(patch.object(d, "read_profile_db", return_value={}))
        self.fanout = self.stack.enter_context(patch.object(d.manager, "send_to_users", AsyncMock()))
        self.stack.enter_context(patch.object(d, "record_team_event", AsyncMock()))
        async def live(scope):
            actor = next((copy.deepcopy(item) for item in self.users["users"] if item["id"] == scope.user), None)
            if not actor or actor.get("status") != "ativo" or not actor["permissions"].get("nora"):
                raise BrainError("permission_revoked", 403)
            return actor
        self.stack.enter_context(patch.object(n, "live_user", side_effect=live))
        self.gateway = self.stack.enter_context(patch.object(n.nora_service, "perguntar_nora", AsyncMock(return_value="Resumo preparado para revisão.")))

    async def asyncTearDown(self):
        await base_fixture.TeamCollaborationTests.asyncTearDown(self)

    def message(self, mid="source", scope="team", **changes):
        value = {"id": mid, "threadId": "team", "scope": scope, "senderId": "member", "senderName": "Ana",
                 "text": "Precisamos revisar a proposta.", "attachments": [], "metadata": {}, "createdAt": d.now_iso()}
        if scope == "direct":
            value.update(threadId="direct:member:owner", recipientId="owner")
        if scope == "subteam":
            value.update(threadId="subteam:group", subteamId="group", memberIds=["owner", "member"])
        value.update(changes)
        return value

    def save(self, messages, **changes):
        d.write_chat_store("owner", {**d.empty_store(), "messages": messages, **changes})

    async def test_context_is_bounded_minimized_and_no_raw_attachments_are_sent(self):
        rows = [self.message(str(i), text="Contato CPF 123.456.789-09", attachments=[{"url": "https://secret.test", "dataUrl": "RAW"}]) for i in range(30)]
        self.save(rows)
        await n.respond(self.owner, "29")
        prompt = self.gateway.await_args.args[0][0]["content"]
        self.assertNotIn("123.456.789-09", prompt)
        self.assertNotIn("secret.test", prompt)
        self.assertNotIn("RAW", prompt)
        self.assertEqual(12, prompt.count('"source":'))
        self.assertEqual("owner", self.gateway.await_args.kwargs["user_id"])
        self.assertEqual("routine", self.gateway.await_args.kwargs["purpose"])

    async def test_direct_nora_reply_stays_in_direct_and_only_participants_can_read(self):
        self.save([self.message("direct", "direct"), self.message("other-private", threadId="direct:member:other", scope="direct", recipientId="other", text="OTHER SECRET")])
        reply = await n.respond(self.owner, "direct")
        self.assertEqual("direct:member:owner", reply["threadId"])
        self.assertTrue(d.message_visible(reply, "owner"))
        self.assertTrue(d.message_visible(reply, "member"))
        self.assertFalse(d.message_visible(reply, "other"))
        self.assertNotIn("OTHER SECRET", self.gateway.await_args.args[0][0]["content"])
        self.assertEqual({"owner", "member"}, self.fanout.await_args.args[1])

    async def test_sensitive_context_produces_private_reply_and_sources(self):
        self.save([self.message("hidden", privateRecipientIds=["member"], text="PRIVATE SECRET"), self.message("source", activityRecipientIds=["owner"], resourceRefs=[{"type": "task", "id": "limited"}])])
        reply = await n.respond(self.owner, "source")
        self.assertEqual(["owner"], reply["privateRecipientIds"])
        self.assertFalse(d.message_visible(reply, "member"))
        self.assertEqual(["source"], [item["messageId"] for item in reply["metadata"]["noraSources"]])
        self.assertNotIn("PRIVATE SECRET", self.gateway.await_args.args[0][0]["content"])

    async def test_disabled_subteam_and_missing_permission_do_not_call_ai(self):
        self.save([self.message("group-msg", "subteam")], subteams=[{"id": "group", "memberIds": ["owner", "member"], "createdBy": "owner", "noraEnabled": False}])
        with self.assertRaises(HTTPException):
            await n.respond(self.owner, "group-msg")
        self.owner["permissions"]["nora"] = False
        with self.assertRaises(HTTPException):
            await n.catch_up(n.CatchUp(), self.owner)
        self.gateway.assert_not_awaited()

    async def test_member_cannot_toggle_group_nora_and_owner_can(self):
        self.save([], subteams=[{"id": "group", "memberIds": ["owner", "member"], "createdBy": "owner"}])
        with self.assertRaises(HTTPException) as error:
            await n.set_nora_enabled("group", n.NoraSetting(enabled=False), self.member)
        self.assertEqual(403, error.exception.status_code)
        result = await n.set_nora_enabled("group", n.NoraSetting(enabled=False), self.owner)
        self.assertFalse(result["subteam"]["noraEnabled"])

    async def test_revocation_after_ai_discards_answer_without_fanout(self):
        self.save([self.message()])
        async def revoke(*args, **kwargs):
            self.owner["permissions"]["nora"] = False
            return "PRIVATE OUTPUT"
        self.gateway.side_effect = revoke
        with self.assertRaises(HTTPException):
            await n.respond(self.owner, "source")
        self.assertEqual(1, len(d.read_chat_store("owner")["messages"]))
        self.fanout.assert_not_awaited()

    async def test_deleted_source_after_ai_discards_answer(self):
        self.save([self.message()])
        async def remove(*args, **kwargs):
            self.save([self.message(metadata={"deletedAt": d.now_iso()})])
            return "OUTPUT"
        self.gateway.side_effect = remove
        with self.assertRaises(HTTPException):
            await n.respond(self.owner, "source")
        self.fanout.assert_not_awaited()

    async def test_catch_up_only_unread_readable_and_returns_to_requester(self):
        self.save([self.message("visible"), self.message("private-other", "direct", threadId="direct:member:other", recipientId="other", text="SECRET"), self.message("read", metadata={"readBy": {"owner": {}}})])
        result = await n.catch_up(n.CatchUp(hours=8), self.owner)
        self.assertEqual(1, result["messageCount"])
        self.assertEqual("visible", result["sources"][0]["messageId"])
        self.assertNotIn("SECRET", self.gateway.await_args.args[0][0]["content"])
        self.fanout.assert_not_awaited()
        self.assertEqual(3, len(d.read_chat_store("owner")["messages"]))

    async def test_mark_read_respects_snapshot_and_private_threads(self):
        cutoff = datetime.now(timezone.utc)
        self.save([self.message("old", createdAt=(cutoff-timedelta(minutes=1)).isoformat()), self.message("new", createdAt=(cutoff+timedelta(seconds=1)).isoformat()), self.message("other", "direct", threadId="direct:member:other", recipientId="other", createdAt=(cutoff-timedelta(minutes=1)).isoformat())])
        await n.mark_caught_up(n.MarkCaughtUp(through=cutoff.isoformat()), self.owner)
        rows = d.read_chat_store("owner")["messages"]
        self.assertIn("owner", rows[0]["metadata"]["readBy"])
        self.assertNotIn("readBy", rows[1]["metadata"])
        self.assertNotIn("readBy", rows[2]["metadata"])

    async def test_reply_in_fio_keeps_root_and_private_reply_does_not_change_public_counter(self):
        self.save([self.message("root"), self.message("reply", replyThreadId="root")])
        answer = await n.respond(self.owner, "reply", private=True)
        self.assertEqual("root", answer["replyThreadId"])
        self.assertNotIn("replyCount", d.read_chat_store("owner")["messages"][0]["metadata"])

    async def test_exact_client_email_prepares_approval_without_send(self):
        self.save([self.message()])
        with patch("app.modules.clients.access.find_accessible_client", AsyncMock(return_value=("owner", [], 0, {"id": "client", "email": "client@example.test"}))), patch("app.modules.operations.service.create_exact_email_approval", AsyncMock(return_value={"id": "approval", "digest": "exact"})) as prepare:
            result = await n.prepare_client_send("source", n.ClientSend(clientId="client", channel="email", subject="Proposta", body="Texto revisado"), self.owner)
        self.assertFalse(result["sent"])
        self.assertEqual(["client@example.test"], prepare.await_args.args[1]["to"])
        self.assertEqual("Texto revisado", prepare.await_args.args[1]["body"])
        self.gateway.assert_not_awaited()

    async def test_client_approval_rejects_inaccessible_source_before_factory(self):
        self.save([self.message("private", "direct", threadId="direct:member:other", recipientId="other")])
        with patch("app.modules.operations.service.create_exact_email_approval", AsyncMock()) as prepare:
            with self.assertRaises(HTTPException):
                await n.prepare_client_send("private", n.ClientSend(clientId="client", channel="email", subject="Assunto", body="Texto"), self.owner)
        prepare.assert_not_awaited()

    async def test_unapproved_context_provider_and_too_large_prompt_do_not_call(self):
        gateway = AsyncMock(provider="google")
        with self.assertRaises(HTTPException):
            await answer_from_context(self.owner, "context", gateway)
        gateway.provider = "groq"
        with self.assertRaises(HTTPException):
            await answer_from_context(self.owner, "x"*8001, gateway)
        gateway.perguntar_nora.assert_not_awaited()

    async def test_audio_requires_source_access_before_provider(self):
        self.save([self.message("private", "direct", threadId="direct:member:other", recipientId="other", attachments=[{"id": "audio", "mimeType": "audio/webm"}])])
        with patch("app.modules.nora.router.transcrever_voz_nora", AsyncMock()) as transcribe:
            with self.assertRaises(HTTPException):
                await n.transcribe_attachment("private", "audio", self.owner)
        transcribe.assert_not_awaited()

    async def test_private_nora_reply_does_not_leak_into_later_public_fio_counter(self):
        self.save([self.message("root"), self.message("private-answer", senderId="nora", replyThreadId="root", privateRecipientIds=["owner"])])
        await d.persist_message(scope="team", recipient_id=None, subteam_id=None, text="Resposta pública", attachment_payloads=[], user=self.member, reply_thread_id="root")
        root = d.read_chat_store("owner")["messages"][0]
        self.assertEqual(1, root["metadata"]["replyCount"])
        self.assertNotIn("nora", root["metadata"]["replyUserIds"])

    async def test_readonly_entry_rejects_unproven_execution_claim(self):
        for claim in ("Enviei o e-mail para o cliente.", "Tarefa criada com sucesso."):
            self.gateway.return_value = claim
            result = await answer_from_context(self.owner, "Prepare uma proposta", n.nora_service)
            self.assertIn("Nenhuma ação foi executada", result.text)

    async def test_whatsapp_preparation_binds_resolved_contact_without_send(self):
        self.save([self.message()])
        with patch("app.modules.clients.access.find_accessible_client", AsyncMock(return_value=("owner", [], 0, {"id": "client", "phone": "+5511999999999"}))), patch("app.services.nora_whatsapp_action.resolve_whatsapp_recipient", AsyncMock(return_value={"status": "resolved", "conversation_id": "contact", "display_name": "Cliente", "is_group": False})), patch("app.modules.operations.service.create_exact_whatsapp_approval", AsyncMock(return_value={"id": "approval"})) as prepare:
            result = await n.prepare_client_send("source", n.ClientSend(clientId="client", channel="whatsapp", body="Texto revisado"), self.owner)
        self.assertFalse(result["sent"])
        self.assertEqual("contact", prepare.await_args.args[1]["conversationId"])

    async def test_source_from_another_team_is_not_readable(self):
        self.save([self.message()])
        outsider = {**self.member, "id": "outside", "teamOwnerId": "another"}
        self.users["users"].append(outsider)
        with patch.object(d, "read_chat_store", return_value=d.empty_store()):
            with self.assertRaises(HTTPException) as error:
                await n.respond(outsider, "source")
        self.assertEqual(404, error.exception.status_code)
        self.gateway.assert_not_awaited()

    async def test_transcription_real_ledger_records_decoder_tokens_and_unpriced_cost(self):
        from app.services import ai_costs, nora_transcription as stt
        from tests.unit.test_nora_transcription import _Client, _Response
        client = _Client([_Response(200, {"text": "Áudio sintético", "segments": [{"tokens": [1, 2, 3, 4]}]})])
        with patch.dict("os.environ", {"GROQ_API_KEY": "test-key", "NORIUM_AI_PROVIDER_POLICY": ""}), patch.object(stt.httpx, "AsyncClient", return_value=client), patch.object(ai_costs, "get_data_root", return_value=self.chat_path.parent), patch.object(ai_costs, "notify_usage", AsyncMock()):
            result = await stt.transcribe(base64.b64encode(b"audio"*20).decode(), "audio/webm", self.owner)
            with ai_costs.database() as db:
                row = db.execute("SELECT * FROM usage WHERE user_id=?", (self.owner["id"],)).fetchone()
                pending = db.execute("SELECT COUNT(*) FROM reservations").fetchone()[0]
        self.assertEqual(4, row["output_tokens"])
        self.assertEqual(0, row["input_tokens"])
        self.assertEqual(0, row["estimated"])
        self.assertIsNone(row["cost_nano"])
        self.assertEqual(0, pending)
        self.assertFalse(result["usage"]["estimated"])

    async def test_focused_question_includes_the_selected_nora_message(self):
        source = self.message("nora-source", senderId="nora", text="PROPOSTA ANTERIOR", privateRecipientIds=["owner"])
        self.save([self.message("first"), source, self.message("later", text="ASSUNTO POSTERIOR")])
        await n.respond(self.owner, "nora-source", "Explique esta proposta.", private=True)
        prompt = self.gateway.await_args.args[0][0]["content"]
        self.assertIn("PROPOSTA ANTERIOR", prompt)
        self.assertNotIn("ASSUNTO POSTERIOR", prompt)

    async def test_revoked_subteam_reader_does_not_receive_new_nora_reply(self):
        self.save([self.message("group-source", "subteam")], subteams=[{"id": "group", "memberIds": ["owner"], "createdBy": "owner", "noraEnabled": True}])
        answer = await n.respond(self.owner, "group-source")
        self.assertEqual(["owner"], answer["memberIds"])
        self.assertEqual({"owner"}, self.fanout.await_args.args[1])

    async def test_restricted_metadata_changed_during_ai_forces_private_output(self):
        self.save([self.message()])
        async def restrict(*args, **kwargs):
            self.save([self.message(privateRecipientIds=["owner"])])
            return "Saída privada"
        self.gateway.side_effect = restrict
        answer = await n.respond(self.owner, "source")
        self.assertEqual(["owner"], answer["privateRecipientIds"])
