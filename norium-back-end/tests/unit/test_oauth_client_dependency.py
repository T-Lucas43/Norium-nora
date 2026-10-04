"""Exercise the maintained OAuth client library with synthetic credentials only."""
from __future__ import annotations

import base64
import hashlib
import json
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import requests

from app.services.gmail_service import GmailService
from app.services.calendar_service import CalendarService


CONFIG = {"web": {
    "client_id": "synthetic-client.apps.googleusercontent.com",
    "client_secret": "synthetic-client-secret",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
}}
CALLBACK = "https://norium.example/api/auth/callback/gmail"
VERIFIER = "synthetic-verifier-for-dependency-regression-only-1234567890"


def token_response() -> requests.Response:
    response = requests.Response()
    response.status_code = 200
    response._content = json.dumps({
        "access_token": "synthetic-access", "refresh_token": "synthetic-refresh",
        "token_type": "Bearer", "expires_in": 3600,
    }).encode()
    response.request = requests.Request("POST", "https://oauth2.googleapis.com/token").prepare()
    return response


class OAuthClientDependencyTests(unittest.TestCase):
    def flow(self, service_class=GmailService):
        service = service_class("usr_dependency_test")
        with patch.object(service, "_client_config", return_value=CONFIG), patch.object(service, "_redirect_uri", return_value=CALLBACK):
            return service._flow(state="synthetic-state", code_verifier=VERIFIER)

    def test_gmail_and_calendar_generate_pkce_with_original_state_and_callback(self):
        expected = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
        for service_class in (GmailService, CalendarService):
            with self.subTest(service=service_class.__name__):
                flow = self.flow(service_class)
                url, state = flow.authorization_url(access_type="offline")
                params = parse_qs(urlparse(url).query)
                self.assertEqual("synthetic-state", state)
                self.assertEqual([CALLBACK], params["redirect_uri"])
                self.assertEqual(["S256"], params["code_challenge_method"])
                self.assertEqual([expected], params["code_challenge"])
                self.assertNotIn(VERIFIER, url)

    def test_code_exchange_retains_pkce_and_callback_without_network(self):
        flow = self.flow()
        with patch.object(flow.oauth2session, "request", return_value=token_response()) as request:
            result = flow.fetch_token(code="synthetic-code")
        self.assertEqual("synthetic-access", result["access_token"])
        body = dict(request.call_args.kwargs["data"])
        self.assertEqual("authorization_code", body["grant_type"])
        self.assertEqual(VERIFIER, body["code_verifier"])
        self.assertEqual(CALLBACK, body["redirect_uri"])
        self.assertEqual("synthetic-code", body["code"])
        self.assertEqual("https://oauth2.googleapis.com/token", request.call_args.kwargs["url"])

    def test_refresh_exchange_retains_existing_refresh_token_without_network(self):
        flow = self.flow()
        with patch.object(flow.oauth2session, "post", return_value=token_response()) as request:
            result = flow.oauth2session.refresh_token(
                CONFIG["web"]["token_uri"], refresh_token="synthetic-refresh",
                client_id=CONFIG["web"]["client_id"], client_secret=CONFIG["web"]["client_secret"],
            )
        self.assertEqual("synthetic-refresh", result["refresh_token"])
        body = dict(request.call_args.kwargs["data"])
        self.assertEqual("refresh_token", body["grant_type"])
        self.assertEqual("synthetic-refresh", body["refresh_token"])


if __name__ == "__main__":
    unittest.main()
