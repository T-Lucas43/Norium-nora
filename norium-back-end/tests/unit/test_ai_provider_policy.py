from __future__ import annotations

import json
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from app.core.ai_provider_policy import approved_provider, ProviderPolicyError
from app.core.request_context import set_request_context, reset_request_context
from app.modules.intelligence import service
from app.modules.nora.brain.planner import Planner, sanitize
from app.modules.nora.brain.contracts import BrainError


USER = {"id": "member-a", "teamOwnerId": "tenant-a"}


class ProviderPolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"NORIUM_AI_PROVIDER_POLICY": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        context = set_request_context(USER["id"], "primary")
        self.addCleanup(reset_request_context, context)

    def test_default_allows_only_official_endpoints(self):
        for kind in ("groq", "openai", "google", "gemini"):
            self.assertTrue(approved_provider(USER, {"provider": kind})[1].startswith("https://"))
        for provider in ({"provider": "anthropic"}, {"provider": "openai-compatible"},
                         {"provider": "groq", "baseUrl": "https://attacker.example/v1"},
                         {"provider": "openai", "baseUrl": "http://api.openai.com/v1"},
                         {"provider": "openai", "baseUrl": "https://api.openai.com/v1?secret=x"}):
            with self.subTest(provider=provider), self.assertRaises(ProviderPolicyError):
                approved_provider(USER, provider)

    def test_explicit_custom_approval_is_tenant_and_workspace_scoped(self):
        custom = {"providers": ["openai-compatible"], "endpoints": {
            "openai-compatible": ["https://models.example.com/v1"]}}
        os.environ["NORIUM_AI_PROVIDER_POLICY"] = json.dumps({"tenant-a": {"primary": custom}})
        provider = {"provider": "openai-compatible", "baseUrl": "https://models.example.com/v1"}
        self.assertEqual(("openai-compatible", provider["baseUrl"]), approved_provider(USER, provider))
        with self.assertRaises(ProviderPolicyError):
            approved_provider({"id": "tenant-b"}, provider)
        context = set_request_context(USER["id"], "second")
        try:
            with self.assertRaises(ProviderPolicyError):
                approved_provider(USER, provider)
        finally:
            reset_request_context(context)

    def test_invalid_and_empty_policies_fail_closed(self):
        for raw in ("{invalid", "[]", '{"tenant-a":{"primary":{"providers":[]}}}',
                    '{"tenant-a":{"primary":{"providers":"openai"}}}'):
            os.environ["NORIUM_AI_PROVIDER_POLICY"] = raw
            with self.subTest(raw=raw), self.assertRaises(ProviderPolicyError):
                approved_provider(USER, {"provider": "openai"})

    async def test_gateway_blocks_before_secret_dns_meter_and_http(self):
        provider = {"id": "provider-x", "provider": "anthropic", "encryptedSecret": "private-ciphertext"}
        with (patch.object(service, "all_providers", return_value=[provider]),
              patch.object(service, "decrypt_secret", Mock()) as secret,
              patch.object(service, "assert_public_dns", AsyncMock()) as dns,
              patch.object(service, "Meter", Mock()) as meter,
              patch.object(service.httpx, "AsyncClient", Mock()) as client):
            with self.assertRaises(HTTPException) as error:
                await service.complete_with_provider(USER, "provider-x", [{"role": "user", "content": "private"}], "system")
            self.assertEqual(403, error.exception.status_code)
            secret.assert_not_called(); dns.assert_not_called(); meter.assert_not_called(); client.assert_not_called()

    def test_brain_policy_denies_before_preflight_key_lookup(self):
        os.environ["NORIUM_AI_PROVIDER_POLICY"] = '{"tenant-a":{"primary":{"providers":[]}}}'
        with self.assertRaisesRegex(BrainError, "provider_not_approved"):
            Planner().authorize(USER)

    def test_planner_uses_common_minimizer_without_confusing_phone_with_cpf(self):
        original = "celular 11987654321 CPF 529.982.247-25 cartão 4111 1111 1111 1111 Bearer synthetic-secret"
        cleaned = sanitize({"payload": [original], "access_token": "never-forward"})
        self.assertIn("11987654321", cleaned["payload"][0])
        for sensitive in ("529.982.247-25", "4111 1111 1111 1111", "synthetic-secret", "never-forward"):
            self.assertNotIn(sensitive, str(cleaned))
        self.assertNotIn("access_token", cleaned)
