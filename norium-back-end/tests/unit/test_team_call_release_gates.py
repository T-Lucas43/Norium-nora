from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.team_call_release_check import assess


SMOKE_PATH = Path(__file__).resolve().parents[3] / "infra" / "azure" / "team_call_smoke.py"
spec = importlib.util.spec_from_file_location("team_call_release_smoke", SMOKE_PATH)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def release_configuration() -> dict[str, str]:
    return {
        "ENVIRONMENT": "production", "TEAM_CALL_ENABLED": "true", "TEAM_CALL_ROLLOUT_PERCENT": "0",
        "TEAM_CALL_INTERNAL_TEAMS": "smoke-team", "TEAM_CALL_SMOKE_TEAM_ID": "smoke-team",
        "TEAM_CALL_RECORDING_ENABLED": "false", "TEAM_CALL_SFU_ENABLED": "false",
        "TEAM_CALL_TURN_REQUIRED": "true", "TEAM_CALL_TURN_URLS": "turns:relay.example:443?transport=tcp",
        "TEAM_CALL_TURN_SHARED_SECRET": "synthetic-" + "x" * 40,
        "TEAM_CALL_METRICS_TOKEN": "synthetic-" + "y" * 40,
        "NORIUM_SMOKE_EMAIL": "one@example.test", "NORIUM_SMOKE_PASSWORD": "synthetic",
        "NORIUM_SMOKE_PEER_EMAIL": "two@example.test", "NORIUM_SMOKE_PEER_PASSWORD": "synthetic",
        "AZURE_PUBLIC_URL": "https://example.test", "AZURE_CONTAINER_APP_NAME": "test",
        "AZURE_RESOURCE_GROUP": "test", "AZURE_CLIENT_ID": "test", "AZURE_TENANT_ID": "test",
        "AZURE_SUBSCRIPTION_ID": "test", "TEAM_CALL_METRICS_COLLECTOR_READY": "true",
        "TEAM_CALL_ALERT_RECEIVER_READY": "true", "TEAM_CALL_ALERT_TEST_DELIVERED": "true",
        "TEAM_CALL_OBSERVABILITY_EVIDENCE_URL": "https://evidence.example.test/releases/test",
    }


class ReleasePreflightTests(unittest.TestCase):
    def test_internal_profile_defers_only_external_launch_requirements(self):
        config = {key: value for key, value in release_configuration().items()
                  if key.startswith("AZURE_") or key == "ENVIRONMENT"}
        config.update({"TEAM_CALL_RELEASE_PROFILE": "internal-test", "TEAM_CALL_ENABLED": "true",
                       "TEAM_CALL_ROLLOUT_PERCENT": "100", "TEAM_CALL_RECORDING_ENABLED": "false",
                       "TEAM_CALL_SFU_ENABLED": "false", "TEAM_CALL_TURN_REQUIRED": "false"})
        self.assertEqual([], assess(config))
        self.assertTrue(assess({**config, "TEAM_CALL_RELEASE_PROFILE": "public"}))
        self.assertIn("invalid_release_profile", assess({**config, "TEAM_CALL_RELEASE_PROFILE": "typo"}))
        for field, value, code in (
            ("TEAM_CALL_RECORDING_ENABLED", "true", "recording_consent_protocol_not_approved"),
            ("TEAM_CALL_SFU_ENABLED", "true", "sfu_server_revocation_not_implemented"),
            ("WEB_CONCURRENCY", "2", "single_worker_required"),
            ("AZURE_PUBLIC_URL", "", "invalid_production_destination"),
            ("TEAM_CALL_TURN_SHARED_SECRET", "short", "invalid_configuration:turn"),
        ):
            with self.subTest(field=field):
                self.assertIn(code, assess({**config, field: value}))

    def test_complete_attested_configuration_passes(self):
        self.assertEqual([], assess(release_configuration()))

    def test_external_relay_gate_rejects_other_ports_protocols_and_malformed_urls(self):
        urls = (
            "turns:relay.example:4433?transport=tcp", "turns:relay.example:443?transport=udp",
            "turns:relay.example:443", "turn:relay.example:443?transport=tcp",
            "turns:relay.example?transport=tcp", "turns:relay.example:invalid?transport=tcp",
            "turns:relay.example:443/path?transport=tcp", "turns:user@relay.example:443?transport=tcp",
            "turns:[invalid:443?transport=tcp", "turns::443?transport=tcp",
        )
        for url in urls:
            with self.subTest(url=url):
                blockers = assess({**release_configuration(), "TEAM_CALL_TURN_URLS": url})
                self.assertIn("release_requires_exclusive_turn_tls_443", blockers)

    def test_each_operational_attestation_is_mandatory(self):
        for name in ("TEAM_CALL_METRICS_COLLECTOR_READY", "TEAM_CALL_ALERT_RECEIVER_READY",
                     "TEAM_CALL_ALERT_TEST_DELIVERED"):
            for value in ("", "false", "yes"):
                with self.subTest(name=name, value=value):
                    blockers = assess({**release_configuration(), name: value})
                    self.assertIn("operational_attestation_required:" + name, blockers)

    def test_operational_attestation_requires_a_concrete_https_evidence_reference(self):
        for value in ("", "ready", "http://evidence.example.test/run/1", "https://evidence.example.test",
                      "https://user:password@evidence.example.test/run/1", "https://[broken/run/1"):
            with self.subTest(reference=value):
                blockers = assess({**release_configuration(), "TEAM_CALL_OBSERVABILITY_EVIDENCE_URL": value})
                self.assertIn("observability_evidence_reference_required", blockers)


class ProductionRevisionTests(unittest.IsolatedAsyncioTestCase):
    async def test_internal_smoke_needs_no_accounts_and_does_not_claim_call_connectivity(self):
        async def respond(request):
            if request.url.path == "/health":
                return httpx.Response(200, json={"revision": "a" * 40})
            if request.url.path == "/":
                return httpx.Response(200, text="<html></html>", headers={"content-type": "text/html"})
            return httpx.Response(404 if request.url.path.endswith("/metrics") else 401)
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.dict(os.environ, {}, clear=True), patch.object(smoke.httpx, "AsyncClient", return_value=client):
            result = await smoke.validate_internal("https://example.test", "a" * 40)
        self.assertEqual("passed", result["status"])
        self.assertFalse(result["productionRtpValidated"])
        self.assertIn("dedicated_two_account_smoke", result["deferred"])

    async def test_internal_smoke_rejects_public_call_endpoint(self):
        async def respond(request):
            if request.url.path == "/health":
                return httpx.Response(200, json={"revision": "a" * 40})
            return httpx.Response(200, text="<html></html>", headers={"content-type": "text/html"})
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(smoke.httpx, "AsyncClient", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "call_authentication_failed"):
                await smoke.validate_internal("https://example.test", "a" * 40)

    async def test_old_or_missing_revision_stops_before_login(self):
        for revision in ("b" * 40, None):
            requests = []
            async def respond(request):
                requests.append(request.url.path)
                return httpx.Response(200, json={"status": "ok", "revision": revision})
            client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
            with self.subTest(revision=revision), patch.dict(os.environ, release_configuration(), clear=True), \
                 patch.object(smoke.httpx, "AsyncClient", return_value=client):
                with self.assertRaisesRegex(RuntimeError, "production_revision_mismatch"):
                    await smoke.validate("https://example.test", "a" * 40)
                self.assertEqual(["/health"], requests)

    async def test_invalid_expected_revision_stops_before_network(self):
        with patch.object(smoke.httpx, "AsyncClient") as client:
            for revision in ("", "latest", "a" * 39):
                with self.subTest(revision=revision), self.assertRaisesRegex(ValueError, "expected_revision_required"):
                    await smoke.validate("https://example.test", revision)
            client.assert_not_called()

    async def test_success_reports_revision_and_rechecks_after_call_cleanup(self):
        calls = []
        login_count = 0
        async def respond(request):
            nonlocal login_count
            calls.append((request.method, request.url.path))
            path = request.url.path
            if path == "/health":
                return httpx.Response(200, json={"status": "ok", "revision": "a" * 40})
            if path.endswith("/login"):
                login_count += 1
                return httpx.Response(200, json={"token": f"session-{login_count}", "user": {
                    "id": f"user-{login_count}", "teamOwnerId": "smoke-team"}})
            if path.endswith("/configuration"):
                return httpx.Response(200, json={"newCallsEnabled": True, "recordingEnabled": False})
            if path.endswith("/ice-servers"):
                return httpx.Response(200, json={}, headers={"cache-control": "no-store"})
            if path.endswith("/websocket-ticket"):
                return httpx.Response(200, json={"ticket": "synthetic-ticket"})
            if path.endswith("/metrics"):
                return httpx.Response(200, text="team_call_join_admitted_total 2") if "authorization" in request.headers else httpx.Response(404)
            if path.endswith("/active"):
                return httpx.Response(200, json={"calls": []})
            if request.method == "DELETE":
                return httpx.Response(403 if request.headers["authorization"] == "Bearer session-2" else 200)
            return httpx.Response(200, json={})

        socket = AsyncMock()
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.dict(os.environ, release_configuration(), clear=True), \
             patch.object(smoke.httpx, "AsyncClient", return_value=client), \
             patch.object(smoke.websockets, "connect", return_value=socket), \
             patch.object(smoke, "receive", AsyncMock(return_value={})):
            result = await smoke.validate("https://example.test", "a" * 40)
        self.assertEqual("a" * 40, result["revision"])
        self.assertIn("expected_revision", result["checks"])
        self.assertEqual(("GET", "/health"), calls[-1])
        self.assertEqual(2, calls.count(("GET", "/health")))


if __name__ == "__main__":
    unittest.main()
