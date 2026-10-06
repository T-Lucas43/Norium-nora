"""Exercise the real Google/requests/OAuthLib client stack with synthetic HTTP."""
from __future__ import annotations

import base64
import hashlib
import json
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from oauthlib.oauth2 import MissingTokenError
from requests import Response

from app.services.calendar_service import CalendarService
from app.services.gmail_service import GmailService


class GoogleOAuthDependencyContractTests(unittest.TestCase):
    CLIENT_CONFIG = {"web": {
        "client_id": "synthetic-client.apps.googleusercontent.com",
        "client_secret": "synthetic-client-secret",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }}
    REDIRECT_URI = "https://norium.example/test-oauth-callback"

    def flow_for(self, service):
        with (
            patch.object(service, "_client_config", return_value=self.CLIENT_CONFIG),
            patch.object(service, "_redirect_uri", return_value=self.REDIRECT_URI),
        ):
            return service._flow(state="synthetic-user:" + "a" * 32)

    @staticmethod
    def respond_with(payload):
        response = Response()
        response.status_code = 200
        response.headers["Content-Type"] = "application/json"
        response._content = json.dumps(payload).encode("utf-8")
        def send(request, **_):
            response.request = request
            return response

        return send

    def test_google_clients_preserve_pkce_and_parse_token_response(self):
        for service_class in (GmailService, CalendarService):
            with self.subTest(service=service_class.__name__):
                service = service_class("synthetic-user")
                flow = self.flow_for(service)
                auth_url, state = flow.authorization_url(access_type="offline")
                query = parse_qs(urlsplit(auth_url).query)
                verifier = flow.code_verifier
                challenge = base64.urlsafe_b64encode(
                    hashlib.sha256(verifier.encode("ascii")).digest()
                ).rstrip(b"=").decode("ascii")
                self.assertEqual([state], query["state"])
                self.assertEqual(["S256"], query["code_challenge_method"])
                self.assertEqual([challenge], query["code_challenge"])
                self.assertEqual([self.REDIRECT_URI], query["redirect_uri"])
                callback_flow = self.flow_for(service)
                callback_flow.code_verifier = verifier
                token_response = self.respond_with({
                    "access_token": "synthetic-access-token",
                    "refresh_token": "synthetic-refresh-token",
                    "token_type": "Bearer", "expires_in": 3600,
                    "scope": " ".join(callback_flow.oauth2session.scope),
                })
                with patch("requests.sessions.Session.send", side_effect=token_response) as send:
                    service._fetch_token(callback_flow, "synthetic-authorization-code")
                request = send.call_args.args[0]
                self.assertEqual("POST", request.method)
                self.assertEqual(self.CLIENT_CONFIG["web"]["token_uri"], request.url)
                body = request.body.decode() if isinstance(request.body, bytes) else request.body
                token_query = parse_qs(body)
                self.assertEqual([verifier], token_query["code_verifier"])
                self.assertEqual(["synthetic-authorization-code"], token_query["code"])
                self.assertEqual(["authorization_code"], token_query["grant_type"])
                self.assertEqual("synthetic-access-token", callback_flow.credentials.token)
                self.assertEqual("synthetic-refresh-token", callback_flow.credentials.refresh_token)
                self.assertTrue(callback_flow.credentials.valid)

    def test_google_clients_reject_token_response_without_access_token(self):
        for service_class in (GmailService, CalendarService):
            with self.subTest(service=service_class.__name__):
                service = service_class("synthetic-user")
                flow = self.flow_for(service)
                with (
                    patch("requests.sessions.Session.send", side_effect=self.respond_with({
                        "token_type": "Bearer", "expires_in": 3600,
                    })),
                    self.assertRaises(MissingTokenError),
                ):
                    service._fetch_token(flow, "synthetic-authorization-code")
