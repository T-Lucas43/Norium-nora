from __future__ import annotations

import asyncio
import copy
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any

from app.modules.team.call_coordinator import (
    CallActor,
    CallCoordinator,
    CallError,
    CallState,
    TeamCallAuthorizer,
)


class MemoryCallStore:
    def __init__(self) -> None:
        self.states: dict[str, CallState] = {}
        self.messages: dict[str, list[dict[str, Any]]] = {}
        self.loads = 0
        self.saves = 0

    async def load(self, team_id: str) -> CallState:
        self.loads += 1
        return self.states.get(team_id, CallState()).clone()

    async def save(
        self,
        team_id: str,
        state: CallState,
        *,
        append_messages: tuple[dict[str, Any], ...] = (),
    ) -> None:
        self.saves += 1
        self.states[team_id] = state.clone()
        self.messages.setdefault(team_id, []).extend(copy.deepcopy(append_messages))


class MemoryPublisher:
    def __init__(self) -> None:
        self.sent: list[tuple[str, set[str], dict[str, Any]]] = []
        self.online: dict[str, list[str]] = {}

    async def send_to_users(self, team_id: str, user_ids: set[str], payload: dict[str, Any]) -> None:
        self.sent.append((team_id, set(user_ids), copy.deepcopy(payload)))

    async def online_users(self, team_id: str) -> list[str]:
        return list(self.online.get(team_id, []))


class MemoryDirectory:
    def __init__(self) -> None:
        self.members = {"owner", "member", "other"}
        self.subteams = {"sales": {"owner", "member"}}

    async def active_member_ids(self, actor: CallActor) -> set[str]:
        return set(self.members)

    async def subteam_member_ids(self, actor: CallActor, subteam_id: str) -> set[str] | None:
        members = self.subteams.get(subteam_id)
        return set(members) if members is not None else None


class FakeClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 9, 3, 18, 0, tzinfo=timezone.utc)

    def now(self) -> datetime:
        return self.value

    def advance(self, **kwargs: int) -> None:
        self.value += timedelta(**kwargs)


def actor(user_id: str) -> CallActor:
    return CallActor(user_id=user_id, team_id="owner", name=user_id.title())


def event(event_type: str, call_id: str = "call_0123456789abcdef", **extra: Any) -> dict[str, Any]:
    return {
        "type": event_type,
        "callId": call_id,
        "scope": "team",
        "clientId": f"{extra.pop('client', 'owner')}-tab",
        **extra,
    }


class CallCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.store = MemoryCallStore()
        self.publisher = MemoryPublisher()
        self.directory = MemoryDirectory()
        self.clock = FakeClock()
        self.coordinator = CallCoordinator(
            store=self.store,
            publisher=self.publisher,
            authorizer=TeamCallAuthorizer(self.directory),
            clock=self.clock,
            message_id_factory=lambda: "team_msg_fixed",
        )
        self.owner = actor("owner")
        self.member = actor("member")
        self.other = actor("other")

    async def test_concurrent_invites_reserve_only_one_call_per_thread(self) -> None:
        first, second = await asyncio.gather(
            self.coordinator.handle_event(self.owner, event("CALL_INVITE")),
            self.coordinator.handle_event(
                self.member,
                event("CALL_INVITE", "call_fedcba9876543210", client="member"),
            ),
        )

        state = self.store.states["owner"]
        self.assertEqual(1, len(state.active_calls))
        self.assertEqual(1, len(self.store.messages["owner"]))
        direct_types = {message["type"] for result in (first, second) for message in result.direct_messages}
        self.assertIn("CALL_ACTIVE", direct_types)

    async def test_participant_entry_exit_and_host_authorization(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(
            self.member,
            event("CALL_ACCEPT", client="member"),
        )
        calls = await self.coordinator.active_calls_for(self.member)
        self.assertEqual(["member", "owner"], calls[0]["joinedUserIds"])

        with self.assertRaises(CallError) as error:
            await self.coordinator.end_call(self.member, "call_0123456789abcdef")
        self.assertEqual(403, error.exception.status_code)

        await self.coordinator.handle_event(
            self.member,
            event("CALL_LEAVE", client="member"),
        )
        calls = await self.coordinator.active_calls_for(self.owner)
        self.assertEqual(["owner"], calls[0]["joinedUserIds"])

    async def test_end_and_missing_call_are_idempotent(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        first = await self.coordinator.end_call(self.owner, "call_0123456789abcdef")
        second = await self.coordinator.end_call(self.owner, "call_0123456789abcdef")

        self.assertTrue(first["ended"])
        self.assertFalse(second["ended"])
        self.assertEqual([], self.store.states["owner"].active_calls)
        ended_events = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertEqual(1, len(ended_events))
        self.assertEqual(1, sum(message["metadata"]["action"] == "call_ended" for message in self.store.messages["owner"]))

    async def test_event_for_missing_call_returns_end_without_publication(self) -> None:
        result = await self.coordinator.handle_event(
            self.member,
            event("CALL_SIGNAL", client="member", targetUserId="owner", signal={"candidate": "x"}),
        )

        self.assertEqual("CALL_END", result.direct_messages[0]["type"])
        self.assertEqual([], self.publisher.sent)

    async def test_explicit_end_wins_over_automatic_expiration(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        self.clock.advance(seconds=91)

        result = await self.coordinator.end_call(self.owner, "call_0123456789abcdef")

        self.assertTrue(result["ended"])
        ended = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertNotIn("reason", ended[-1])

    async def test_heartbeat_and_clock_expire_abandoned_call(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        self.clock.advance(seconds=60)
        await self.coordinator.handle_event(self.owner, event("CALL_HEARTBEAT"))
        self.clock.advance(seconds=89)
        self.assertEqual(1, len(await self.coordinator.active_calls_for(self.owner)))
        self.clock.advance(seconds=2)

        self.assertEqual([], await self.coordinator.active_calls_for(self.owner))
        expired = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertEqual("expired", expired[-1]["reason"])
        self.assertIn("call_0123456789abcdef", self.store.states["owner"].ended_call_ids)

    async def test_ice_routing_uses_memory_without_storage_round_trip(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(self.member, event("CALL_ACCEPT", client="member"))
        loads_before, saves_before = self.store.loads, self.store.saves
        self.publisher.sent.clear()

        for index in range(5):
            await self.coordinator.handle_event(self.owner, event(
                "CALL_SIGNAL",
                targetUserId="member",
                signal={"candidate": f"candidate-{index}"},
            ))

        self.assertEqual(loads_before, self.store.loads)
        self.assertEqual(saves_before, self.store.saves)
        signals = [item for item in self.publisher.sent if item[2]["type"] == "CALL_SIGNAL"]
        self.assertEqual(5, len(signals))
        self.assertTrue(all(recipients == {"member"} for _, recipients, _ in signals))

    async def test_non_participant_cannot_join_direct_call(self) -> None:
        await self.coordinator.handle_event(self.owner, event(
            "CALL_INVITE",
            scope="direct",
            recipientId="member",
        ))

        with self.assertRaises(CallError) as error:
            await self.coordinator.handle_event(self.other, event("CALL_ACCEPT", client="other"))
        self.assertEqual(403, error.exception.status_code)
        self.assertEqual([], await self.coordinator.active_calls_for(self.other))

    async def test_disconnected_host_is_removed_after_defined_grace_without_leave(self) -> None:
        connected_owner = CallActor(
            user_id="owner",
            team_id="owner",
            name="Owner",
            attributes={"connectionId": "connection-owner"},
        )
        await self.coordinator.handle_event(connected_owner, event("CALL_INVITE"))

        await self.coordinator.connection_closed(connected_owner, "connection-owner")
        self.clock.advance(seconds=7)
        await self.coordinator.reconcile(connected_owner)
        self.assertEqual(1, len(await self.coordinator.active_calls_for(connected_owner)))

        self.clock.advance(seconds=2)
        await self.coordinator.reconcile(connected_owner)
        self.assertEqual([], await self.coordinator.active_calls_for(connected_owner))
        ended = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertEqual("host_disconnected", ended[-1]["reason"])

    async def test_same_client_reconnects_on_new_connection_inside_grace(self) -> None:
        first_connection = CallActor(
            user_id="owner",
            team_id="owner",
            name="Owner",
            attributes={"connectionId": "connection-one"},
        )
        second_connection = CallActor(
            user_id="owner",
            team_id="owner",
            name="Owner",
            attributes={"connectionId": "connection-two"},
        )
        await self.coordinator.handle_event(first_connection, event("CALL_INVITE"))
        await self.coordinator.connection_closed(first_connection, "connection-one")
        self.clock.advance(seconds=7)

        await self.coordinator.handle_event(second_connection, event("CALL_HEARTBEAT"))
        self.clock.advance(seconds=2)
        await self.coordinator.reconcile(second_connection)

        calls = await self.coordinator.active_calls_for(second_connection)
        self.assertEqual(1, len(calls))
        session = self.store.states["owner"].active_calls[0]["participantSessions"]["owner"]
        self.assertEqual("connection-two", session["connectionId"])
        self.assertIsNone(session["disconnectedAt"])

    async def test_server_expires_suspended_host_lease_while_member_stays_alive(self) -> None:
        connected_owner = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "owner-connection"},
        )
        connected_member = CallActor(
            user_id="member", team_id="owner", name="Member",
            attributes={"connectionId": "member-connection"},
        )
        await self.coordinator.handle_event(connected_owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(
            connected_member,
            event("CALL_ACCEPT", client="member"),
        )
        self.clock.advance(seconds=20)
        await self.coordinator.handle_event(
            connected_member,
            event("CALL_HEARTBEAT", client="member"),
        )
        self.clock.advance(seconds=16)

        await self.coordinator.reconcile(connected_member)

        self.assertEqual([], await self.coordinator.active_calls_for(connected_member))
        ended = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertEqual("host_lease_expired", ended[-1]["reason"])

    async def test_participant_without_heartbeat_is_removed_while_host_stays_alive(self) -> None:
        connected_owner = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "owner-connection"},
        )
        connected_member = CallActor(
            user_id="member", team_id="owner", name="Member",
            attributes={"connectionId": "member-connection"},
        )
        await self.coordinator.handle_event(connected_owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(
            connected_member,
            event("CALL_ACCEPT", client="member"),
        )
        self.clock.advance(seconds=20)
        await self.coordinator.handle_event(connected_owner, event("CALL_HEARTBEAT"))
        self.clock.advance(seconds=11)

        await self.coordinator.reconcile(connected_owner)

        calls = await self.coordinator.active_calls_for(connected_owner)
        self.assertEqual(["owner"], calls[0]["joinedUserIds"])
        leaves = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_LEAVE"]
        self.assertEqual("member", leaves[-1]["fromUserId"])
        self.assertEqual("heartbeat_expired", leaves[-1]["reason"])

    async def test_new_tab_replaces_old_session_and_late_events_cannot_mutate_it(self) -> None:
        old_tab = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "old-connection"},
        )
        new_tab = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "new-connection"},
        )
        await self.coordinator.handle_event(old_tab, event("CALL_INVITE", client="old"))
        await self.coordinator.handle_event(new_tab, event("CALL_ACCEPT", client="new"))
        self.publisher.sent.clear()

        result = await self.coordinator.handle_event(
            old_tab,
            event(
                "CALL_SIGNAL",
                client="old",
                targetUserId="member",
                signal={"candidate": "late"},
            ),
        )
        await self.coordinator.connection_closed(old_tab, "old-connection")
        self.clock.advance(seconds=9)
        await self.coordinator.reconcile(new_tab)

        self.assertEqual("CALL_SESSION", result.direct_messages[0]["type"])
        self.assertEqual("new-tab", result.direct_messages[0]["clientId"])
        self.assertFalse(any(payload["type"] == "CALL_SIGNAL" for _, _, payload in self.publisher.sent))
        session = self.store.states["owner"].active_calls[0]["participantSessions"]["owner"]
        self.assertEqual("new-tab", session["clientId"])
        self.assertEqual("new-connection", session["connectionId"])
        self.assertIsNone(session["disconnectedAt"])

    async def test_repeated_leave_is_idempotent(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(self.member, event("CALL_ACCEPT", client="member"))
        self.publisher.sent.clear()

        first = await self.coordinator.handle_event(
            self.member,
            event("CALL_LEAVE", client="member"),
        )
        second = await self.coordinator.handle_event(
            self.member,
            event("CALL_LEAVE", client="member"),
        )

        self.assertEqual("CALL_ACK", first.direct_messages[0]["type"])
        self.assertEqual("CALL_ACK", second.direct_messages[0]["type"])
        leaves = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_LEAVE"]
        self.assertEqual(1, len(leaves))

    async def test_host_kick_is_authorized_and_idempotent(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(self.member, event("CALL_ACCEPT", client="member"))
        self.publisher.sent.clear()

        first = await self.coordinator.handle_event(
            self.owner,
            event("CALL_KICK", targetUserId="member"),
        )
        second = await self.coordinator.handle_event(
            self.owner,
            event("CALL_KICK", targetUserId="member"),
        )

        self.assertEqual("CALL_ACK", first.direct_messages[0]["type"])
        self.assertEqual("CALL_ACK", second.direct_messages[0]["type"])
        kicks = [item for item in self.publisher.sent if item[2]["type"] == "CALL_KICK"]
        self.assertEqual(1, len(kicks))
        self.assertEqual({"member"}, kicks[0][1])
        self.assertEqual(["owner"], (await self.coordinator.active_calls_for(self.owner))[0]["joinedUserIds"])

    async def test_reconcile_revokes_removed_member_immediately(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        await self.coordinator.handle_event(self.member, event("CALL_ACCEPT", client="member"))
        self.publisher.sent.clear()
        self.directory.members.remove("member")

        await self.coordinator.reconcile(self.owner)

        calls = await self.coordinator.active_calls_for(self.owner)
        self.assertEqual(["owner"], calls[0]["joinedUserIds"])
        kicks = [item for item in self.publisher.sent if item[2]["type"] == "CALL_KICK"]
        self.assertEqual({"member"}, kicks[-1][1])
        self.assertEqual("access_revoked", kicks[-1][2]["reason"])

    async def test_revoked_host_cannot_use_privilege_and_server_ends_call(self) -> None:
        await self.coordinator.handle_event(self.owner, event("CALL_INVITE"))
        self.directory.members.remove("owner")

        with self.assertRaises(CallError) as error:
            await self.coordinator.end_call(self.owner, "call_0123456789abcdef")
        self.assertEqual(403, error.exception.status_code)

        await self.coordinator.reconcile(self.member)

        self.assertEqual([], await self.coordinator.active_calls_for(self.member))
        ended = [payload for _, _, payload in self.publisher.sent if payload["type"] == "CALL_END"]
        self.assertEqual("host_access_revoked", ended[-1]["reason"])
        self.assertEqual("owner", self.store.messages["owner"][-1]["senderId"])

    async def test_reconnect_racing_old_disconnect_keeps_new_connection(self) -> None:
        old_connection = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "old-connection"},
        )
        new_connection = CallActor(
            user_id="owner", team_id="owner", name="Owner",
            attributes={"connectionId": "new-connection"},
        )
        await self.coordinator.handle_event(old_connection, event("CALL_INVITE"))

        heartbeat, _ = await asyncio.gather(
            self.coordinator.handle_event(new_connection, event("CALL_HEARTBEAT")),
            self.coordinator.connection_closed(old_connection, "old-connection"),
        )

        self.assertEqual("CALL_ACK", heartbeat.direct_messages[0]["type"])
        session = self.store.states["owner"].active_calls[0]["participantSessions"]["owner"]
        self.assertEqual("new-connection", session["connectionId"])
        self.assertIsNone(session["disconnectedAt"])


if __name__ == "__main__":
    unittest.main()
