from __future__ import annotations

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
        valid = "user-a:" + "a" * 32
        self.assertEqual("user-a", GmailService.user_id_from_state(valid))
        self.assertEqual("user-a", CalendarService.user_id_from_state(valid))

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
        service = GmailService("victim")
        previous_state = "victim:" + "b" * 32
        next_state = "victim:" + "c" * 32
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
