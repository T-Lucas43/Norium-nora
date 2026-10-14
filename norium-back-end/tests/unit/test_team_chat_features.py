from __future__ import annotations
import copy
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.modules.team import router as team
from app.modules.team import chat_features as features
from app.modules.team import chat_resources as resources
from app.modules.team import chat_queue as queue
from app.modules.team import chat_presence as presence
from datetime import datetime, timedelta, timezone


def user(identifier, owner="owner"):
    return {"id": identifier, "nome": identifier.title(), "status": "ativo", "role": "member", "plan": "enterprise", "teamOwnerId": owner, "teamChatEnabled": True, "permissions": {"chat": True, "equipe": True, "tarefas": True}}


def message(identifier, thread="team", sender="owner", recipient=None):
    return {"id": identifier, "threadId": thread, "scope": "team" if thread == "team" else "direct", "senderId": sender, "senderName": sender.title(), "recipientId": recipient, "text": f"Mensagem {identifier}", "attachments": [], "metadata": {}, "createdAt": "2026-10-13T12:00:00+00:00"}


class TeamChatFeaturesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner, self.member, self.other = user("owner"), user("member"), user("other")
        self.store = {"messages": [], "subteams": []}
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(team, "read_chat_store", side_effect=lambda _: copy.deepcopy(self.store)))
        self.stack.enter_context(patch.object(team, "write_chat_store", side_effect=lambda _, data: setattr(self, "store", copy.deepcopy(data))))
        self.stack.enter_context(patch.object(team, "visible_team_members", AsyncMock(return_value=[self.owner, self.member, self.other])))
        self.stack.enter_context(patch.object(team, "user_avatar_url", return_value=""))
        self.publish = self.stack.enter_context(patch.object(team.manager, "send_to_users", AsyncMock()))
        self.notify = self.stack.enter_context(patch.object(team, "record_team_event", AsyncMock()))

    def test_pagination_preserves_legacy_and_cursors(self):
        items = [message(str(i)) for i in range(5000)]
        self.assertEqual(300, len(features.message_page(items, None, None)["messages"]))
        latest = features.message_page(items, 50, None)
        earlier = features.message_page(items, 50, latest["nextBefore"])
        self.assertEqual("4950", latest["messages"][0]["id"])
        self.assertEqual("4949", earlier["messages"][-1]["id"])
        self.assertTrue(latest["hasMore"])
        for count in (0, -1, 101):
            with self.assertRaises(HTTPException): features.message_page(items, count, None)
        with self.assertRaises(HTTPException): features.message_page(items, 50, "missing")

    async def test_edit_own_message_keeps_identity_and_receipts(self):
        original = message("m"); original["metadata"]["readBy"] = {"member": {"userName": "Member"}}
        self.store["messages"] = [original]
        result = await features.edit_message("m", features.MessageEdit(text="Novo texto"), self.owner)
        self.assertEqual("Novo texto", result["message"]["text"])
        self.assertIn("editedAt", result["message"]["metadata"])
        self.assertEqual(original["createdAt"], result["message"]["createdAt"])
        self.assertEqual(original["metadata"]["readBy"], result["message"]["metadata"]["readBy"])
        self.assertEqual({"owner", "member", "other"}, self.publish.await_args.args[1])

    async def test_edit_delete_other_and_invisible_are_denied(self):
        self.store["messages"] = [message("m"), message("private", "direct:member:other", "member", "other")]
        with self.assertRaises(HTTPException) as error: await features.delete_message("m", self.member)
        self.assertEqual(403, error.exception.status_code)
        with self.assertRaises(HTTPException) as error: await features.edit_message("private", features.MessageEdit(text="Não"), self.owner)
        self.assertEqual(404, error.exception.status_code)
        self.assertEqual("Mensagem m", self.store["messages"][0]["text"])

    async def test_soft_delete_broadcasts_tombstone_and_cannot_reedit(self):
        self.store["messages"] = [message("m")]
        result = await features.delete_message("m", self.owner)
        self.assertEqual("", result["message"]["text"])
        self.assertIn("deletedAt", result["message"]["metadata"])
        self.assertEqual(1, len(self.store["messages"]))
        with self.assertRaises(HTTPException): await features.edit_message("m", features.MessageEdit(text="Voltar"), self.owner)

    async def test_quote_is_identifier_and_cannot_cross_conversation(self):
        self.store["messages"] = [message("m"), message("private", "direct:member:other", "member", "other")]
        result = await team.send_message(team.SendTeamMessagePayload(text="Resposta", quotedMessageId="m"), self.owner)
        self.assertEqual("m", result["message"]["quotedMessageId"])
        self.assertNotIn("quotedText", result["message"])
        with self.assertRaises(HTTPException): await team.send_message(team.SendTeamMessagePayload(text="Não", quotedMessageId="private"), self.owner)

    async def test_search_filters_author_files_and_excludes_private_deleted(self):
        normal = message("m"); normal["text"] = "Proposta da Clínica"; normal["attachments"] = [{"id": "a"}]
        private = message("secret", "direct:member:other", "member", "other"); private["text"] = "Proposta secreta"
        deleted = message("gone"); deleted["metadata"]["deletedAt"] = "now"
        self.store["messages"] = [normal, private, deleted]
        result = await features.search_messages(q="clinica", authorId="owner", withFile=True, user=self.owner)
        self.assertEqual(["m"], [row["id"] for row in result["messages"]])
        result = await features.search_messages(q="", user=self.owner)
        self.assertEqual(["m"], [row["id"] for row in result["messages"]])
        with self.assertRaises(HTTPException): await features.message_context("secret", self.owner)

    async def test_replies_notify_only_participants_and_keep_old_conversation_id(self):
        self.store["messages"] = [message("root")]
        first = (await team.send_message(team.SendTeamMessagePayload(text="Primeira", replyThreadId="root"), self.member))["message"]
        self.assertEqual("team", first["threadId"])
        self.assertEqual("root", first["replyThreadId"])
        self.assertEqual({"owner", "member"}, self.notify.await_args.kwargs["user_ids"])
        self.assertEqual(1, self.store["messages"][0]["metadata"]["replyCount"])
        owned = await features.reply_threads("team", self.owner)
        self.assertEqual(1, owned["messages"][0]["metadata"]["replyUnreadCount"])
        self.assertEqual([], (await features.reply_threads("team", self.other))["messages"])
        listing = await team.list_messages(user=self.owner)
        self.assertEqual(["root"], [row["id"] for row in listing["messages"]])
        self.assertEqual(1, len((await features.replies("root", user=self.other))["messages"]))
        second = (await team.send_message(team.SendTeamMessagePayload(text="Canal", replyThreadId="root", alsoInChannel=True), self.owner))["message"]
        self.assertIn(second["id"], [row["id"] for row in (await team.list_messages(user=self.owner))["messages"]])
        self.assertEqual(2, self.store["messages"][0]["metadata"]["replyCount"])

    async def test_reply_rejects_private_root_and_nested_fio(self):
        self.store["messages"] = [message("private", "direct:member:other", "member", "other")]
        with self.assertRaises(HTTPException): await team.send_message(team.SendTeamMessagePayload(text="Não", replyThreadId="private"), self.owner)
        root = message("root"); root["replyThreadId"] = "original"; self.store["messages"] = [root]
        with self.assertRaises(HTTPException): await team.send_message(team.SendTeamMessagePayload(text="Não", replyThreadId="root"), self.owner)

    async def test_pins_persist_and_cannot_pin_private_or_deleted(self):
        self.store["messages"] = [message("m"), message("private", "direct:member:other", "member", "other")]
        await features.pin_message("m", features.MessagePin(pinned=True), self.member)
        self.assertEqual(["m"], [row["id"] for row in (await features.pinned_messages("team", self.owner))["messages"]])
        with self.assertRaises(HTTPException): await features.pin_message("private", features.MessagePin(pinned=True), self.owner)
        await features.pin_message("m", features.MessagePin(pinned=False), self.owner)
        self.assertEqual([], (await features.pinned_messages("team", self.owner))["messages"])

    async def test_resource_card_does_not_leak_restricted_task(self):
        with patch("app.modules.tasks.router.require_task_access", AsyncMock(side_effect=HTTPException(404, "secret"))):
            card = await resources.resolve_card({"type": "task", "id": "private"}, self.owner)
        self.assertEqual("Item restrito", card["title"])
        self.assertTrue(card["restricted"])
        self.assertNotIn("deepLink", card)

    async def test_resource_batch_cannot_request_private_message(self):
        self.store["messages"] = [message("private", "direct:member:other", "member", "other")]
        self.store["messages"][0]["resourceRefs"] = [{"type": "task", "id": "task-secret"}]
        with patch.object(features, "resolve_card", AsyncMock()) as resolver:
            result = await features.resource_cards(features.CardsRequest(messageIds=["private"]), self.owner)
        self.assertEqual({}, result["cards"]); resolver.assert_not_awaited()

    def test_internal_link_parsing_requires_product_origin_and_explicit_identity(self):
        self.assertEqual([{"type": "task", "id": "abc"}], resources.link_references("https://homologacao.norium-ai.com/app?resourceType=task&resourceId=abc"))
        self.assertEqual([], resources.link_references("https://evil.test/app?resourceType=task&resourceId=abc"))
        self.assertEqual([], resources.link_references("https://homologacao.norium-ai.com/app?resourceType=task&resourceId=../../secret"))

    async def test_private_source_reply_inherits_visibility_and_fanout(self):
        root = message("root"); root["privateRecipientIds"] = ["owner", "member"]
        self.store["messages"] = [root]
        reply = (await team.send_message(team.SendTeamMessagePayload(text="Resposta restrita", replyThreadId="root"), self.member))["message"]
        self.assertEqual(["member", "owner"], reply["privateRecipientIds"])
        self.assertEqual({"owner", "member"}, self.publish.await_args.args[1])
        self.assertFalse(team.message_visible(reply, "other"))
        with self.assertRaises(HTTPException): await features.replies("root", user=self.other)

    async def test_poll_votes_are_live_unique_and_acl_scoped(self):
        poll = (await features.create_poll(features.PollCreate(question="Qual horário?", options=["Manhã", "Tarde"]), self.owner))["message"]
        choices = [option["id"] for option in poll["metadata"]["poll"]["options"]]
        vote = features.PollVote(optionIds=[choices[0]])
        await features.vote_poll(poll["id"], vote, self.member)
        await features.vote_poll(poll["id"], vote, self.member)
        self.assertEqual(["member"], self.store["messages"][0]["metadata"]["poll"]["options"][0]["userIds"])
        with self.assertRaises(HTTPException): await features.vote_poll(poll["id"], features.PollVote(optionIds=choices), self.member)
        await features.vote_poll(poll["id"], features.PollVote(optionIds=[choices[1]]), self.member)
        self.assertEqual([], self.store["messages"][0]["metadata"]["poll"]["options"][0]["userIds"])
        self.assertEqual("TEAM_CHAT_MESSAGE", self.publish.await_args.args[2]["type"])

    async def test_poll_rejects_duplicate_options_and_invisible_voter(self):
        with self.assertRaises(HTTPException): await features.create_poll(features.PollCreate(question="Qual?", options=["Opção", "opcao"]), self.owner)
        private = message("poll", "direct:member:other", "member", "other"); private["metadata"]["poll"] = {"options": [{"id": "a", "text": "A", "userIds": []}]}
        self.store["messages"] = [private]
        with self.assertRaises(HTTPException): await features.vote_poll("poll", features.PollVote(optionIds=["a"]), self.owner)

    async def test_forward_retains_authenticated_attachment_references(self):
        source = message("m"); source["attachments"] = [{"id": "file", "storedName": "blob.png", "url": "/api/team-chat/attachments/blob.png"}]
        self.store["messages"] = [source]
        result = await features.forward_message("m", features.ForwardMessage(threadId="direct:member:owner"), self.owner)
        self.assertEqual(source["attachments"], result["message"]["attachments"])
        self.assertEqual("direct:member:owner", result["message"]["threadId"])
        self.assertEqual("m", result["message"]["metadata"]["forwardedFromMessageId"])
        with self.assertRaises(HTTPException): await features.forward_message("m", features.ForwardMessage(threadId="direct:member:other"), self.owner)

    def test_focus_and_channel_preferences_filter_only_notifications(self):
        store = {"chatPresence": {"member": {"focus": True, "allowUrgentMentions": True}}, "chatNotifications": {"member": {"team": {"mode": "all"}}}}
        meta = {"threadId": "team", "mentionedUserIds": ["member"]}
        self.assertFalse(presence.notification_allowed(store, "member", meta))
        self.assertTrue(presence.notification_allowed(store, "member", {**meta, "urgentMention": True}))
        store["chatNotifications"]["member"]["team"]["mode"] = "none"
        self.assertFalse(presence.notification_allowed(store, "member", {**meta, "urgentMention": True}))
        store["chatPresence"]["member"]["focus"] = False
        store["chatNotifications"]["member"]["team"]["mode"] = "mentions"
        self.assertTrue(presence.notification_allowed(store, "member", meta))
        self.assertFalse(presence.notification_allowed(store, "member", {"threadId": "team"}))

    def test_focus_status_expiration_restores_availability(self):
        past = (datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat()
        store = {"chatPresence": {"member": {"focus": True, "text": "Concentração", "emoji": "🎯", "expiresAt": past, "shareContext": False}}}
        actual = presence.active_preferences(store, "member")
        self.assertFalse(actual["focus"]); self.assertEqual("", actual["text"]); self.assertFalse(actual["shareContext"])

    async def test_presence_resource_labels_use_reader_permission(self):
        with patch.object(presence, "resolve_card", AsyncMock(return_value={"restricted": True, "title": "Nome privado"})):
            self.assertIsNone(await presence.context_title({"type": "client", "id": "secret"}, self.member, self.store))
        self.assertIsNone(await presence.context_title({"type": "conversation", "id": "direct:member:other"}, self.owner, self.store))
        self.assertEqual("Conversa privada", await presence.context_title({"type": "conversation", "id": "direct:member:other"}, self.member, self.store))

    def test_presence_expires_and_keeps_other_active_tab(self):
        before = dict(presence._contexts); presence._contexts.clear()
        try:
            key = ("owner", "primary", "member", "tab-one")
            presence._contexts[key] = {"updatedAt": 0, "state": "service"}
            presence._contexts[(*key[:3], "tab-two")] = {"updatedAt": 150, "state": "online"}
            self.assertEqual("online", presence.live_contexts("owner", "primary", 200)["member"]["state"])
            self.assertNotIn(key, presence._contexts)
            self.assertEqual({}, presence.live_contexts("owner", "primary", 400))
        finally: presence._contexts.clear(); presence._contexts.update(before)


    async def test_resource_change_has_no_fanout_to_restricted_reader(self):
        async def resolve(ref, reader): return {"restricted": reader["id"] != "member"}
        with (patch.object(team.manager, "connections", {"owner": [object()]}),
              patch.object(team.manager, "online_users", return_value=["member", "other"]),
              patch.object(team, "read_user_store", AsyncMock(return_value={"users": [self.owner, self.member, self.other]})),
              patch.object(team, "team_id_for_user_id", AsyncMock(return_value="owner")),
              patch.object(resources, "resolve_card", side_effect=resolve),
              patch.object(team.manager, "broadcast", AsyncMock()) as broad):
            await resources.publish_resource_change({"userId": "member", "clientId": "shared-client"})
        broad.assert_not_awaited()
        self.assertEqual(1, self.publish.await_count)
        self.assertEqual({"member"}, self.publish.await_args.args[1])
        self.assertEqual({"type": "TEAM_RESOURCE_CHANGED", "resourceRefs": [{"type": "client", "id": "shared-client"}]}, self.publish.await_args.args[2])

    async def test_attachment_catalog_pages_full_history_without_private_data(self):
        rows = [message(str(index)) for index in range(45)]
        for index, row in enumerate(rows): row["attachments"] = [{"id": f"file-{index}", "name": f"foto-{index}.png", "mimeType": "image/png", "storedName": "private-internal-name", "url": "/api/team-chat/attachments/private.png"}]
        secret = message("secret", "direct:member:other", "member", "other")
        secret["attachments"] = [{"id": "hidden", "name": "private.png", "mimeType": "image/png"}]
        self.store["messages"] = [*rows, secret]
        first = await features.conversation_attachments("team", photos=True, user=self.owner)
        second = await features.conversation_attachments("team", photos=True, offset=30, user=self.owner)
        self.assertEqual(30, len(first["attachments"])); self.assertEqual(15, len(second["attachments"]))
        self.assertEqual(45, first["total"]); self.assertTrue(first["hasMore"])
        self.assertFalse(second["hasMore"])
        self.assertNotIn("storedName", first["attachments"][0])
        self.assertNotIn("hidden", [item["id"] for item in first["attachments"]])

    def test_thumbnail_is_bounded_and_invalid_bytes_rejected(self):
        from io import BytesIO
        from PIL import Image
        from app.modules.team.chat_thumbnails import thumbnail
        original = BytesIO(); Image.new("RGB", (1600, 1200), "#2563eb").save(original, "PNG")
        result = Image.open(BytesIO(thumbnail(original.getvalue())))
        self.assertLessEqual(max(result.size), 480); self.assertEqual("WEBP", result.format)
        with self.assertRaises(HTTPException): thumbnail(b"not an image")

    def test_legacy_shared_entity_links_become_authorized_references(self):
        self.assertEqual([{"type": "client", "id": "shared"}], resources.message_refs({"metadata": {"deepLink": {"tab": "Clientes", "entityType": "client", "entityId": "shared"}}}))

    def test_privacy_export_and_purge_cover_scheduled_and_preferences(self):
        from app.modules.privacy import shared_data
        payload = {"messages": [message("mine", sender="member")], "chatScheduled": [{"id": "mine", "authorId": "member", "message": {"text": "Scheduled"}}, {"id": "other", "authorId": "other"}], "chatReminders": [{"id": "mine", "userId": "member"}], "chatPresence": {"member": {"focus": True}, "other": {"focus": False}}, "chatNotifications": {"member": {"team": {"mode": "none"}}}}
        with patch.object(shared_data, "personal_documents", return_value=[("user_owner/team_chat_db.json", payload)]), patch.object(shared_data, "write_json_file") as write:
            exported, _ = shared_data.personal_team_messages(self.member)
            self.assertTrue(any(row.get("kind") == "chatScheduled" for row in exported)); write.assert_not_called()
            shared_data.personal_team_messages(self.member, purge=True)
        self.assertEqual(["other"], [row["id"] for row in payload["chatScheduled"]])
        self.assertNotIn("member", payload["chatPresence"])
        self.assertIn("other", payload["chatPresence"])
        self.assertEqual([], payload["chatReminders"])
        self.assertEqual("deleted", payload["messages"][0]["senderId"])

    def test_privacy_exports_only_the_members_vote(self):
        from app.modules.privacy import shared_data
        poll = message("poll"); poll["metadata"]["poll"] = {"options": [{"id": "one", "userIds": ["member", "other"]}]}
        with patch.object(shared_data, "personal_documents", return_value=[("user_owner/team_chat_db.json", {"messages": [poll]})]):
            exported, _ = shared_data.personal_team_messages(self.member)
        self.assertEqual([{"kind": "pollVote", "messageId": "poll", "optionId": "one"}], exported)
        self.assertEqual(["member", "other"], poll["metadata"]["poll"]["options"][0]["userIds"])


class TeamChatQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        TeamChatFeaturesTests.setUp(self)
        self.index = {"groups": {}}
        self.stack.enter_context(patch.object(queue, "enabled", return_value=True))
        self.stack.enter_context(patch.object(queue, "read_index", side_effect=lambda: copy.deepcopy(self.index)))
        self.stack.enter_context(patch.object(queue, "write_index", side_effect=lambda value: setattr(self, "index", copy.deepcopy(value))))
        self.stack.enter_context(patch.object(team, "record_event", AsyncMock()))

    def payload(self, **extra):
        return queue.ScheduledMessage(requestId="operation_synthetic_123", dueAt=(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(), text="Mensagem agendada sintética", **extra)

    def test_schedule_attachment_schema_rejects_invalid_shapes_before_execution(self):
        from pydantic import ValidationError
        for attachment in ({"fileName": {}}, {"fileName": "arquivo.txt", "dataUrl": "short"}, {"fileName": "arquivo.txt", "dataUrl": "data:text/plain;base64,SGk=", "unexpected": True}):
            with self.assertRaises(ValidationError): self.payload(attachments=[attachment])

    async def test_scheduled_message_is_private_and_persists_one_delivery_after_restart(self):
        payload = self.payload()
        first = (await queue.schedule_message(payload, self.owner))["scheduled"]
        second = (await queue.schedule_message(payload, self.owner))["scheduled"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(1, len(self.store["chatScheduled"]))
        self.assertEqual([], self.store["messages"])
        self.assertEqual([], (await queue.scheduled_messages(user=self.member))["scheduled"])
        now = datetime.now(timezone.utc)+timedelta(hours=2)
        users = {actor["id"]: actor for actor in [self.owner, self.member, self.other]}
        await queue.dispatch_group("owner", users, now)
        # Reconstructing the serialized document simulates a fresh process state.
        self.store = copy.deepcopy(self.store)
        await queue.dispatch_group("owner", users, now+timedelta(minutes=5))
        self.assertEqual(1, len(self.store["messages"]))
        self.assertEqual("sent", self.store["chatScheduled"][0]["state"])
        self.assertEqual(1, self.publish.await_count)

    async def test_schedule_cancellation_is_author_only_and_never_delivers(self):
        job = (await queue.schedule_message(self.payload(), self.owner))["scheduled"]
        with self.assertRaises(HTTPException): await queue.cancel_schedule(job["id"], self.member)
        await queue.cancel_schedule(job["id"], self.owner)
        await queue.dispatch_group("owner", {"owner": self.owner}, datetime.now(timezone.utc)+timedelta(days=1))
        self.assertEqual([], self.store["messages"])
        self.assertEqual("cancelled", self.store["chatScheduled"][0]["state"])

    async def test_schedule_rechecks_current_permission_and_due_time(self):
        job = (await queue.schedule_message(self.payload(), self.owner))["scheduled"]
        users = {"owner": {**self.owner, "teamChatEnabled": False}}
        await queue.dispatch_group("owner", users, datetime.now(timezone.utc)+timedelta(minutes=10))
        self.assertEqual("pending", self.store["chatScheduled"][0]["state"])
        await queue.dispatch_group("owner", users, datetime.now(timezone.utc)+timedelta(hours=2))
        self.assertEqual("blocked", self.store["chatScheduled"][0]["state"])
        self.assertEqual([], self.store["messages"])
        with self.assertRaises(HTTPException): await queue.edit_schedule(job["id"], queue.ScheduleEdit(text="Não", dueAt=self.payload().dueAt), self.owner)

    async def test_reminder_delivers_once_with_stable_event_identity(self):
        self.store["messages"] = [message("m")]
        due = (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()
        item = (await queue.remind_message("m", queue.Reminder(dueAt=due), self.owner))["reminder"]
        now = datetime.now(timezone.utc)+timedelta(hours=2)
        await queue.dispatch_group("owner", {"owner": self.owner}, now)
        await queue.dispatch_group("owner", {"owner": self.owner}, now)
        self.assertEqual(1, team.record_event.await_count)
        self.assertEqual(item["id"], team.record_event.await_args.kwargs["event_id"])
        self.assertEqual("delivered", self.store["chatReminders"][0]["state"])
