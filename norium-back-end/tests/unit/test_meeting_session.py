from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.modules.team.call_coordinator import CallCoordinator, CallError, TeamCallAuthorizer
from app.modules.team.meeting_intelligence import MeetingFact, MeetingUnderstanding
from app.modules.team.meeting_session import MeetingSession, MeetingSessionError
from app.modules.team.nora_call_agent import TranscriptSegment
from tests.unit.test_call_coordinator import FakeClock, MemoryCallStore, MemoryDirectory, MemoryPublisher, actor, event

CALL = "call_0123456789abcdef"


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.session = MeetingSession(CALL, self.now + timedelta(hours=24))

    def segment(self, key="s1", text="A proposta precisa de revisão."):
        return TranscriptSegment(key, CALL, "owner", 0, 5, text)

    def test_minimized_duplicate_idempotent_and_original_audience(self):
        values = (self.segment(text="senha=segredo CPF 123.456.789-00"),)
        first = self.session.append(values, frozenset({"owner", "member"}), self.now)
        self.assertNotIn("segredo", first[0]["text"])
        self.assertEqual([], self.session.append(values, frozenset({"owner", "member"}), self.now))
        self.assertEqual(1, self.session.sequence)
        self.assertEqual([], self.session.view("late", self.now)["segments"])
        self.assertEqual(1, len(self.session.view("member", self.now)["segments"]))
        with self.assertRaises(MeetingSessionError):
            self.session.append(values, frozenset({"owner", "late"}), self.now)

    def test_batch_atomic_limit_and_expiry(self):
        self.session.byte_count = 2 * 1024 * 1024
        with self.assertRaises(MeetingSessionError):
            self.session.append((self.segment(),), frozenset({"owner"}), self.now)
        self.assertEqual({}, self.session.records)
        self.assertEqual(0, self.session.sequence)
        with self.assertRaises(MeetingSessionError):
            self.session.view("owner", self.session.expires_at)

    def test_invalid_speaker_time_and_crosscall_rejected(self):
        for value in (TranscriptSegment("s", "other", "owner", 0, 5, "Fala"),
                      TranscriptSegment("s", CALL, "outside", 0, 5, "Fala"),
                      TranscriptSegment("s", CALL, "owner", float("nan"), 5, "Fala"),
                      TranscriptSegment("s", CALL, "owner", 0, 30, "Fala")):
            with self.assertRaises(MeetingSessionError):
                self.session.append((value,), frozenset({"owner"}), self.now)


class CoordinatorSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"NORA_CALL_ENABLED": "1"})
        self.env.start()
        self.publisher = MemoryPublisher()
        self.directory = MemoryDirectory()
        self.clock = FakeClock()
        self.clock.value = datetime.now(timezone.utc)
        self.coordinator = CallCoordinator(store=MemoryCallStore(), publisher=self.publisher,
                                          authorizer=TeamCallAuthorizer(self.directory), clock=self.clock,
                                          media_transport_for_team=lambda team: "sfu",
                                          nora_entitled_for_actor=lambda user: user.user_id == "owner")
        await self.coordinator.handle_event(actor("owner"), event("CALL_INVITE"))
        await self.coordinator.handle_event(actor("member"), event("CALL_ACCEPT", client="member"))
        await self.coordinator.handle_event(actor("owner"), event("CALL_NORA_CONTROL", enabled=True))
        state = (await self.coordinator.active_calls_for(actor("owner")))[0]["nora"]
        self.revision = state["revision"]
        for user in ("owner", "member"):
            await self.coordinator.handle_event(actor(user), event("CALL_NORA_CONSENT", client=user, accepted=True, revision=self.revision))
        self.segment = TranscriptSegment("s1", CALL, "owner", 0, 5, "Decidimos revisar a proposta.")

    async def asyncTearDown(self):
        self.env.stop()

    async def publish(self):
        return await self.coordinator.publish_nora_segments(actor("owner"), CALL, "owner-tab", self.revision, (self.segment,))

    async def test_broadcast_current_audience_read_by_joined_session_and_replay(self):
        await self.publish()
        self.assertEqual({"owner", "member"}, self.publisher.sent[-1][1])
        self.assertEqual("CALL_NORA_TRANSCRIPT", self.publisher.sent[-1][2]["type"])
        view = await self.coordinator.nora_session_view(actor("member"), CALL, "member-tab")
        self.assertEqual("listening", view["nora"]["state"])
        self.assertEqual(1, len(view["segments"]))
        self.assertTrue(view["volatile"])
        count = len(self.publisher.sent)
        await self.publish()
        self.assertEqual(count, len(self.publisher.sent))
        self.clock.advance(seconds=6)
        self.assertEqual("awaiting_agent", (await self.coordinator.nora_session_view(actor("member"), CALL, "member-tab"))["nora"]["state"])

    async def test_late_joiner_no_old_text_and_old_revision_cannot_publish(self):
        await self.publish()
        await self.coordinator.handle_event(actor("other"), event("CALL_ACCEPT", client="other"))
        view = await self.coordinator.nora_session_view(actor("other"), CALL, "other-tab")
        self.assertEqual([], view["segments"])
        with self.assertRaises(CallError):
            await self.publish()

    async def test_permission_revoked_old_client_and_end_refuse_output_or_read(self):
        for client in ("old-tab", "member-tab"):
            with self.assertRaises(CallError):
                await self.coordinator.publish_nora_segments(actor("owner"), CALL, client, self.revision, (self.segment,))
        self.directory.members.remove("member")
        with self.assertRaises(CallError):
            await self.publish()
        with self.assertRaises(CallError):
            await self.coordinator.nora_session_view(actor("member"), CALL, "member-tab")
        self.directory.members.add("member")
        await self.coordinator.end_call(actor("owner"), CALL)
        with self.assertRaises(CallError):
            await self.publish()

    async def test_understanding_evidence_publication_and_pause_fence(self):
        await self.publish()
        fact = MeetingFact("s1", self.segment.text, "owner", 0, 5)
        await self.coordinator.publish_nora_understanding(actor("owner"), CALL, "owner-tab", self.revision, MeetingUnderstanding(decisions=(fact,)))
        self.assertEqual("CALL_NORA_UNDERSTANDING", self.publisher.sent[-1][2]["type"])
        with self.assertRaises(CallError):
            await self.coordinator.publish_nora_understanding(actor("owner"), CALL, "owner-tab", self.revision, MeetingUnderstanding(decisions=(MeetingFact("s1", "Venda aprovada", "owner", 0, 5),)))
        await self.coordinator.handle_event(actor("owner"), event("CALL_NORA_CONTROL", enabled=False))
        with self.assertRaises(CallError):
            await self.publish()

    async def test_expired_session_refuses_reads_capture_and_does_not_restart_deadline(self):
        await self.publish()
        runtime = self.coordinator._runtime("owner")
        session = runtime.nora_sessions[CALL]
        session.expires_at = self.clock.now()
        for operation in (lambda: self.coordinator.nora_session_view(actor("member"), CALL, "member-tab"),
                          lambda: self.coordinator.authorize_nora_capture(actor("owner"), CALL, "owner-tab", self.revision)):
            with self.assertRaises(CallError) as exc:
                await operation()
            self.assertEqual(410, exc.exception.status_code)
        self.assertEqual({}, session.records)
        self.assertEqual(self.clock.now(), runtime.nora_sessions[CALL].expires_at)
