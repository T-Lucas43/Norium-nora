from __future__ import annotations

import asyncio
import copy
import os
import time
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.modules.whatsapp_team import access, context, notifications, presence, repository, retention, service
from app.modules.team import router as team
from app.modules.team import chat_presence
from app.modules.privacy.retention import maintain_retention
from tests.unit.test_whatsapp_team import Fixture


class LifecycleTests(Fixture, unittest.TestCase):
    def test_opt_in_round_robin_uses_online_candidates_and_never_reassigns_replays(self):
        now = int(time.time())
        service.sharing(self.owner_access, enabled=True, expected_revision=0, auto_distribute=True)
        first = service.received(self.scope, "new-1", message_id="msg-1", timestamp=now, online_assignees=("alice", "bob"))
        second = service.received(self.scope, "new-2", message_id="msg-2", timestamp=now, online_assignees=("alice", "bob"))
        third = service.received(self.scope, "new-3", message_id="msg-3", timestamp=now, online_assignees=("alice", "bob"))
        self.assertEqual(["alice", "bob", "alice"], [first["assigneeUserId"], second["assigneeUserId"], third["assigneeUserId"]])
        self.assertIsNone(service.received(self.scope, "new-1", message_id="msg-1", timestamp=now, online_assignees=("bob",)))
        self.assertEqual("none", service.received(self.scope, "old-history", message_id="old", timestamp=now - 10000, online_assignees=("alice",))["assigneeKind"])
        self.assertEqual("none", service.received(self.scope, "no-one-online", message_id="none", timestamp=now)["assigneeKind"])

    def test_round_robin_is_off_by_default_and_presence_is_team_workspace_scoped(self):
        self.enable()
        row = service.received(self.scope, "new", message_id="msg", timestamp=int(time.time()), online_assignees=("alice",))
        self.assertEqual("none", row["assigneeKind"])
        with patch.object(team.manager, "online_users", return_value={"alice", "bob", "foreign"}), patch.object(team, "read_chat_store", return_value={"chatPresence": {"bob": {"focus": True}}}), patch.object(chat_presence, "live_contexts", return_value={"alice": {"state": "online"}, "bob": {"state": "service"}, "foreign": {"state": "online"}}) as contexts:
            self.assertEqual(("alice",), asyncio.run(presence.available_assignees(self.owner_access)))
            contexts.assert_called_once_with("owner", "primary")

    def test_retention_trims_internal_content_but_preserves_assignment_authority(self):
        self.enable()
        service.update_assignment(self.owner_access, "chat", expected_version=0, changes={"assigneeUserId": "alice"})
        note = service.create_note(self.alice_access, "chat", body="Synthetic old note", mentions=[])
        def age(value):
            value["notes"][note["id"]]["createdAt"] = 10
            for event in value["events"].values():
                event["createdAt"] = 10
        repository.mutate(self.scope, age)
        with patch.dict(os.environ, {"NORIUM_RETENTION_ENABLED": "0"}):
            maintain_retention()
        self.assertTrue(repository.snapshot(self.scope)["notes"])
        self.assertGreater(retention.maintain(100), 0)
        value = repository.snapshot(self.scope)
        self.assertEqual({}, value["notes"])
        self.assertEqual({}, value["events"])
        self.assertEqual("alice", value["assignments"]["chat"]["assigneeUserId"])
        with self.assertRaises(HTTPException):
            access.assert_conversation(self.grant(self.bob), value, "chat")

    def test_retention_bounds_a_single_pass_and_retains_unknown_dates(self):
        self.enable()
        def seed(value):
            value["notes"] = {str(i): {"id": str(i), "createdAt": 1} for i in range(650)}
            value["notes"]["unknown"] = {"id": "unknown", "createdAt": "unknown"}
        repository.mutate(self.scope, seed)
        self.assertEqual(500, retention.maintain(100))
        self.assertEqual(151, len(repository.snapshot(self.scope)["notes"]))
        self.assertEqual(150, retention.maintain(100))
        self.assertIn("unknown", repository.snapshot(self.scope)["notes"])

    def test_presence_projects_customer_name_only_after_conversation_authorization(self):
        resource = self.scope.inbox_id + ":" + context.conversation_ref(self.scope.inbox_id, "chat")
        runtime = type("Runtime", (), {})()
        runtime.load_conversations = AsyncMock(return_value={})
        runtime.load_whatsapp_catalog_cache = AsyncMock(return_value={})
        async def authorize(actor, inbox, cid=None):
            if cid and actor["id"] == "bob":
                raise HTTPException(404)
            return self.grant(actor), {}, None
        with patch.object(context, "authorized", AsyncMock(side_effect=authorize)), patch.object(context, "runtime", return_value=runtime), patch("app.modules.chat.conversation_projection.list_page", return_value={"items": [{"id": "chat", "contato": "Synthetic Marina"}]}):
            self.assertEqual("Atendendo Synthetic Marina no WhatsApp", asyncio.run(presence.title(self.alice, resource)))
            self.assertIsNone(asyncio.run(presence.title(self.bob, resource)))
            self.assertIsNone(asyncio.run(presence.title(self.alice, "untrusted:identifier")))

    def test_live_invalidation_reaches_old_assignee_without_regranting_access(self):
        self.enable()
        service.update_assignment(self.owner_access, "chat", expected_version=0, changes={"assigneeUserId": "alice"})
        service.update_assignment(self.owner_access, "chat", expected_version=1, changes={"assigneeUserId": "bob"})
        with patch("app.modules.inbox.router.manager.broadcast", AsyncMock()) as broadcast:
            allowed = asyncio.run(notifications.emit(self.owner_access, repository.snapshot(self.scope), "chat", {"alice"}))
        self.assertNotIn("alice", allowed)
        self.assertIn("alice", [call.args[0] for call in broadcast.await_args_list])
        for call in broadcast.await_args_list:
            self.assertEqual({"type", "ownerId", "inboxId", "area"}, set(call.args[1]))

    def test_roster_uses_profile_photo_and_respects_focus(self):
        with patch.object(team, "read_chat_store", return_value={"chatPresence": {"alice": {"focus": True}}}), patch.object(team, "read_profile_db", return_value={"fotoUrl": "/synthetic-profile"}), patch.object(team.manager, "online_users", return_value={"alice", "bob"}), patch.object(chat_presence, "live_contexts", return_value={}):
            roster = asyncio.run(presence.roster(self.owner_access))
        self.assertEqual("/synthetic-profile", next(row for row in roster if row["id"] == "alice")["avatar"])
        self.assertFalse(next(row for row in roster if row["id"] == "alice")["online"])
        self.assertTrue(next(row for row in roster if row["id"] == "bob")["online"])

    def test_private_team_notice_is_idempotent_and_never_visible_to_other_member(self):
        store = {"messages": [], "subteams": []}
        def save(_, value):
            store.clear(); store.update(copy.deepcopy(value))
        async def exercise():
            with patch.object(team, "team_id_for_user_id", AsyncMock(return_value="owner")), patch.object(team, "read_user_store", AsyncMock(return_value={"users": list(self.roster)})), patch.object(team, "read_chat_store", side_effect=lambda _: copy.deepcopy(store)), patch.object(team, "write_chat_store", side_effect=save), patch.object(team.manager, "send_to_users", AsyncMock()) as send, patch.object(team, "record_team_event", AsyncMock()) as notify:
                first = await team.append_team_message_for_user("owner", "Synthetic private notice", recipient_ids={"alice"}, event_key="synthetic-note")
                second = await team.append_team_message_for_user("owner", "Synthetic private notice", recipient_ids={"alice"}, event_key="synthetic-note")
                self.assertEqual(first["id"], second["id"])
                self.assertEqual(1, len(store["messages"]))
                self.assertTrue(team.message_visible(first, "alice"))
                self.assertFalse(team.message_visible(first, "bob"))
                self.assertEqual({"alice"}, send.await_args.args[1])
                self.assertEqual(1, notify.await_count)
                with self.assertRaises(HTTPException):
                    await team.append_team_message_for_user("owner", "Denied", recipient_ids={"foreign"}, event_key="other")
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
