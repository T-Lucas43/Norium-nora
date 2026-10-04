from __future__ import annotations

import base64
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.modules.team import router as team_router


def team_user(user_id: str, *, owner_id: str | None = None) -> dict:
    return {
        "id": user_id,
        "nome": user_id.title(),
        "email": f"{user_id}@example.test",
        "status": "ativo",
        "role": "owner" if owner_id is None else "member",
        "teamOwnerId": owner_id,
        "teamChatEnabled": True,
        "permissions": {"chat": True, "equipe": True},
        "systemAdmin": False,
    }


class TeamCollaborationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="norium_team_")
        root_patch = patch("app.core.tenant.get_data_root", return_value=Path(self.temp_dir.name))
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.chat_path = Path(self.temp_dir.name) / "team_chat.json"
        self.upload_dir = Path(self.temp_dir.name) / "uploads"
        self.upload_dir.mkdir()
        self.owner = team_user("owner")
        self.member = team_user("member", owner_id="owner")
        self.member["lastLoginAt"] = "2026-09-01T14:35:00+00:00"
        self.other_member = team_user("other", owner_id="owner")
        self.users = {"users": [self.owner, self.member, self.other_member]}
        session_root = patch.object(team_router.sessions, "get_data_root", return_value=Path(self.temp_dir.name))
        session_root.start()
        self.addCleanup(session_root.stop)
        for actor in self.users["users"]:
            row, _, _ = team_router.sessions.create(actor["id"], 0)
            actor["_authSession"] = row["id"]

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_pins_persist_per_user_and_reject_inaccessible_threads(self) -> None:
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router.manager, "send_to_users", AsyncMock()),
        ):
            await team_router.pin_thread(team_router.PinThreadPayload(threadId="team", pinned=True), self.owner)
            owner_threads = (await team_router.list_threads(self.owner))["threads"]
            member_threads = (await team_router.list_threads(self.member))["threads"]
            self.assertTrue(next(item for item in owner_threads if item["id"] == "team")["pinned"])
            self.assertFalse(next(item for item in member_threads if item["id"] == "team")["pinned"])
            with self.assertRaises(HTTPException) as error:
                await team_router.pin_thread(team_router.PinThreadPayload(threadId="direct:member:other", pinned=True), self.owner)
            self.assertEqual(404, error.exception.status_code)
            await team_router.pin_thread(team_router.PinThreadPayload(threadId="team", pinned=False), self.owner)
            self.assertFalse((await team_router.list_threads(self.owner))["threads"][0]["pinned"])

    async def test_mentions_notify_only_selected_participants_and_preserve_thread_unread(self) -> None:
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()) as record,
            patch.object(team_router.manager, "send_to_users", AsyncMock()),
            patch("app.services.system_email.notify_team_participants", AsyncMock()),
        ):
            result = await team_router.send_message(team_router.SendTeamMessagePayload(
                scope="direct", recipientId="member", text="@Member, pode revisar?", mentionedUserIds=["member", "member"]
            ), self.owner)
            message = result["message"]
            self.assertEqual(["member"], message["metadata"]["mentionedUserIds"])
            self.assertEqual([{"userId": "member", "name": "Member"}], message["metadata"]["mentions"])
            mention_event = record.await_args_list[-1]
            self.assertEqual({"member"}, mention_event.kwargs["user_ids"])
            self.assertEqual("team_member_mentioned", mention_event.args[3]["action"])
            self.assertEqual("direct:member:owner", mention_event.args[3]["threadId"])
            threads = (await team_router.list_threads(self.member))["threads"]
            direct = next(item for item in threads if item["id"] == message["threadId"])
            self.assertEqual(1, direct["unreadCount"])
            self.assertEqual(message["id"], direct["lastMessage"]["id"])
            await team_router.mark_messages_read(team_router.MarkMessagesReadPayload(messageIds=[message["id"]]), self.member)
            self.assertEqual(0, next(item for item in (await team_router.list_threads(self.member))["threads"] if item["id"] == message["threadId"])["unreadCount"])
            other_threads = (await team_router.list_threads(self.other_member))["threads"]
            self.assertTrue(all(item["lastMessage"] is None for item in other_threads))

    async def test_mentions_reject_outsiders_and_ignore_deleted_or_partial_tokens(self) -> None:
        with (
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
        ):
            with self.assertRaises(HTTPException):
                await team_router.validated_mentions("@Other", ["other"], {"owner", "member"}, self.owner)
            self.assertEqual([], await team_router.validated_mentions("@Membership", ["member"], {"owner", "member"}, self.owner))
            self.assertEqual([], await team_router.validated_mentions("Já removi a menção.", ["member"], {"owner", "member"}, self.owner))

    async def test_unread_count_does_not_include_messages_outside_available_history(self) -> None:
        store = {"messages": [
            {"id": str(index), "threadId": "team", "scope": "team", "senderId": "owner", "text": str(index),
             "metadata": {"readBy": {"member": {"userName": "Member"}} if index >= 50 else {}}}
            for index in range(350)
        ]}
        with (
            patch.object(team_router, "read_chat_store", return_value=store),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
        ):
            thread = (await team_router.list_threads(self.member))["threads"][0]
            self.assertEqual(0, thread["unreadCount"])
            self.assertEqual("349", thread["lastMessage"]["id"])

    async def test_subteam_is_persisted_and_only_members_can_read_its_messages(self) -> None:
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
        ):
            created = await team_router.create_subteam(
                team_router.SubteamCreatePayload(
                    name="Comercial",
                    description="Propostas e negociacoes",
                    memberIds=["member"],
                ),
                self.owner,
            )
            subteam = created["subteam"]
            self.assertEqual({"owner", "member"}, set(subteam["memberIds"]))

            await team_router.send_subteam_message(
                subteam["id"],
                team_router.SendSubteamMessagePayload(
                    text="Revisar proposta hoje.",
                ),
                self.member,
            )
            listing = await team_router.list_subteam_messages(
                subteam_id=subteam["id"],
                user=self.owner,
            )
            self.assertEqual("Revisar proposta hoje.", listing["messages"][0]["text"])

            with self.assertRaises(HTTPException) as error:
                await team_router.list_subteam_messages(
                    subteam_id=subteam["id"],
                    user=self.other_member,
                )
            self.assertEqual(403, error.exception.status_code)

    async def test_direct_message_is_sent_only_to_its_two_participants(self) -> None:
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
            patch.object(team_router, "manager", manager),
        ):
            await team_router.send_message(
                team_router.SendTeamMessagePayload(scope="direct", recipientId="member", text="Privado"),
                self.owner,
            )

        recipients = manager.send_to_users.await_args.args[1]
        self.assertEqual({"owner", "member"}, recipients)
        self.assertNotIn("other", recipients)

    async def test_message_reactions_toggle_and_are_broadcast_only_to_thread_participants(self) -> None:
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
            patch.object(team_router, "manager", manager),
        ):
            sent = await team_router.send_message(
                team_router.SendTeamMessagePayload(scope="direct", recipientId="member", text="Pode revisar?"),
                self.owner,
            )
            message_id = sent["message"]["id"]
            manager.send_to_users.reset_mock()

            added = await team_router.toggle_message_reaction(
                message_id,
                team_router.MessageReactionPayload(emoji="👍"),
                self.member,
            )
            self.assertEqual([{"emoji": "👍", "userIds": ["member"]}], added["reactions"])
            self.assertEqual({"owner", "member"}, manager.send_to_users.await_args.args[1])
            self.assertEqual("TEAM_MESSAGE_REACTION", manager.send_to_users.await_args.args[2]["type"])

            removed = await team_router.toggle_message_reaction(
                message_id,
                team_router.MessageReactionPayload(emoji="👍"),
                self.member,
            )
            self.assertEqual([], removed["reactions"])

            with self.assertRaises(HTTPException) as error:
                await team_router.toggle_message_reaction(
                    message_id,
                    team_router.MessageReactionPayload(emoji="❤️"),
                    self.other_member,
                )
            self.assertEqual(404, error.exception.status_code)

    async def test_call_end_reaches_other_tabs_but_not_the_origin_socket(self) -> None:
        manager = team_router.PresenceManager()
        origin_socket = MagicMock()
        origin_socket.send_json = AsyncMock()
        other_owner_tab = MagicMock()
        other_owner_tab.send_json = AsyncMock()
        member_socket = MagicMock()
        member_socket.send_json = AsyncMock()
        manager.connections["owner"] = [origin_socket, other_owner_tab, member_socket]
        manager.socket_user = {
            origin_socket: "owner",
            other_owner_tab: "owner",
            member_socket: "member",
        }
        manager.user_team = {"owner": "owner", "member": "owner"}
        manager.socket_session_id = {origin_socket: self.owner["_authSession"], other_owner_tab: self.owner["_authSession"], member_socket: self.member["_authSession"]}
        event = {"type": "CALL_END", "callId": "call_0123456789abcdef"}

        with patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)):
            await manager.send_to_users(
                "owner",
                {"owner", "member"},
                event,
                exclude_websocket=origin_socket,
            )

        origin_socket.send_json.assert_not_awaited()
        other_owner_tab.send_json.assert_awaited_once_with(event)
        member_socket.send_json.assert_awaited_once_with(event)

    async def test_call_signal_fanout_revalidates_recipient_before_ice_event(self) -> None:
        manager = team_router.PresenceManager()
        member_socket = MagicMock()
        member_socket.send_json = AsyncMock()
        manager.connections["owner"] = [member_socket]
        manager.socket_user = {member_socket: "member"}
        manager.socket_connection = {member_socket: "member-connection"}
        manager.user_team = {"member": "owner"}
        manager.socket_session_id = {member_socket: self.member["_authSession"]}
        signal = {
            "type": "CALL_SIGNAL",
            "callId": "call_0123456789abcdef",
            "signal": {"candidate": "candidate-1"},
        }

        with patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)) as read_users:
            await manager.send_to_users("owner", {"member"}, signal)

        read_users.assert_awaited_once()
        member_socket.send_json.assert_awaited_once_with(signal)

    async def test_image_attachment_is_saved_and_returned_in_team_chat(self) -> None:
        image_bytes = b"\x89PNG\r\n\x1a\nteam-image"
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "UPLOAD_DIR", self.upload_dir),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
            patch.object(team_router, "manager", manager),
        ):
            result = await team_router.send_message(
                team_router.SendTeamMessagePayload(
                    scope="team",
                    text="Imagem da equipe",
                    attachments=[team_router.AttachmentPayload(
                        fileName="captura.png",
                        mimeType="image/png",
                        dataUrl=f"data:image/png;base64,{base64.b64encode(image_bytes).decode('ascii')}",
                    )],
                ),
                self.owner,
            )

        attachment = result["message"]["attachments"][0]
        self.assertEqual("image/png", attachment["mimeType"])
        self.assertEqual("captura.png", attachment["name"])
        self.assertEqual(image_bytes, (self.upload_dir / attachment["storedName"]).read_bytes())

    async def test_members_list_only_reports_active_connected_users_and_last_login(self) -> None:
        manager = team_router.PresenceManager()
        manager.user_team = {"member": "owner", "other": "owner", "unknown": "owner"}
        self.other_member["status"] = "inativo"
        with (
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "manager", manager),
        ):
            listing = await team_router.list_members(self.owner)

        self.assertEqual(["member"], listing["onlineUserIds"])
        members_by_id = {member["id"]: member for member in listing["members"]}
        self.assertTrue(members_by_id["member"]["online"])
        self.assertEqual("2026-09-01T14:35:00+00:00", members_by_id["member"]["lastLoginAt"])
        self.assertFalse(members_by_id["other"]["online"])

    async def test_team_meeting_is_scheduled_for_conversation_members_and_can_be_added_to_calendar(self) -> None:
        starts_at = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        ends_at = (datetime.now(timezone.utc) + timedelta(hours=2, minutes=45)).isoformat()
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        calendar_service = MagicMock()
        calendar_service.create_event.return_value = {
            "evento": {"id": "local_meeting_1", "source": "local", "htmlLink": None},
            "source": "local",
        }
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_event", AsyncMock()),
            patch.object(team_router, "manager", manager),
            patch.object(team_router, "CalendarService", return_value=calendar_service),
        ):
            result = await team_router.schedule_meeting(
                team_router.ScheduleMeetingPayload(
                    scope="team",
                    title="Revisao da proposta",
                    description="Validar valores finais",
                    startsAt=starts_at,
                    endsAt=ends_at,
                ),
                self.owner,
            )
            meeting = result["meeting"]
            self.assertEqual({"owner", "member", "other"}, set(meeting["participantIds"]))
            self.assertEqual("meeting_scheduled", result["message"]["metadata"]["action"])

            added = await team_router.add_scheduled_meeting_to_calendar(meeting["id"], self.member)
            self.assertEqual("local_meeting_1", added["calendarEvent"]["eventId"])
            self.assertFalse(added["alreadyAdded"])
            repeated = await team_router.add_scheduled_meeting_to_calendar(meeting["id"], self.member)
            self.assertTrue(repeated["alreadyAdded"])
            stored = team_router.read_chat_store("owner")
            self.assertEqual("local_meeting_1", stored["scheduledMeetings"][0]["calendarEntries"]["member"]["eventId"])

    async def test_meeting_reminder_is_emitted_once_ten_minutes_before_start(self) -> None:
        starts_at = datetime.now(timezone.utc) + timedelta(minutes=8)
        store = team_router.empty_store()
        store["scheduledMeetings"] = [{
            "id": "team_meeting_reminder_1",
            "threadId": "team",
            "scope": "team",
            "title": "Check-in",
            "startsAt": starts_at.isoformat(),
            "endsAt": (starts_at + timedelta(minutes=30)).isoformat(),
            "participantIds": ["owner", "member"],
            "createdBy": "owner",
            "createdByName": "Owner",
            "remindedUserIds": [],
            "status": "scheduled",
        }]
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "record_event", AsyncMock()) as record_event,
            patch.object(team_router, "manager", manager),
        ):
            team_router.write_chat_store("owner", store)
            self.assertEqual(2, await team_router.emit_due_meeting_reminders("owner", starts_at - timedelta(minutes=8)))
            self.assertEqual(0, await team_router.emit_due_meeting_reminders("owner", starts_at - timedelta(minutes=8)))
            reminded_ids = team_router.read_chat_store("owner")["scheduledMeetings"][0]["remindedUserIds"]

        self.assertEqual(2, record_event.await_count)
        self.assertEqual(["member", "owner"], reminded_ids)

    async def test_read_receipt_records_viewer_and_time_and_notifies_participants(self) -> None:
        store = team_router.empty_store()
        store["messages"] = [{
            "id": "team_msg_read_1",
            "threadId": "team",
            "scope": "team",
            "senderId": "owner",
            "recipientId": None,
            "memberIds": [],
            "text": "Mensagem importante",
            "metadata": {"readBy": {}},
        }]
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "manager", manager),
        ):
            team_router.write_chat_store("owner", store)
            result = await team_router.mark_messages_read(team_router.MarkMessagesReadPayload(messageIds=["team_msg_read_1"]), self.member)

        receipt = result["updated"][0]["readBy"]["member"]
        self.assertEqual("Member", receipt["userName"])
        self.assertTrue(receipt["viewedAt"])
        self.assertEqual("team_msg_read_1", manager.send_to_users.await_args.args[2]["messageId"])

    async def test_recording_is_uploaded_in_chunks_and_expires_after_24_hours(self) -> None:
        class ChunkRequest:
            headers = {
                "content-length": "12",
                "X-Call-Client-Id": "owner-client",
                "X-Recording-Chunk-Id": "chunk-1",
            }

            async def stream(self):
                yield b"webm-content"

        class CompleteRequest:
            headers = {
                "X-Call-Client-Id": "owner-client",
                "X-Recording-Operation-Id": "complete-1",
            }

        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "UPLOAD_DIR", self.upload_dir),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
            patch.object(team_router, "_call_coordinator_instance", None),
            patch.object(team_router, "_recording_coordinator_instance", None),
        ):
            await team_router.call_coordinator().handle_event(
                team_router.call_actor(self.owner, "owner-connection"),
                {
                    "type": "CALL_INVITE",
                    "callId": "call_0123456789abcdef",
                    "clientId": "owner-client",
                    "scope": "team",
                },
            )
            started = await team_router.start_recording(
                team_router.RecordingStartPayload(
                    callId="call_0123456789abcdef",
                    clientId="owner-client",
                    operationId="start-1",
                    scope="team",
                    mimeType="video/webm;codecs=vp8,opus",
                ),
                self.owner,
            )
            recording_id = started["recording"]["id"]
            chunk_result = await team_router.append_recording_chunk(recording_id, ChunkRequest(), self.owner)  # type: ignore[arg-type]
            self.assertEqual(12, chunk_result["received"])

            completed = await team_router.complete_recording(recording_id, CompleteRequest(), self.owner)  # type: ignore[arg-type]
            attachment = completed["message"]["attachments"][0]
            expires_at = datetime.fromisoformat(attachment["expiresAt"])
            remaining = expires_at - datetime.now(timezone.utc)
            self.assertGreater(remaining, timedelta(hours=23, minutes=59))
            recording_path = self.upload_dir / attachment["storedName"]
            self.assertEqual(b"webm-content", recording_path.read_bytes())

            store = team_router.read_chat_store("owner")
            store["messages"][-1]["attachments"][0]["expiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            store["recordings"][-1]["expiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            team_router.write_chat_store("owner", store)
            await team_router.recording_coordinator().maintain(["owner"])
            listing = await team_router.list_messages(scope="team", recipientId=None, user=self.owner)

            expired_message = listing["messages"][-1]
            self.assertEqual([], expired_message["attachments"])
            self.assertTrue(expired_message["metadata"]["recordingExpired"])
            self.assertFalse(recording_path.exists())

    async def test_active_meeting_invite_is_replayable_and_stale_meetings_are_removed(self) -> None:
        current_started_at = datetime.now(timezone.utc).isoformat()
        store = team_router.empty_store()
        store["activeCalls"] = [
            {
                "callId": "call_0123456789abcdef",
                "scope": "team",
                "threadId": "team",
                "recipientId": None,
                "subteamId": None,
                "participantIds": ["owner", "member"],
                "hostUserId": "owner",
                "hostUserName": "Owner",
                "startedAt": current_started_at,
            },
            {
                "callId": "call_fedcba9876543210",
                "scope": "direct",
                "threadId": "direct:member:owner",
                "recipientId": "member",
                "subteamId": None,
                "participantIds": ["owner", "member"],
                "hostUserId": "owner",
                "hostUserName": "Owner",
                "startedAt": (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat(),
            },
        ]

        self.assertTrue(team_router.purge_stale_active_calls(store))
        self.assertEqual(1, len(store["activeCalls"]))
        invite = team_router.active_call_invite(store["activeCalls"][0])
        self.assertEqual("CALL_INVITE", invite["type"])
        self.assertEqual("call_0123456789abcdef", invite["callId"])
        self.assertEqual(current_started_at, invite["startedAt"])


if __name__ == "__main__":
    unittest.main()
