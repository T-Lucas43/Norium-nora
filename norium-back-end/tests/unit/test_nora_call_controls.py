from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app.modules.team.call_coordinator import CallCoordinator, CallError, TeamCallAuthorizer
from tests.unit.test_call_coordinator import FakeClock, MemoryCallStore, MemoryDirectory, MemoryPublisher, actor, event


class NoraControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"NORA_CALL_ENABLED": "1"})
        self.env.start()
        self.publisher = MemoryPublisher()
        self.directory = MemoryDirectory()
        self.coordinator = CallCoordinator(store=MemoryCallStore(), publisher=self.publisher,
                                          authorizer=TeamCallAuthorizer(self.directory), clock=FakeClock(),
                                          media_transport_for_team=lambda team: "sfu",
                                          nora_entitled_for_actor=lambda actor: actor.user_id == "owner")
        await self.coordinator.handle_event(actor("owner"), event("CALL_INVITE"))
        await self.coordinator.handle_event(actor("member"), event("CALL_ACCEPT", client="member"))

    async def asyncTearDown(self):
        self.env.stop()

    async def send(self, who, kind, **payload):
        return await self.coordinator.handle_event(actor(who), event(kind, client=who, **payload))

    async def nora(self):
        return (await self.coordinator.active_calls_for(actor("owner")))[0]["nora"]

    async def test_control_consent_current_sessions_and_real_state(self):
        self.assertTrue((await self.nora())["available"])
        await self.send("owner", "CALL_NORA_CONTROL", enabled=True)
        state = await self.nora()
        self.assertEqual("awaiting_consent", state["state"])
        for user in ("owner", "member"):
            await self.send(user, "CALL_NORA_CONSENT", revision=state["revision"], accepted=True)
        self.assertEqual("awaiting_agent", (await self.nora())["state"])
        self.assertEqual({"owner", "member"}, self.publisher.sent[-1][1])
        await self.send("owner", "CALL_NORA_CONTROL", enabled=False)
        self.assertEqual("paused", (await self.nora())["state"])

    async def test_nonhost_old_client_and_removed_member_never_consent(self):
        with self.assertRaises(CallError):
            await self.send("member", "CALL_NORA_CONTROL", enabled=True)
        await self.send("owner", "CALL_NORA_CONTROL", enabled=True)
        state = await self.nora()
        result = await self.coordinator.handle_event(actor("member"), event("CALL_NORA_CONSENT", client="old", revision=state["revision"], accepted=True))
        self.assertEqual("CALL_SESSION", result.direct_messages[0]["type"])
        self.assertIn("member", (await self.nora())["pendingUserIds"])
        await self.send("owner", "CALL_KICK", targetUserId="member")
        result = await self.send("member", "CALL_NORA_CONSENT", revision=state["revision"], accepted=True)
        self.assertEqual("CALL_SESSION", result.direct_messages[0]["type"])
        self.assertNotIn("member", (await self.nora())["pendingUserIds"])

    async def test_new_member_and_replaced_browser_invalidate_previous_consent(self):
        await self.send("owner", "CALL_NORA_CONTROL", enabled=True)
        state = await self.nora()
        await self.send("owner", "CALL_NORA_CONSENT", revision=state["revision"], accepted=True)
        await self.send("member", "CALL_NORA_CONSENT", revision=state["revision"], accepted=True)
        await self.send("other", "CALL_ACCEPT")
        next_state = await self.nora()
        self.assertGreater(next_state["revision"], state["revision"])
        self.assertEqual(["member", "other", "owner"], next_state["pendingUserIds"])

    async def test_default_entitlement_and_flag_fail_closed(self):
        self.coordinator._nora_entitled_for_actor = lambda actor: False
        with self.assertRaises(CallError):
            await self.send("owner", "CALL_NORA_CONTROL", enabled=True)
        self.coordinator._nora_entitled_for_actor = lambda actor: True
        with patch.dict(os.environ, {"NORA_CALL_ENABLED": "0"}):
            with self.assertRaises(CallError):
                await self.send("owner", "CALL_NORA_CONTROL", enabled=True)
        with self.assertRaises(CallError):
            await self.send("owner", "CALL_NORA_CONSENT", revision=True, accepted="yes")

    async def test_nora_capacity_never_prevents_human_sfu_admission(self):
        self.directory.members.update({f"person{i}" for i in range(13)})
        coordinator = CallCoordinator(store=MemoryCallStore(), publisher=self.publisher,
                                      authorizer=TeamCallAuthorizer(self.directory), clock=FakeClock(),
                                      media_transport_for_team=lambda team: "sfu", sfu_max_participants=20,
                                      nora_entitled_for_actor=lambda actor: True)
        await coordinator.handle_event(actor("owner"), event("CALL_INVITE"))
        for index in range(13):
            user = f"person{index}"
            await coordinator.handle_event(actor(user), event("CALL_ACCEPT", client=user))
        state = (await coordinator.active_calls_for(actor("owner")))[0]
        self.assertEqual(14, state["joinedCount"])
        self.assertFalse(state["nora"]["available"])
