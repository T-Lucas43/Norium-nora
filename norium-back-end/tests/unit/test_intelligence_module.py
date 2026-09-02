from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from app.core.tenant import read_user_db
from app.modules.auth import router as auth_router
from app.modules.intelligence.repository import mutate_store, read_store
from app.modules.intelligence import service


def user(user_id: str) -> dict:
    return {"id": user_id, "role": "owner", "plan": "enterprise", "permissions": dict(auth_router.OWNER_PERMISSIONS)}


class IntelligenceModuleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temporary.name})
        self.environment.start()

    async def asyncTearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_private_and_credential_urls_are_rejected(self) -> None:
        for url in ("http://127.0.0.1/admin", "http://localhost/", "http://10.0.0.2/", "https://user:password@example.com/"):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                service.validate_public_url(url)

    async def test_sensitive_browser_plan_waits_for_approval_then_records_evidence(self) -> None:
        account = user("browser-owner")
        profile = await service.create_browser_profile(account, {
            "name": "Operacao supervisionada", "allowedDomains": ["example.com"], "blockedDomains": [],
            "credentialIds": [], "allowDownloads": False, "allowUploads": False,
            "allowForms": True, "retainSession": False, "maxDurationSeconds": 300, "maxActions": 20,
        })
        run = await service.create_browser_plan(
            account,
            {
                "objective": "Enviar o formulario somente depois da aprovacao", "startUrl": "https://example.com",
                "profileId": profile["id"], "maxPages": 1, "maxSteps": 10, "timeoutSeconds": 300,
                "executionMode": "automatic", "expectedResult": "structured", "useAiPlanner": False,
                "actions": [{"type": "click", "target": "Enviar", "value": "", "description": "Enviar formulario"}],
            },
        )
        action = next(item for item in run["plan"] if item["type"] == "click")
        self.assertEqual("sensitive", action["riskClass"])
        self.assertTrue(action["requiresApproval"])
        await mutate_store(
            account["id"],
            lambda store: (
                next(item for item in store["browserRuns"] if item["id"] == run["id"]).update({
                    "status": "awaiting_approval",
                    "pendingApproval": {"actionId": action["id"], "type": "click", "target": "Enviar"},
                }),
                next(item for item in next(entry for entry in store["browserRuns"] if entry["id"] == run["id"])["plan"] if item["id"] == action["id"]).update({"status": "awaiting_approval"}),
            ),
        )
        from app.modules.intelligence.browser_runtime import decide_browser_action

        approved = await decide_browser_action(account, run["id"], action["id"], True, "Aprovado no teste")
        approved_action = next(item for item in approved["plan"] if item["id"] == action["id"])
        self.assertTrue(approved_action["approved"])
        self.assertEqual("pending", approved_action["status"])

    async def test_browser_plan_keeps_domain_policy_snapshot_if_profile_is_deleted(self) -> None:
        account = user("browser-policy-owner")
        profile = await service.create_browser_profile(account, {"name": "Restrito", "allowedDomains": ["example.com"], "blockedDomains": [], "credentialIds": [], "allowDownloads": False, "allowUploads": False, "allowForms": False, "retainSession": False, "maxDurationSeconds": 300, "maxActions": 20})
        run = await service.create_browser_plan(account, {"objective": "Ler pagina publica", "startUrl": "https://example.com", "profileId": profile["id"], "maxPages": 1, "maxSteps": 20, "timeoutSeconds": 300, "executionMode": "assisted", "expectedResult": "summary", "actions": [], "useAiPlanner": False})
        await mutate_store(account["id"], lambda store: store.update({"browserProfiles": []}))
        stored = next(item for item in read_store(account["id"])["browserRuns"] if item["id"] == run["id"])
        self.assertEqual(["example.com"], stored["policySnapshot"]["allowedDomains"])
        self.assertEqual("example.com", stored["host"])

    async def test_browser_credential_can_only_fill_its_own_domain(self) -> None:
        account = user("browser-credential-owner")
        credential = await service.create_browser_credential(account, {
            "label": "Portal", "domain": "example.com", "username": "operador", "password": "segredo-forte",
        })
        profile = {"credentialIds": [credential["id"]]}
        action = {"credentialId": credential["id"], "credentialField": "username"}
        from app.modules.intelligence.browser_runtime import _credential_value

        self.assertEqual("operador", await _credential_value(account, profile, action, "https://app.example.com/login"))
        with self.assertRaises(HTTPException) as blocked:
            await _credential_value(account, profile, action, "https://attacker.example.net/login")
        self.assertEqual(403, blocked.exception.status_code)

    async def test_knowledge_search_returns_citation_and_prevents_duplicates(self) -> None:
        account = user("knowledge-owner")
        base = await service.create_knowledge_base(account, {"name": "Politicas", "description": "", "visibility": "private", "tags": []})
        payload = {"kind": "text", "title": "Politica comercial", "content": "Descontos acima de dez por cento exigem aprovacao da diretoria.", "url": "", "tags": []}
        await service.add_knowledge_source(account, base["id"], payload)
        result = service.search_knowledge(account, "descontos aprovacao", [base["id"]], 5)
        self.assertEqual(1, len(result["results"]))
        self.assertEqual("Politica comercial", result["results"][0]["sourceTitle"])
        self.assertIn("Descontos", result["results"][0]["quote"])
        with self.assertRaises(HTTPException) as error:
            await service.add_knowledge_source(account, base["id"], payload)
        self.assertEqual(409, error.exception.status_code)
        self.assertEqual([], service.search_knowledge(user("other-user"), "descontos", [], 5)["results"])

    async def test_marketplace_installation_creates_disabled_resource_and_preserves_it_on_remove(self) -> None:
        account = user("market-owner")
        installation = await service.install_marketplace(account, "competitor-watch-automation", True)
        automations = read_user_db(account["id"], "automacoes", {})["automations"]
        created = next(item for item in automations if item.get("marketplaceInstallationId") == installation["id"])
        self.assertFalse(created["active"])
        removed = await service.uninstall_marketplace(account, installation["id"])
        self.assertEqual("removed", removed["status"])
        preserved = read_user_db(account["id"], "automacoes", {})["automations"]
        self.assertTrue(any(item["id"] == created["id"] and not item["active"] for item in preserved))

    async def test_model_router_filters_capability_privacy_and_cost(self) -> None:
        account = user("models-owner")
        cheap = await service.save_provider(account, {
            "name": "Privado barato", "provider": "openai-compatible", "model": "private-small", "baseUrl": "https://models.example.com/v1",
            "secret": "segredo-forte", "enabled": True, "capabilities": ["text", "json"], "contextWindow": 32000,
            "inputCostPerMillion": 0.2, "outputCostPerMillion": 0.5, "dataPolicy": "private",
        })
        await service.save_provider(account, {
            "name": "Externo caro", "provider": "openai-compatible", "model": "external-large", "baseUrl": "https://api.example.com/v1",
            "secret": "segredo-forte-2", "enabled": True, "capabilities": ["text", "json"], "contextWindow": 128000,
            "inputCostPerMillion": 10, "outputCostPerMillion": 20, "dataPolicy": "external",
        })
        routed = service.route_model(account, {
            "preferredProviderId": None, "requiredCapabilities": ["text", "json"], "estimatedInputTokens": 1000,
            "estimatedOutputTokens": 500, "privacy": "private", "externalActionCommitted": True,
        })
        self.assertEqual(cheap["id"], routed["selected"]["id"])
        self.assertFalse(routed["fallbackAllowed"])
        self.assertNotIn("encryptedSecret", routed["selected"])

    async def test_model_gateway_executes_adapter_without_exposing_secret_and_records_usage(self) -> None:
        account = user("gateway-owner")
        provider = await service.save_provider(account, {
            "name": "Gateway teste", "provider": "openai-compatible", "model": "model-test", "baseUrl": "https://models.example.com/v1",
            "secret": "segredo-que-nao-pode-vazar", "enabled": True, "capabilities": ["text"], "contextWindow": 32000,
            "inputCostPerMillion": 1, "outputCostPerMillion": 2, "dataPolicy": "private",
        })

        def responder(request: httpx.Request) -> httpx.Response:
            self.assertNotIn("segredo-que-nao-pode-vazar", str(request.url))
            return httpx.Response(200, json={"choices": [{"message": {"content": "Resposta real"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})

        transport_client = httpx.AsyncClient(transport=httpx.MockTransport(responder))
        with (
            patch.object(service, "assert_public_dns", AsyncMock()),
            patch.object(service.httpx, "AsyncClient", return_value=transport_client),
        ):
            answer, metadata = await service.complete_with_provider(account, provider["id"], [{"role": "user", "content": "Teste"}], "Sistema")
        self.assertEqual("Resposta real", answer)
        self.assertNotIn("encryptedSecret", metadata["provider"])
        self.assertEqual(1, len(read_store(account["id"])["modelUsage"]))

    def test_new_routes_follow_granular_permissions(self) -> None:
        free = user("free")
        free.update({"plan": "free", "permissions": auth_router.permissions_for_plan("free")})
        with self.assertRaises(HTTPException):
            auth_router.assert_route_permissions(free, "/api/navegador")
        enterprise = user("enterprise")
        auth_router.assert_route_permissions(enterprise, "/api/navegador")
        auth_router.assert_route_permissions(enterprise, "/api/conhecimento")
        auth_router.assert_route_permissions(enterprise, "/api/marketplace")
        auth_router.assert_route_permissions(enterprise, "/api/modelos-ia")


if __name__ == "__main__":
    unittest.main()
