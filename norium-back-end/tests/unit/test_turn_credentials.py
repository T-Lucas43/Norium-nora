from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import bootstrap
from app.modules.team import router as team_router
from app.modules.team.turn_credentials import (
    HmacTurnCredentialProvider,
    TurnConfigurationError,
    TurnSubject,
    TurnUnavailableError,
    UnavailableTurnCredentialProvider,
    turn_provider_from_environment,
    validate_turn_configuration,
)


NOW = datetime(2024, 1, 1, tzinfo=timezone.utc)
SECRET = "0123456789abcdef0123456789abcdef"


class TurnCredentialProviderTests(unittest.TestCase):
    def test_issues_short_lived_stun_and_turn_tls_credentials(self) -> None:
        provider = HmacTurnCredentialProvider(
            stun_urls=("stun:stun.example.test:3478",),
            turn_urls=(
                "turn:turn.example.test:3478?transport=udp",
                "turns:turn.example.test:5349?transport=tcp",
            ),
            shared_secret=SECRET,
            ttl_seconds=300,
            refresh_margin_seconds=60,
            now=lambda: NOW,
        )

        payload = provider.issue(TurnSubject(team_id="team-owner", user_id="member-1")).as_payload()

        self.assertEqual("2024-01-01T00:05:00+00:00", payload["expiresAt"])
        self.assertEqual("2024-01-01T00:04:00+00:00", payload["refreshAfter"])
        self.assertEqual(["stun:stun.example.test:3478"], payload["iceServers"][0]["urls"])
        self.assertEqual(
            [
                "turn:turn.example.test:3478?transport=udp",
                "turns:turn.example.test:5349?transport=tcp",
            ],
            payload["iceServers"][1]["urls"],
        )
        self.assertEqual("1704067500:0dEyXdW_o59YdUZ3", payload["iceServers"][1]["username"])
        self.assertEqual("s0R6dXDeryAqlTRB8CweEIKnUO0=", payload["iceServers"][1]["credential"])
        self.assertEqual("password", payload["iceServers"][1]["credentialType"])
        self.assertNotIn(SECRET, json.dumps(payload))

    def test_rejects_partial_or_non_tls_configuration(self) -> None:
        cases = (
            {"TEAM_CALL_TURN_URLS": "turns:turn.example.test:5349?transport=tcp"},
            {"TEAM_CALL_TURN_SHARED_SECRET": SECRET},
            {
                "TEAM_CALL_TURN_URLS": "turn:turn.example.test:3478?transport=udp",
                "TEAM_CALL_TURN_SHARED_SECRET": SECRET,
            },
            {
                "TEAM_CALL_TURN_URLS": "turns:user:password@turn.example.test:5349?transport=tcp",
                "TEAM_CALL_TURN_SHARED_SECRET": SECRET,
            },
            {
                "TEAM_CALL_TURN_URLS": "turns:",
                "TEAM_CALL_TURN_SHARED_SECRET": SECRET,
            },
            {
                "TEAM_CALL_TURN_URLS": "turns:turn.example.test:invalid?transport=tcp",
                "TEAM_CALL_TURN_SHARED_SECRET": SECRET,
            },
            {
                "TEAM_CALL_TURN_URLS": "turns:turn.example.test:5349?transport=http",
                "TEAM_CALL_TURN_SHARED_SECRET": SECRET,
            },
            {
                "TEAM_CALL_TURN_URLS": "turns:turn.example.test:5349?transport=tcp",
                "TEAM_CALL_TURN_SHARED_SECRET": f" {SECRET}",
            },
        )
        for environ in cases:
            with self.subTest(environ=environ), self.assertRaises(TurnConfigurationError):
                validate_turn_configuration(environ)

    def test_absent_optional_provider_is_explicitly_unavailable(self) -> None:
        provider = turn_provider_from_environment({})
        self.assertIsInstance(provider, UnavailableTurnCredentialProvider)
        with self.assertRaisesRegex(TurnUnavailableError, "não está configurado"):
            provider.issue(TurnSubject(team_id="team-owner", user_id="member-1"))

    def test_required_provider_fails_validation_when_absent(self) -> None:
        with self.assertRaisesRegex(TurnConfigurationError, "obrigatório"):
            validate_turn_configuration({"TEAM_CALL_TURN_REQUIRED": "true"})

    def test_application_startup_fails_on_invalid_turn_configuration(self) -> None:
        with patch.object(
            bootstrap,
            "validate_turn_configuration",
            side_effect=TurnConfigurationError("configuração TURN inválida"),
        ):
            with self.assertRaisesRegex(TurnConfigurationError, "TURN inválida"):
                bootstrap.create_app()


class TurnCredentialEndpointTests(unittest.TestCase):
    def client_for(self, user: dict[str, object] | None = None) -> TestClient:
        app = FastAPI()
        app.include_router(team_router.router)
        if user is not None:
            app.dependency_overrides[team_router.current_user] = lambda: user
        return TestClient(app)

    def test_authenticated_team_member_receives_non_cacheable_credentials(self) -> None:
        provider = HmacTurnCredentialProvider(
            stun_urls=("stun:stun.example.test:3478",),
            turn_urls=("turns:turn.example.test:5349?transport=tcp",),
            shared_secret=SECRET,
            ttl_seconds=300,
            refresh_margin_seconds=60,
            now=lambda: NOW,
        )
        user = {
            "id": "member-1",
            "teamOwnerId": "team-owner",
            "status": "ativo",
            "permissions": {"chat": True},
        }
        with patch.object(team_router, "turn_credential_provider", return_value=provider):
            response = self.client_for(user).get("/api/team-chat/calls/ice-servers")

        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("no-store, private", response.headers["cache-control"])
        self.assertEqual("no-cache", response.headers["pragma"])
        self.assertEqual("1704067500:0dEyXdW_o59YdUZ3", response.json()["iceServers"][1]["username"])
        self.assertNotIn(SECRET, response.text)

    def test_rejects_anonymous_inactive_and_unauthorized_users(self) -> None:
        anonymous = self.client_for().get("/api/team-chat/calls/ice-servers")
        self.assertEqual(401, anonymous.status_code)

        for user in (
            {"id": "member-1", "teamOwnerId": "team-owner", "status": "inativo", "permissions": {"chat": True}},
            {"id": "member-1", "teamOwnerId": "team-owner", "status": "ativo", "permissions": {}},
        ):
            with self.subTest(user=user):
                response = self.client_for(user).get("/api/team-chat/calls/ice-servers")
                self.assertEqual(403, response.status_code, response.text)

    def test_reports_unavailable_provider_without_leaking_configuration(self) -> None:
        user = {
            "id": "member-1",
            "teamOwnerId": "team-owner",
            "status": "ativo",
            "permissions": {"equipe": True},
        }
        with patch.object(
            team_router,
            "turn_credential_provider",
            return_value=UnavailableTurnCredentialProvider(),
        ):
            response = self.client_for(user).get("/api/team-chat/calls/ice-servers")

        self.assertEqual(503, response.status_code)
        self.assertEqual("O serviço TURN está temporariamente indisponível.", response.json()["detail"])
        self.assertEqual("no-store, private", response.headers["cache-control"])
        self.assertEqual("no-cache", response.headers["pragma"])


if __name__ == "__main__":
    unittest.main()
