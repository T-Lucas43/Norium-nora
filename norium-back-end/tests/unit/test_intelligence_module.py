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
        run = await service.create_browser_plan(
            account,
            {"objective": "Entrar na conta e ler o painel", "startUrl": "https://example.com", "profileId": None, "maxPages": 1},
        )
        waiting = await service.execute_browser_run(account, run["id"])
        self.assertEqual("awaiting_approval", waiting["status"])

        await mutate_store(
            account["id"],
            lambda store: next(item for item in store["browserRuns"] if item["id"] == run["id"]).update({"approved": True, "status": "planned"}),
        )
        page = {"url": "https://example.com", "host": "example.com", "title": "Example", "text": "Fato verificavel da pagina.", "bytes": 30, "contentType": "text/html"}
        with patch.object(service, "safe_fetch", AsyncMock(return_value=page)):
            completed = await service.execute_browser_run(account, run["id"])
        self.assertEqual("completed", completed["status"])
        self.assertTrue(completed["result"]["readOnly"])
        self.assertIn("Fato verificavel", completed["result"]["summary"])

    async def test_browser_plan_keeps_domain_policy_snapshot_if_profile_is_deleted(self) -> None:
        account = user("browser-policy-owner")
        profile = await service.create_browser_profile(account, {"name": "Restrito", "allowedDomains": ["example.com"], "blockedDomains": [], "allowDownloads": False, "retainSession": False})
        run = await service.create_browser_plan(account, {"objective": "Ler pagina publica", "startUrl": "https://example.com", "profileId": profile["id"], "maxPages": 1})
        await mutate_store(account["id"], lambda store: store.update({"browserProfiles": []}))
        page = {"url": "https://example.com", "host": "example.com", "title": "Example", "text": "Conteudo", "links": [], "bytes": 10, "contentType": "text/html"}
        with patch.object(service, "safe_fetch", AsyncMock(return_value=page)) as fetch:
            await service.execute_browser_run(account, run["id"])
        self.assertEqual(["example.com"], fetch.await_args.args[1])

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
