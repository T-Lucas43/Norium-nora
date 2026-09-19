from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.team.call_configuration import CallConfigurationError
from app.modules.team.call_release import CallReleasePolicy
from app.modules.team.call_observability import CallAccessPrivacyFilter, CallMetrics, EventBudget
from app.modules.team.call_coordinator import CallCoordinator, CallError, TeamCallAuthorizer
from app.modules.team import router
from tests.unit.test_call_coordinator import MemoryCallStore, MemoryDirectory, MemoryPublisher, actor, event


class PolicyTests(unittest.TestCase):
    def test_production_staging_and_conflicting_environment_defaults_are_closed(self):
        for source in ({"ENVIRONMENT": "production"}, {"APP_ENV": "staging"},
                       {"ENVIRONMENT": "test", "APP_ENV": "production"}):
            policy = CallReleasePolicy.from_env(source)
            self.assertFalse(policy.enabled)
            self.assertFalse(policy.recording_enabled)
            self.assertEqual(0, policy.percent)

    def test_cohorts_are_stable_monotonic_and_kill_switch_overrides_allowlist(self):
        low = CallReleasePolicy.from_env({"TEAM_CALL_ROLLOUT_PERCENT": "5"})
        high = CallReleasePolicy.from_env({"TEAM_CALL_ROLLOUT_PERCENT": "25"})
        teams = [f"team-{n}" for n in range(1000)]
        first = {team for team in teams if low.allows_new_call(team)}
        self.assertTrue(first)
        self.assertLess(len(first), 100)
        self.assertLessEqual(first, {team for team in teams if high.allows_new_call(team)})
        self.assertFalse(CallReleasePolicy.from_env({"TEAM_CALL_ENABLED": "false",
                         "TEAM_CALL_INTERNAL_TEAMS": "internal"}).allows_new_call("internal"))
        self.assertTrue(CallReleasePolicy.from_env({"TEAM_CALL_ROLLOUT_PERCENT": "0",
                        "TEAM_CALL_INTERNAL_TEAMS": "internal"}).allows_new_call("internal"))

    def test_invalid_policy_fails_closed(self):
        for config in ({"TEAM_CALL_ENABLED": "yes"}, {"TEAM_CALL_ROLLOUT_PERCENT": "101"},
                       {"TEAM_CALL_MAX_ACTIVE_TOTAL": "0"}, {"TEAM_CALL_METRICS_TOKEN": "short"}):
            with self.subTest(config=config), self.assertRaises(CallConfigurationError):
                CallReleasePolicy.from_env(config)


class MetricsTests(unittest.TestCase):
    def test_http_and_websocket_access_logs_do_not_retain_ip_or_ticket(self):
        import logging
        for message, args in (("%s - %s", ("192.0.2.1", "/api/team-chat/ws?ticket=secret")),
                              ("GET /api/team-chat/calls/active from 192.0.2.1", ())):
            record = logging.LogRecord("uvicorn.error", logging.INFO, "test", 1, message, args, None)
            self.assertFalse(CallAccessPrivacyFilter().filter(record))

    def test_metrics_are_bounded_and_never_include_arbitrary_fields(self):
        metrics = CallMetrics()
        metrics.client_event("connected", 1500)
        metrics.client_event("ice_failed")
        with self.assertRaises(ValueError):
            metrics.increment("candidate:secret")
        for value in (float("nan"), -1, 120001, True, "192.0.2.1"):
            with self.assertRaises(ValueError):
                metrics.client_event("connected", value)
        output = metrics.prometheus({"active_calls": 2, "ip": "192.0.2.1", "team": "private"})
        self.assertIn('team_call_connect_seconds_bucket{le="2"} 1', output)
        self.assertIn("team_call_active_calls 2", output)
        self.assertNotIn("192.0.2.1", output)
        self.assertNotIn("private", output)
        with self.assertLogs("norium.team_calls", level="INFO") as captured:
            metrics.log_snapshot({"active_calls": 2, "sdp": "private"})
        self.assertNotIn("private", " ".join(captured.output))

    def test_budget_has_constant_burst_limit(self):
        with patch("app.modules.team.call_observability.time.monotonic", return_value=10):
            budget = EventBudget(2, 1)
            self.assertTrue(budget.take())
            self.assertTrue(budget.take())
            self.assertFalse(budget.take())
        with patch("app.modules.team.call_observability.time.monotonic", return_value=11):
            self.assertTrue(budget.take())
            self.assertFalse(budget.take())

    def test_scrape_requires_dedicated_bearer_and_never_uses_query_credentials(self):
        app = FastAPI()
        app.include_router(router.router)
        client = TestClient(app)
        token = "metrics-test-" + "x" * 32
        with patch.dict("os.environ", {"TEAM_CALL_METRICS_TOKEN": token}):
            self.assertEqual(404, client.get("/api/team-chat/calls/metrics").status_code)
            self.assertEqual(404, client.get("/api/team-chat/calls/metrics?token=" + token).status_code)
            with patch.object(router, "call_resource_gauges", return_value={"active_calls": 0}):
                self.assertEqual(404, client.get("/api/team-chat/calls/metrics?token=" + token,
                    headers={"Authorization": "Bearer " + token}).status_code)
                response = client.get("/api/team-chat/calls/metrics", headers={"Authorization": "Bearer " + token})
            self.assertEqual(200, response.status_code)
            self.assertEqual("no-store", response.headers["cache-control"])
            self.assertNotIn(token, response.text)


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_revoked_actor_cannot_create_team_or_direct_call(self):
        directory = MemoryDirectory()
        directory.members.remove("owner")
        coordinator = CallCoordinator(store=MemoryCallStore(), publisher=MemoryPublisher(),
                                      authorizer=TeamCallAuthorizer(directory))
        for scope in ("team", "direct"):
            with self.assertRaises(CallError) as raised:
                await coordinator.handle_event(actor("owner"), event("CALL_INVITE", scope=scope, recipientId="member"))
            self.assertEqual(403, raised.exception.status_code)
        self.assertEqual(0, coordinator.resource_counts()["active_calls"])

    async def test_directory_excludes_active_accounts_without_call_permission(self):
        members = [{"id": "owner", "status": "ativo", "teamChatEnabled": True,
                    "permissions": {"chat": True}},
                   {"id": "member", "teamOwnerId": "owner", "status": "ativo", "permissions": {}}]
        with patch.object(router, "read_user_store", AsyncMock(return_value={"users": members})):
            self.assertEqual({"owner"}, await router._call_active_member_ids(actor("owner")))

    async def test_socket_revalidation_checks_session_version_and_permissions(self):
        manager = router.PresenceManager()
        socket = object()
        manager.socket_session_version[socket] = 2
        user = {"id": "owner", "status": "ativo", "sessionVersion": 2,
                "teamChatEnabled": True, "permissions": {"chat": True}}
        self.assertTrue(manager.socket_authorized(socket, user, "owner"))
        self.assertFalse(manager.socket_authorized(socket, {**user, "sessionVersion": 3}, "owner"))
        self.assertFalse(manager.socket_authorized(socket, {**user, "permissions": {}}, "owner"))
        self.assertFalse(manager.socket_authorized(socket, user, "other-team"))

    async def test_revoked_last_socket_reconciles_before_disconnect_grace(self):
        directory = MemoryDirectory()
        coordinator = CallCoordinator(store=MemoryCallStore(), publisher=MemoryPublisher(),
                                      authorizer=TeamCallAuthorizer(directory))
        owner = actor("owner")
        await coordinator.handle_event(owner, event("CALL_INVITE"))
        directory.members.clear()
        sleeping = asyncio.Event()
        resume = asyncio.Event()
        async def grace(_seconds):
            sleeping.set()
            await resume.wait()
        with patch.object(router, "call_coordinator", return_value=coordinator), \
             patch.object(router.asyncio, "sleep", grace):
            task = asyncio.create_task(router._reconcile_closed_connection(owner))
            try:
                await asyncio.wait_for(sleeping.wait(), timeout=1)
                self.assertEqual(0, coordinator.resource_counts()["active_calls"])
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    async def test_expired_recording_cannot_be_downloaded_even_if_cleanup_failed(self):
        from fastapi import HTTPException
        with patch.object(router, "require_team_chat"), \
             patch.object(router, "active_calls_snapshot", AsyncMock()), \
             patch.object(router, "read_pruned_chat_store", AsyncMock(return_value={"recordings": [
                 {"storedName": "expired.webm", "status": "completed", "participantIds": ["owner"],
                  "expiresAt": "2020-01-01T00:00:00+00:00"}]})):
            with self.assertRaises(HTTPException) as raised:
                await router.download_attachment("expired.webm", {"id": "owner"})
            self.assertEqual(404, raised.exception.status_code)

    async def test_rollout_changes_only_new_calls_and_does_not_trap_existing_participants(self):
        config = {}
        coordinator = CallCoordinator(store=MemoryCallStore(), publisher=MemoryPublisher(),
            authorizer=TeamCallAuthorizer(MemoryDirectory()), release_policy=lambda: CallReleasePolicy.from_env(config))
        await coordinator.handle_event(actor("owner"), event("CALL_INVITE"))
        config["TEAM_CALL_ENABLED"] = "false"
        await coordinator.handle_event(actor("member"), event("CALL_ACCEPT", client="member"))
        self.assertEqual(2, coordinator.resource_counts()["active_participants"])
        with self.assertRaises(CallError) as raised:
            await coordinator.handle_event(actor("owner"), event("CALL_INVITE", "call_ffffffffffffffff",
                scope="direct", recipientId="other"))
        self.assertEqual("call_rollout_disabled", raised.exception.code)
        await coordinator.end_call(actor("owner"), "call_0123456789abcdef")
        self.assertEqual(0, coordinator.resource_counts()["active_calls"])

    async def test_global_capacity_is_atomic_across_teams(self):
        coordinator = CallCoordinator(store=MemoryCallStore(), publisher=MemoryPublisher(),
            authorizer=TeamCallAuthorizer(MemoryDirectory()), release_policy=lambda: CallReleasePolicy.from_env(
                {"TEAM_CALL_MAX_ACTIVE_TOTAL": "1"}))
        one, two = actor("owner"), actor("member")
        from dataclasses import replace
        two = replace(two, team_id="second-team")
        results = await asyncio.gather(coordinator.handle_event(one, event("CALL_INVITE")),
            coordinator.handle_event(two, event("CALL_INVITE", "call_ffffffffffffffff", client="member")),
            return_exceptions=True)
        self.assertEqual(1, sum(isinstance(item, CallError) for item in results))
        self.assertEqual(1, coordinator.resource_counts()["active_calls"])

    async def test_recording_flag_rejects_before_creating_upload(self):
        with patch.dict("os.environ", {"TEAM_CALL_RECORDING_ENABLED": "false"}), \
             patch.object(router, "require_team_chat"), \
             patch.object(router, "recording_coordinator") as coordinator:
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as raised:
                await router.start_recording(router.RecordingStartPayload(callId="call_0123456789abcdef",
                    clientId="client", operationId="operation", mimeType="audio/webm"), {})
            self.assertEqual(503, raised.exception.status_code)
            coordinator.assert_not_called()

    async def test_private_recording_audit_is_restricted_to_participants(self):
        with patch.object(router, "read_pruned_chat_store", AsyncMock(return_value={"recordings": [
                {"id": "recording", "participantIds": ["one", "two"]}]})), \
             patch.object(router, "record_team_event", AsyncMock()) as record:
            await router._audit_recording("owner", "recording_started", {"recordingId": "recording"})
            self.assertEqual({"one", "two"}, record.call_args.kwargs["user_ids"])
