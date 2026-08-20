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

    async def test_callbacks_ignore_legacy_user_id_without_valid_state(self) -> None:
        gmail = await mail_router.gmail_callback(code="code", state=None, user_id="victim")
        self.assertEqual(400, gmail.status_code)
        calendar = calendar_router.finish_google_oauth("code", None, "victim")
        self.assertEqual(400, calendar.status_code)


if __name__ == "__main__":
    unittest.main()
