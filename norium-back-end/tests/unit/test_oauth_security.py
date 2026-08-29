from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.modules.calendar import router as calendar_router
from app.modules.mail import router as mail_router
from app.services.calendar_service import CalendarConfigError, CalendarService
from app.services.gmail_service import GmailConfigError, GmailService


class OAuthSecurityTests(unittest.IsolatedAsyncioTestCase):
    def test_state_parser_rejects_missing_or_malformed_values(self) -> None:
        self.assertIsNone(GmailService.user_id_from_state(None))
        self.assertIsNone(GmailService.user_id_from_state("victim:chosen-by-attacker"))
        self.assertIsNone(CalendarService.user_id_from_state("victim:1234"))
        gmail_valid = "usr_0123456789abcdef:" + "a" * 32
        calendar_valid = "user-a:" + "a" * 32
        self.assertEqual("usr_0123456789abcdef", GmailService.user_id_from_state(gmail_valid))
        self.assertEqual("user-a", CalendarService.user_id_from_state(calendar_valid))

    def test_gmail_state_parser_rejects_noncanonical_and_oversized_user_ids(self) -> None:
        nonce = "a" * 32
        self.assertIsNone(GmailService.user_id_from_state(f"victim!:{nonce}"))
        self.assertIsNone(GmailService.user_id_from_state(f"../usr_0123456789abcdef:{nonce}"))
        self.assertIsNone(GmailService.user_id_from_state(f"{'u' * 65}:{nonce}"))
        self.assertEqual("lucas123", GmailService.user_id_from_state(f"lucas123:{nonce}"))
        self.assertEqual("norium-admin", GmailService.user_id_from_state(f"norium-admin:{nonce}"))

    def test_gmail_requires_exact_unexpired_state(self) -> None:
        service = GmailService("victim")
        state = "victim:" + "b" * 32
        oauth_state = {
            "state": state,
            "codeVerifier": "verifier",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        with patch.object(service, "_read_profile_section", return_value=oauth_state):
            with self.assertRaises(GmailConfigError):
                service.finish_oauth(code="code", state=None)
            with self.assertRaises(GmailConfigError):
                service.finish_oauth(code="code", state="victim:" + "c" * 32)

    def test_calendar_rejects_expired_state_before_token_exchange(self) -> None:
        service = CalendarService("victim")
        state = "victim:" + "d" * 32
        oauth_state = {
            "state": state,
            "codeVerifier": "verifier",
            "createdAt": (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat(),
        }
        with (
            patch.object(service, "_read_profile_section", return_value=oauth_state),
            patch.object(service, "_write_profile_section") as write_state,
            patch.object(service, "_fetch_token") as fetch_token,
        ):
            with self.assertRaises(CalendarConfigError):
                service.finish_oauth(code="code", state=state)
        write_state.assert_called_once_with("calendarOauthState", {})
        fetch_token.assert_not_called()

    def test_gmail_keeps_other_active_oauth_attempts(self) -> None:
        user_id = "usr_1111111111111111"
        service = GmailService(user_id)
        previous_state = user_id + ":" + "b" * 32
        next_state = user_id + ":" + "c" * 32
        oauth_state = {
            "state": previous_state,
            "codeVerifier": "verifier-anterior",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        class FakeFlow:
            code_verifier = "verifier-novo"

            def authorization_url(self, **_: object) -> tuple[str, str]:
                return "https://accounts.google.com/o/oauth2/auth", next_state

        with (
            patch.object(service, "_read_profile_section", return_value=oauth_state),
            patch.object(service, "_write_profile_section") as write_state,
            patch.object(service, "_flow", return_value=FakeFlow()),
        ):
            result = service.authorization_url()

        self.assertEqual(next_state, result["state"])
        saved = write_state.call_args.args[1]
        self.assertEqual([previous_state, next_state], [item["state"] for item in saved["attempts"]])

    def test_gmail_uses_public_backend_callback_for_new_accounts(self) -> None:
        service = GmailService("usr_2222222222222222")
        with patch.dict(
            os.environ,
            {
                "BACKEND_PUBLIC_URL": "https://api.norium.example/",
                "GMAIL_REDIRECT_URI": "",
                "API_PUBLIC_URL": "",
                "VERCEL_PROJECT_PRODUCTION_URL": "",
                "VERCEL_URL": "",
                "ENVIRONMENT": "development",
                "VERCEL": "",
            },
        ):
            self.assertEqual(
                "https://api.norium.example/api/auth/callback/gmail",
                service._redirect_uri(),
            )

    def test_gmail_explicit_callback_overrides_public_backend(self) -> None:
        service = GmailService("usr_2222222222222222")
        with patch.dict(
            os.environ,
            {
                "BACKEND_PUBLIC_URL": "https://api.norium.example",
                "GMAIL_REDIRECT_URI": "https://oauth.norium.example/gmail/callback",
                "ENVIRONMENT": "development",
                "VERCEL": "",
            },
        ):
            self.assertEqual(
                "https://oauth.norium.example/gmail/callback",
                service._redirect_uri(),
            )

    def test_gmail_can_reuse_google_oauth_client_credentials(self) -> None:
        service = GmailService("norium-admin")
        with patch.dict(
            os.environ,
            {
                "GMAIL_CLIENT_ID": "",
                "GMAIL_CLIENT_SECRET": "",
                "GOOGLE_CLIENT_ID": "shared-client.apps.googleusercontent.com",
                "GOOGLE_CLIENT_SECRET": "shared-secret",
                "GMAIL_REDIRECT_URI": "http://localhost:8000/api/auth/callback/gmail",
                "ENVIRONMENT": "development",
            },
        ):
            config = service._client_config()

        self.assertEqual("shared-client.apps.googleusercontent.com", config["web"]["client_id"])

    def test_gmail_production_replaces_loopback_callback_with_public_backend(self) -> None:
        service = GmailService("usr_2222222222222222")
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "VERCEL": "",
                "BACKEND_PUBLIC_URL": "https://api.norium.example",
                "API_PUBLIC_URL": "",
                "VERCEL_PROJECT_PRODUCTION_URL": "",
                "VERCEL_URL": "",
                "GMAIL_REDIRECT_URI": "http://localhost:8000/api/auth/callback/gmail",
            },
        ):
            self.assertEqual(
                "https://api.norium.example/api/auth/callback/gmail",
                service._redirect_uri(),
            )

    def test_gmail_production_rejects_loopback_without_public_backend(self) -> None:
        service = GmailService("usr_2222222222222222")
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "VERCEL": "",
                "BACKEND_PUBLIC_URL": "",
                "API_PUBLIC_URL": "",
                "VERCEL_PROJECT_PRODUCTION_URL": "",
                "VERCEL_URL": "",
                "GMAIL_REDIRECT_URI": "http://127.0.0.1:8000/api/auth/callback/gmail",
            },
        ):
            with self.assertRaises(GmailConfigError) as raised:
                service._redirect_uri()
        self.assertIn("localhost em producao", str(raised.exception))

    def test_gmail_development_preserves_explicit_loopback_callback(self) -> None:
        service = GmailService("usr_2222222222222222")
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "development",
                "VERCEL": "",
                "BACKEND_PUBLIC_URL": "https://api.norium.example",
                "GMAIL_REDIRECT_URI": "http://localhost:8000/api/auth/callback/gmail",
            },
        ):
            self.assertEqual(
                "http://localhost:8000/api/auth/callback/gmail",
                service._redirect_uri(),
            )

    def test_gmail_oauth_forces_account_selection(self) -> None:
        user_id = "usr_3333333333333333"
        service = GmailService(user_id)
        state = user_id + ":" + "e" * 32

        class FakeFlow:
            code_verifier = "verifier"

            def authorization_url(self, **kwargs: object) -> tuple[str, str]:
                self.kwargs = kwargs
                return "https://accounts.google.com/o/oauth2/auth", state

        flow = FakeFlow()
        with (
            patch.object(service, "_read_profile_section", return_value={}),
            patch.object(service, "_write_profile_section"),
            patch.object(service, "_flow", return_value=flow),
        ):
            service.authorization_url()

        self.assertEqual("offline", flow.kwargs["access_type"])
        self.assertEqual("consent select_account", flow.kwargs["prompt"])
        self.assertEqual("true", flow.kwargs["include_granted_scopes"])

    def test_gmail_explains_google_testing_and_redirect_configuration_errors(self) -> None:
        testing_message = mail_router.gmail_oauth_error_message(
            "access_denied",
            "The developer hasn't given you access to this app. It's currently being tested.",
        )
        self.assertIn("modo de teste", testing_message)
        self.assertIn("Test users", testing_message)

        redirect_message = mail_router.gmail_oauth_error_message("redirect_uri_mismatch", None)
        self.assertIn("callback público", redirect_message)
        self.assertIn("Google Cloud", redirect_message)

        cancelled_message = mail_router.gmail_oauth_error_message("access_denied", None)
        self.assertIn("cancelada", cancelled_message)

    def test_gmail_credentials_remain_isolated_per_norium_user(self) -> None:
        stores: dict[str, dict[str, object]] = {}

        def read_store(user_id: str, _db_name: str, fallback: object) -> object:
            return stores.get(user_id, fallback)

        def write_store(user_id: str, _db_name: str, payload: dict[str, object]) -> None:
            stores[user_id] = dict(payload)

        with (
            patch("app.services.gmail_service.read_account_db", side_effect=read_store),
            patch("app.services.gmail_service.write_account_db", side_effect=write_store),
        ):
            first = GmailService("usr_first")
            second = GmailService("usr_second")
            first._write_profile_section("gmailToken", {"refresh_token": "token-first"})
            second._write_profile_section("gmailToken", {"refresh_token": "token-second"})

            self.assertEqual(
                "token-first",
                first._read_profile_section("gmailToken", {})["refresh_token"],
            )
            self.assertEqual(
                "token-second",
                second._read_profile_section("gmailToken", {})["refresh_token"],
            )

    async def test_gmail_routes_start_and_finish_oauth_for_the_resolved_user(self) -> None:
        secondary_user = "usr_4444444444444444"
        state = secondary_user + ":" + "f" * 32
        with patch.object(mail_router, "GmailService") as service_class:
            service_class.return_value.authorization_url.return_value = {
                "auth_url": "https://accounts.google.com/o/oauth2/auth",
                "state": state,
            }
            result = await mail_router.gmail_auth_url({"id": secondary_user})

        self.assertEqual(state, result["state"])
        service_class.assert_called_once_with(secondary_user)

        with patch.object(
            GmailService,
            "finish_oauth",
            autospec=True,
            return_value={"connected": True},
        ) as finish:
            response = await mail_router.gmail_callback(
                code="oauth-code",
                state=state,
                error=None,
                error_description=None,
            )

        self.assertIn("Gmail conectado", response)
        self.assertEqual(secondary_user, finish.call_args.args[0].user_id)
        self.assertEqual("oauth-code", finish.call_args.kwargs["code"])
        self.assertEqual(state, finish.call_args.kwargs["state"])

    async def test_gmail_callback_rejects_noncanonical_state_before_store_access(self) -> None:
        state = "../victim:" + "a" * 32
        with patch.object(GmailService, "cancel_oauth") as cancel:
            response = await mail_router.gmail_callback(
                code=None,
                state=state,
                error="access_denied",
                error_description=None,
            )
        self.assertEqual(400, response.status_code)
        cancel.assert_not_called()

    def test_calendar_uses_public_backend_callback_in_production(self) -> None:
        service = CalendarService("norium-admin")
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "VERCEL": "",
                "BACKEND_PUBLIC_URL": "https://norium.example/",
                "API_PUBLIC_URL": "",
                "VERCEL_PROJECT_PRODUCTION_URL": "",
                "VERCEL_URL": "",
                "GOOGLE_REDIRECT_URI": "http://localhost:8000/api/integracoes/google/callback",
            },
        ):
            self.assertEqual(
                "https://norium.example/api/integracoes/google/callback",
                service._redirect_uri(),
            )

    def test_calendar_can_reuse_gmail_oauth_client_credentials(self) -> None:
        service = CalendarService("norium-admin")
        with (
            patch.object(service, "_legacy_tokens", return_value=None),
            patch.dict(
                os.environ,
                {
                    "GOOGLE_CLIENT_ID": "",
                    "GOOGLE_CLIENT_SECRET": "",
                    "GMAIL_CLIENT_ID": "shared-client.apps.googleusercontent.com",
                    "GMAIL_CLIENT_SECRET": "shared-secret",
                    "GOOGLE_REDIRECT_URI": "http://localhost:8000/api/integracoes/google/callback",
                    "ENVIRONMENT": "development",
                },
            ),
        ):
            config = service._client_config()

        self.assertEqual("shared-client.apps.googleusercontent.com", config["web"]["client_id"])

    async def test_gmail_callback_survives_cancel_persistence_failure(self) -> None:
        state = "usr_5555555555555555:" + "a" * 32
        with patch.object(GmailService, "cancel_oauth", side_effect=OSError("storage unavailable")):
            response = await mail_router.gmail_callback(
                code=None,
                state=state,
                error="access_denied",
                error_description=None,
            )
        self.assertEqual(400, response.status_code)
        self.assertIn("Gmail não conectado", response.body.decode("utf-8"))

    async def test_callbacks_ignore_legacy_user_id_without_valid_state(self) -> None:
        gmail = await mail_router.gmail_callback(code="code", state=None, user_id="victim")
        self.assertEqual(400, gmail.status_code)
        gmail_html = gmail.body.decode("utf-8")
        self.assertIn('name="viewport"', gmail_html)
        self.assertIn('href="/"', gmail_html)
        self.assertNotIn("#/", gmail_html)
        calendar = calendar_router.finish_google_oauth("code", None, "victim")
        self.assertEqual(400, calendar.status_code)
        calendar_html = calendar.body.decode("utf-8")
        self.assertIn('name="viewport"', calendar_html)
        self.assertIn('href="/"', calendar_html)
        self.assertNotIn("#/", calendar_html)

    def test_oauth_success_page_uses_clean_norium_url(self) -> None:
        page = calendar_router.oauth_success_html()
        self.assertIn("Google Agenda conectado", page)
        self.assertIn('href="/"', page)
        self.assertNotIn("#/", page)


if __name__ == "__main__":
    unittest.main()
