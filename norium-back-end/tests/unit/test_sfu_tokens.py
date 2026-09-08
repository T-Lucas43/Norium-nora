from __future__ import annotations

import base64
import asyncio
import copy
import hashlib
import hmac
import json
import unittest
from datetime import datetime, timezone
from typing import Any
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import bootstrap
from app.modules.team import router as team_router
from app.modules.team.call_coordinator import (
    CallActor,
    CallCoordinator,
    CallState,
    TeamCallAuthorizer,
)

from app.modules.team.sfu_tokens import (
    LiveKitTokenProvider,
    SfuConfigurationError,
    SfuTokenSubject,
    UnavailableSfuTokenProvider,
    sfu_provider_from_environment,
)


NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)
SECRET = "".join('0123456789abcdef' for _ in range(2))  # Public synthetic test vector.


def decode_segment(segment: str) -> dict[str, object]:
    padding = "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(segment + padding))


class SfuConfigurationTests(unittest.TestCase):
    def test_sfu_is_disabled_by_default(self) -> None:
        provider = sfu_provider_from_environment({})

        self.assertIsInstance(provider, UnavailableSfuTokenProvider)

    def test_enabled_livekit_requires_complete_configuration(self) -> None:
        with self.assertRaisesRegex(SfuConfigurationError, "URL, chave e segredo"):
            sfu_provider_from_environment({"TEAM_CALL_SFU_ENABLED": "true"})

    def test_enabled_livekit_uses_explicit_provider_configuration(self) -> None:
        environ = {
            "TEAM_CALL_SFU_ENABLED": "true",
            "TEAM_CALL_LIVEKIT_URL": "wss://livekit.example.test",
            "TEAM_CALL_LIVEKIT_API_KEY": "norium-key",
            "TEAM_CALL_LIVEKIT_API_SECRET": SECRET,
            "TEAM_CALL_SFU_TOKEN_TTL_SECONDS": "240",
        }

        self.assertIsInstance(sfu_provider_from_environment(environ), LiveKitTokenProvider)


class LiveKitTokenProviderTests(unittest.TestCase):
    def test_issues_short_token_restricted_to_room_and_participant(self) -> None:
        provider = LiveKitTokenProvider(
            server_url="wss://livekit.example.test",
            api_key="norium-key",
            api_secret=SECRET,
            ttl_seconds=300,
            now=lambda: NOW,
            token_id_factory=lambda: "token-id-fixed",
        )

        document = provider.issue(SfuTokenSubject(
            team_id="team-owner",
            call_id="call_0123456789abcdef",
            user_id="member-1",
            media_session_id="media-session-fixed",
        ))
        header_segment, payload_segment, signature_segment = document.token.split(".")
        claims = decode_segment(payload_segment)
        expected_signature = base64.urlsafe_b64encode(hmac.new(
            SECRET.encode(),
            f"{header_segment}.{payload_segment}".encode(),
            hashlib.sha256,
        ).digest()).decode().rstrip("=")

        self.assertEqual({"alg": "HS256", "typ": "JWT"}, decode_segment(header_segment))
        self.assertEqual("norium-key", claims["iss"])
        self.assertEqual(
            "participant-1596bc6d4b89878066bba62aee570add66303587",
            claims["sub"],
        )
        self.assertEqual('{"userId":"member-1"}', claims["metadata"])
        self.assertEqual("token-id-fixed", claims["jti"])
        self.assertEqual(1788609600, claims["iat"])
        self.assertEqual(1788609900, claims["exp"])
        self.assertEqual({
            "roomJoin": True,
            "room": "team-call-34f6464d28fc0503fbe05ea5f88454b3",
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": False,
            "canUpdateOwnMetadata": False,
            "canPublishSources": [
                "microphone",
                "camera",
                "screen_share",
                "screen_share_audio",
            ],
        }, claims["video"])
        self.assertEqual(expected_signature, signature_segment)
        self.assertEqual("wss://livekit.example.test", document.server_url)
        self.assertEqual("wss://livekit.example.test", document.as_payload()["serverUrl"])
        self.assertEqual("2026-09-05T12:05:00+00:00", document.as_payload()["expiresAt"])
        self.assertNotIn(SECRET, json.dumps(document.as_payload()))
        for elevated_grant in ("roomAdmin", "roomCreate", "roomList", "roomRecord"):
            self.assertNotIn(elevated_grant, claims["video"])

    def test_participant_identity_is_bound_to_exact_media_session(self) -> None:
        provider = LiveKitTokenProvider(
            server_url="wss://livekit.example.test",
            api_key="norium-key",
            api_secret=SECRET,
            now=lambda: NOW,
        )

        subjects = [
            SfuTokenSubject("team", "call_0123456789abcdef", "member", media_session_id)
            for media_session_id in ("media-one", "media-two")
        ]
        identities = [
            decode_segment(provider.issue(subject).token.split(".")[1])["sub"]
            for subject in subjects
        ]

        self.assertNotEqual(*identities)


class _MemoryCallStore:
    def __init__(self) -> None:
        self.state = CallState()

    async def load(self, team_id: str) -> CallState:
        del team_id
        return self.state.clone()

    async def save(
        self,
        team_id: str,
        state: CallState,
        *,
        append_messages: tuple[dict[str, Any], ...] = (),
    ) -> None:
        del team_id, append_messages
        self.state = state.clone()


class _SilentPublisher:
    async def send_to_users(
        self, team_id: str, user_ids: set[str], payload: dict[str, Any],
    ) -> None:
        del team_id, user_ids, payload

    async def online_users(self, team_id: str) -> list[str]:
        del team_id
        return []


class _ActiveDirectory:
    async def active_member_ids(self, actor: CallActor) -> set[str]:
        return {actor.user_id}

    async def subteam_member_ids(
        self, actor: CallActor, subteam_id: str,
    ) -> set[str] | None:
        del actor, subteam_id
        return None


class SfuTokenEndpointTests(unittest.TestCase):
    def test_joined_client_receives_non_cacheable_sfu_access(self) -> None:
        coordinator = CallCoordinator(
            store=_MemoryCallStore(),
            publisher=_SilentPublisher(),
            authorizer=TeamCallAuthorizer(_ActiveDirectory()),
            media_transport_for_team=lambda _team_id: "sfu",
            media_session_id_factory=lambda: "endpoint-media-session",
        )
        actor = CallActor(user_id="member-1", team_id="team-owner", name="Member")
        asyncio.run(coordinator.handle_event(actor, {
            "type": "CALL_INVITE",
            "callId": "call_0123456789abcdef",
            "scope": "team",
            "clientId": "member-tab",
        }))
        provider = LiveKitTokenProvider(
            server_url="wss://livekit.example.test",
            api_key="norium-key",
            api_secret=SECRET,
            ttl_seconds=300,
            now=lambda: NOW,
            token_id_factory=lambda: "endpoint-token",
        )
        app = FastAPI()
        app.include_router(team_router.router)
        app.dependency_overrides[team_router.current_user] = lambda: {
            "id": "member-1",
            "nome": "Member",
            "teamOwnerId": "team-owner",
            "status": "ativo",
            "permissions": {"equipe": True},
        }
        app.dependency_overrides[team_router.sfu_token_provider] = lambda: provider

        with patch.object(team_router, "_call_coordinator_instance", coordinator):
            response = TestClient(app).post(
                "/api/team-chat/calls/call_0123456789abcdef/media-token",
                json={"clientId": "member-tab"},
            )

        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("no-store, private", response.headers["cache-control"])
        self.assertEqual(
            {"serverUrl", "token", "expiresAt"},
            set(response.json()),
        )
        endpoint_claims = decode_segment(response.json()["token"].split(".")[1])
        expected_identity = hashlib.sha256(
            (
                "team-owner\0call_0123456789abcdef\0member-1"
                "\0endpoint-media-session"
            ).encode()
        ).hexdigest()[:40]
        self.assertEqual(f"participant-{expected_identity}", endpoint_claims["sub"])
        self.assertEqual('{"userId":"member-1"}', endpoint_claims["metadata"])
        self.assertNotIn(SECRET, response.text)

    def test_rejected_client_is_non_cacheable_and_never_reaches_provider(self) -> None:
        coordinator = CallCoordinator(
            store=_MemoryCallStore(),
            publisher=_SilentPublisher(),
            authorizer=TeamCallAuthorizer(_ActiveDirectory()),
            media_transport_for_team=lambda _team_id: "sfu",
        )
        actor = CallActor(user_id="member-1", team_id="team-owner", name="Member")
        asyncio.run(coordinator.handle_event(actor, {
            "type": "CALL_INVITE",
            "callId": "call_0123456789abcdef",
            "scope": "team",
            "clientId": "current-tab",
        }))
        provider = Mock()
        app = FastAPI()
        app.include_router(team_router.router)
        app.dependency_overrides[team_router.current_user] = lambda: {
            "id": "member-1",
            "nome": "Member",
            "teamOwnerId": "team-owner",
            "status": "ativo",
            "permissions": {"equipe": True},
        }
        app.dependency_overrides[team_router.sfu_token_provider] = lambda: provider

        with patch.object(team_router, "_call_coordinator_instance", coordinator):
            response = TestClient(app).post(
                "/api/team-chat/calls/call_0123456789abcdef/media-token",
                json={"clientId": "stale-tab"},
            )

        self.assertEqual(409, response.status_code)
        self.assertEqual("call_session_mismatch", response.headers["x-call-error-code"])
        self.assertEqual("no-store, private", response.headers["cache-control"])
        provider.issue.assert_not_called()


class SfuStartupValidationTests(unittest.TestCase):
    def test_application_startup_validates_sfu_configuration(self) -> None:
        with patch.object(
            bootstrap,
            "validate_sfu_configuration",
            side_effect=SfuConfigurationError("configuracao SFU invalida"),
        ):
            with self.assertRaisesRegex(SfuConfigurationError, "SFU invalida"):
                bootstrap.create_app()


if __name__ == "__main__":
    unittest.main()
