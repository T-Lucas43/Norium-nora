from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, WebSocketDisconnect
from app.modules.team import router as team


def member(user_id: str, owner_id: str = "owner") -> dict:
    return {"id": user_id, "nome": user_id.title(), "teamOwnerId": owner_id,
            "status": "ativo", "permissions": {"chat": True}}


class TeamCallLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="norium_call_lifecycle_")
        self.owner, self.member, self.other = member("owner"), member("member"), member("other")
        self.manager = team.PresenceManager()
        self.manager.send_to_users = AsyncMock()
        self.socket = MagicMock()
        self.socket.send_json = AsyncMock()
        self.patches = [
            patch.object(team, "team_chat_path", return_value=str(Path(self.temp.name) / "team_chat.json")),
            patch.object(team, "read_user_store", AsyncMock(return_value={"users": [self.owner, self.member, self.other]})),
            patch.object(team, "read_profile_db", return_value={}),
            patch.object(team, "manager", self.manager),
        ]
        for item in self.patches:
            item.start()
        self.invite = {"type": "CALL_INVITE", "callId": "call_0123456789abcdef",
                       "scope": "team", "clientId": "owner-tab"}

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def send(self, event: str, user=None, **extra):
        await team.handle_call_event(self.socket, user or self.owner, {**self.invite, "type": event, **extra})

    async def test_concurrent_start_reserves_only_one_call_per_thread(self):
        await asyncio.gather(
            self.send("CALL_INVITE"),
            self.send("CALL_INVITE", self.member, callId="call_fedcba9876543210", clientId="member-tab"),
        )
        store = team.read_chat_store("owner")
        self.assertEqual(1, len(store["activeCalls"]))
        self.assertEqual(1, len(store["messages"]))
        self.assertTrue(any(call.args[0]["type"] == "CALL_ACTIVE" for call in self.socket.send_json.call_args_list))

    async def test_media_state_is_validated_and_only_sent_to_joined_users(self):
        await self.send("CALL_INVITE")
        await self.send("CALL_ACCEPT", self.member, clientId="member-tab")
        self.manager.send_to_users.reset_mock()
        await self.send("CALL_MEDIA_STATE", cameraEnabled=False, screenSharing=False)
        sent = self.manager.send_to_users.call_args.args
        self.assertEqual({"member"}, sent[1])
        self.assertIs(False, sent[2]["cameraEnabled"])
        self.assertIs(False, sent[2]["screenSharing"])
        with self.assertRaises(HTTPException):
            await self.send("CALL_MEDIA_STATE", cameraEnabled="false", screenSharing=False)
        self.manager.send_to_users.reset_mock()
        await self.send("CALL_MEDIA_STATE", self.other, clientId="other-tab", cameraEnabled=True, screenSharing=True)
        self.manager.send_to_users.assert_not_awaited()

    async def test_end_is_idempotent_deletes_state_and_cancels_all_invites(self):
        await self.send("CALL_INVITE")
        await self.send("CALL_ACCEPT", self.member, clientId="member-tab")
        self.manager.send_to_users.reset_mock()
        await team.delete_active_call(self.invite["callId"], self.owner)
        await self.send("CALL_END")
        store = team.read_chat_store("owner")
        self.assertEqual([], store["activeCalls"])
        self.assertIn(self.invite["callId"], store["endedCallIds"])
        self.assertEqual(1, sum(message["metadata"]["action"] == "call_ended" for message in store["messages"]))
        ended = [call for call in self.manager.send_to_users.call_args_list if call.args[2]["type"] == "CALL_END"]
        self.assertEqual(1, len(ended))
        self.assertEqual({"owner", "member", "other"}, ended[0].args[1])
        self.assertEqual([], (await team.list_active_calls(self.member))["calls"])

    async def test_late_invite_accept_and_signal_cannot_resurrect_ended_call(self):
        await self.send("CALL_INVITE")
        await self.send("CALL_END")
        self.manager.send_to_users.reset_mock()
        for event in ("CALL_INVITE", "CALL_ACCEPT", "CALL_SIGNAL"):
            await self.send(event)
            self.assertEqual("CALL_END", self.socket.send_json.call_args.args[0]["type"])
        self.assertEqual([], team.read_chat_store("owner")["activeCalls"])
        self.manager.send_to_users.assert_not_awaited()

    async def test_only_organizer_can_end_and_direct_call_is_private(self):
        await self.send("CALL_INVITE", scope="direct", recipientId="member")
        self.assertEqual([], (await team.list_active_calls(self.other))["calls"])
        with self.assertRaises(HTTPException) as error:
            await team.delete_active_call(self.invite["callId"], self.member)
        self.assertEqual(403, error.exception.status_code)
        with self.assertRaises(HTTPException):
            await self.send("CALL_ACCEPT", self.other, clientId="other-tab")
        self.assertEqual(1, len(team.read_chat_store("owner")["activeCalls"]))

    async def test_reject_does_not_delete_call_and_late_join_targets_joined_members(self):
        await self.send("CALL_INVITE")
        await self.send("CALL_REJECT", self.member, clientId="member-tab")
        self.assertEqual(1, len((await team.list_active_calls(self.member))["calls"]))
        self.manager.send_to_users.reset_mock()
        await self.send("CALL_ACCEPT", self.member, clientId="member-tab")
        accepted = [call for call in self.manager.send_to_users.call_args_list if call.args[2]["type"] == "CALL_ACCEPT"]
        self.assertEqual({"owner"}, accepted[0].args[1])
        await self.send("CALL_LEAVE", self.member, clientId="member-tab")
        self.assertEqual(["owner"], (await team.list_active_calls(self.owner))["calls"][0]["joinedUserIds"])

    async def test_old_tab_cannot_send_media_or_heartbeat_after_transfer(self):
        await self.send("CALL_INVITE")
        await self.send("CALL_ACCEPT", clientId="new-owner-tab")
        self.manager.send_to_users.reset_mock()
        await self.send("CALL_HEARTBEAT")
        self.assertEqual("CALL_SESSION", self.socket.send_json.call_args.args[0]["type"])
        self.manager.send_to_users.assert_not_awaited()

    async def test_heartbeat_keeps_call_and_abandoned_call_expires(self):
        await self.send("CALL_INVITE")
        store = team.read_chat_store("owner")
        store["activeCalls"][0]["startedAt"] = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
        team.write_chat_store("owner", store)
        await self.send("CALL_HEARTBEAT")
        self.assertEqual(1, len((await team.list_active_calls(self.owner))["calls"]))
        store = team.read_chat_store("owner")
        store["activeCalls"][0]["lastHeartbeatAt"] = (datetime.now(timezone.utc) - timedelta(seconds=91)).isoformat()
        team.write_chat_store("owner", store)
        self.assertEqual([], (await team.list_active_calls(self.owner))["calls"])
        self.assertIn(self.invite["callId"], team.read_chat_store("owner")["endedCallIds"])

    async def test_reconnect_sends_preview_snapshot_not_a_ringing_invite(self):
        await self.send("CALL_INVITE")
        socket = MagicMock()
        socket.accept = AsyncMock()
        socket.send_json = AsyncMock()
        socket.receive_text = AsyncMock(side_effect=WebSocketDisconnect())
        with (
            patch.object(team, "user_from_websocket_ticket", AsyncMock(return_value=self.member)),
            patch.object(team, "emit_due_meeting_reminders", AsyncMock()),
        ):
            await team.team_chat_ws(socket, "test-ticket")
        types = [call.args[0]["type"] for call in socket.send_json.call_args_list]
        self.assertIn("CALLS_STATE", types)
        self.assertNotIn("CALL_INVITE", types)
        snapshot = next(call.args[0] for call in socket.send_json.call_args_list if call.args[0]["type"] == "CALLS_STATE")
        self.assertEqual(self.invite["callId"], snapshot["calls"][0]["callId"])
