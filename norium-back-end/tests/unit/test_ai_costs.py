from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException

from app.core.request_context import current_ai_user_id, reset_request_context, set_ai_user_id, set_request_context
from app.core.tenant import write_user_db
from app.modules.auth import ai_costs_router
from app.modules.intelligence import service
from app.services import ai_costs as costs
from app.services.nora import NoraIAService, NoraIncompleteResponse

GROQ = {"id": "nora-runtime", "provider": "groq", "model": "openai/gpt-oss-20b", "managed": True, "name": "Nora"}
GEMINI = {"id": "gemini-runtime", "provider": "google", "model": "gemini-3.7-flash", "managed": True, "name": "Gemini"}
USERS = [{"id": "a", "nome": "Ana", "email": "ana@example.test"}, {"id": "b", "nome": "Bruno"}]


class AiCostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temp.name, "GROQ_API_KEY": "test-key", "GEMINI_API_KEY": "test-key", "NORA_MODEL": GROQ["model"], "GEMINI_MODEL": GEMINI["model"]})
        self.env.start()
        self.context = set_request_context("test-cost", "primary")

    async def asyncTearDown(self):
        reset_request_context(self.context)
        self.env.stop()
        self.temp.cleanup()

    def record(self, provider=GROQ, uid="a", inp=1000, out=500, **kwargs):
        return costs.record_usage(provider, {"inputTokens": inp, "outputTokens": out}, user_id=uid, source="test", **kwargs)

    def test_individual_model_and_global_totals(self):
        self.record()
        self.record(GEMINI, out=100)
        self.record(uid="b")
        result = costs.overview(USERS, "all")
        self.assertEqual(4100, result["totals"]["totalTokens"])
        self.assertAlmostEqual(0.001575, result["totals"]["costUsd"])
        ana = next(u for u in result["users"] if u["id"] == "a")
        self.assertEqual(2600, ana["totalTokens"])
        self.assertAlmostEqual(0.00135, ana["costUsd"])
        self.assertEqual(2, len([m for m in ana["models"] if m["requests"]]))

    def test_cache_and_reasoning_are_not_double_counted(self):
        groq = costs.token_counts({"usage": {"prompt_tokens": 1000, "completion_tokens": 500, "prompt_tokens_details": {"cached_tokens": 400}, "completion_tokens_details": {"reasoning_tokens": 200}}}, "groq")
        self.assertEqual(500, groq["outputTokens"])
        self.assertEqual((59800, 150000), costs.nano_cost(costs.default_rate(GROQ), groq))
        google = costs.token_counts({"usage": {"total_input_tokens": 1000, "total_cached_tokens": 200, "total_output_tokens": 300, "total_thought_tokens": 200}}, "google")
        self.assertEqual(500, google["outputTokens"])
        self.assertEqual((615000, 1875000), costs.nano_cost(costs.default_rate(GEMINI), google))
        anthropic = costs.token_counts({"usage": {"input_tokens": 10, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 30, "output_tokens": 5}}, "anthropic")
        self.assertEqual(60, anthropic["inputTokens"])

    def test_tariff_unit_and_historical_snapshot(self):
        payload = {**GROQ, "unitTokens": 1000, "inputUsd": 2, "outputUsd": 4, "cachedInputUsd": 1, "cacheWriteUsd": 3, "source": "test"}
        costs.save_rate(payload, "admin")
        self.record()
        costs.save_rate({**payload, "inputUsd": 10, "outputUsd": 20}, "admin")
        self.record()
        result = costs.overview(USERS, "all")
        self.assertEqual(24, result["totals"]["costUsd"])
        self.assertEqual(2, len(result["audit"]))

    def test_unknown_price_is_pending_then_backfilled(self):
        custom = {"provider": "openai-compatible", "baseUrl": "https://example.test/v1", "model": "new-model", "name": "Novo"}
        self.record(custom)
        self.assertEqual(1, costs.overview(USERS, "all")["totals"]["unpricedRequests"])
        costs.save_rate({**custom, "unitTokens": 1000, "inputUsd": 1, "outputUsd": 2}, "admin")
        result = costs.overview(USERS, "all")
        self.assertEqual(0, result["totals"]["unpricedRequests"])
        self.assertEqual(2, result["totals"]["costUsd"])

    def test_discovery_and_legacy_import_are_idempotent_across_workspaces(self):
        custom = {"id": "custom", "provider": "openai-compatible", "model": "small", "baseUrl": "https://custom.test/v1", "encryptedSecret": "do-not-export", "inputCostPerMillion": 1, "outputCostPerMillion": 2}
        store = {"modelProviders": [custom], "modelUsage": [{"id": "old", "providerId": "custom", "model": "small", "inputTokens": 100, "outputTokens": 50, "createdAt": "2026-08-20T15:00:00Z"}]}
        write_user_db("a", "intelligence", store)
        ctx = set_request_context("second", "workspace2")
        try:
            write_user_db("a", "intelligence", store)
        finally:
            reset_request_context(ctx)
        costs.overview(USERS, "all")
        result = costs.overview(USERS, "all")
        self.assertEqual(2, result["totals"]["requests"])
        self.assertNotIn("do-not-export", str(result))
        self.assertTrue(any(m["model"] == "small" for m in result["models"]))

    def test_zero_limit_blocks_before_provider_call(self):
        costs.save_limit("a", {"monthlyBudgetUsd": None, "monthlyTokenLimit": 0}, "admin")
        with self.assertRaises(HTTPException) as exc:
            costs.reserve(GROQ, "a", 10, 10)
        self.assertEqual(402, exc.exception.status_code)

    def test_admin_prices_update_existing_model_routing(self):
        costs.save_rate({**GROQ, "unitTokens": 1000, "inputUsd": 2, "outputUsd": 4}, "admin")
        providers = service.all_providers("a")
        self.assertEqual(2000, next(p for p in providers if p["id"] == "nora-runtime")["inputCostPerMillion"])
        route = service.route_model(USERS[0], {"requiredCapabilities": ["text"]})
        self.assertEqual("gemini-runtime", route["selected"]["id"])

    def test_explicit_zero_budget_blocks_even_a_free_model(self):
        costs.save_rate({**GROQ, "unitTokens": 1000, "inputUsd": 0, "outputUsd": 0}, "admin")
        costs.save_limit("a", {"monthlyBudgetUsd": 0, "monthlyTokenLimit": None}, "admin")
        with self.assertRaises(HTTPException):
            costs.reserve(GROQ, "a", 10, 100)

    async def test_request_crossing_month_stays_in_reserved_month(self):
        with patch.object(costs, "now", return_value="2026-08-31T23:59:59-03:00"):
            async with costs.Meter(GROQ, "test", 100, user_id="a") as meter:
                with patch.object(costs, "now", return_value="2026-09-01T00:00:01-03:00"):
                    await meter.record({"usage": {"prompt_tokens": 10, "completion_tokens": 5}})
        self.assertEqual(1, costs.overview(USERS, "2026-08")["totals"]["requests"])
        self.assertEqual(0, costs.overview(USERS, "2026-09")["totals"]["requests"])

    async def test_atomic_reservations_prevent_concurrent_overspend(self):
        costs.save_limit("a", {"monthlyBudgetUsd": None, "monthlyTokenLimit": 100}, "admin")
        results = await asyncio.gather(*(asyncio.to_thread(costs.reserve, GROQ, "a", 60, 30) for _ in range(4)), return_exceptions=True)
        self.assertEqual(1, sum(isinstance(r, tuple) for r in results))
        self.assertEqual(3, sum(isinstance(r, HTTPException) for r in results))

    async def test_budget_reduces_provider_output_and_releases_unused_reservation(self):
        costs.save_rate({**GROQ, "unitTokens": 1000, "inputUsd": 1, "outputUsd": 2}, "admin")
        costs.save_limit("a", {"monthlyBudgetUsd": 0.2, "monthlyTokenLimit": None}, "admin")
        async with costs.Meter(GROQ, "", 1400, user_id="a") as meter:
            self.assertEqual(67, meter.max_output)
            meter.sent()
            await meter.record({"usage": {"prompt_tokens": 5, "completion_tokens": 3}})
        result = costs.overview(USERS, "all")["users"][0]
        self.assertAlmostEqual(0.189, result["remainingUsd"])
        self.assertEqual(0, result["pendingRequests"])

    async def test_error_release_and_missing_usage_estimate(self):
        async with costs.Meter(GROQ, "request", 100, user_id="a") as meter:
            meter.sent()
            meter.rejected()
        self.assertEqual(0, costs.overview(USERS, "all")["totals"]["requests"])
        async with costs.Meter(GROQ, "request", 100, user_id="a") as meter:
            meter.sent()
        result = costs.overview(USERS, "all")
        self.assertEqual(1, result["totals"]["estimatedRequests"])
        self.assertGreater(result["totals"]["costUsd"], 0)

    def test_current_balance_is_independent_of_history_filter(self):
        self.record(created_at="2025-01-01T15:00:00Z")
        self.record()
        costs.save_limit("a", {"monthlyBudgetUsd": 1, "monthlyTokenLimit": 10000}, "admin")
        result = costs.overview(USERS, "2025-01", "a")
        self.assertEqual(1, result["totals"]["requests"])
        self.assertEqual(8500, result["users"][0]["remainingTokens"])
        self.assertEqual("2026-08", costs.month_for("2026-09-01T02:59:00Z"))
        self.assertEqual("2026-09", costs.month_for("2026-09-01T03:00:00Z"))

    async def test_context_isolation_and_reset(self):
        async def request(uid):
            ctx = set_request_context(uid, "primary")
            try:
                set_ai_user_id(uid)
                await asyncio.sleep(0)
                async with costs.Meter(GROQ, "test", 100) as meter:
                    await meter.record({"usage": {"prompt_tokens": 10, "completion_tokens": 5}})
            finally:
                reset_request_context(ctx)
        await asyncio.gather(request("a"), request("b"))
        self.assertEqual("", current_ai_user_id())
        result = costs.overview(USERS, "all")
        self.assertEqual([1, 1], sorted(u["requests"] for u in result["users"]))

    async def test_truncated_nora_response_is_billed_to_actual_model(self):
        nora = NoraIAService()
        nora._client = type("Client", (), {"is_closed": False, "post": AsyncMock(return_value=httpx.Response(200, json={"model": GROQ["model"], "choices": [{"finish_reason": "length"}], "usage": {"prompt_tokens": 20, "completion_tokens": 100}}))})()
        with self.assertRaises(NoraIncompleteResponse):
            await nora.perguntar_nora([{"role": "user", "content": "test"}], require_complete=True, user_id="a")
        self.assertEqual(120, costs.overview(USERS, "all")["totals"]["totalTokens"])

    async def test_stream_usage_only_final_chunk_recorded_once(self):
        sse = 'data: {"choices":[{"delta":{"content":"Olá"}}]}\n\ndata: {"choices":[],"x_groq":{"usage":{"prompt_tokens":20,"completion_tokens":10}}}\n\ndata: [DONE]\n\n'
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=sse))) as client:
            nora = NoraIAService()
            nora._client = client
            answer = "".join([chunk async for chunk in nora.perguntar_nora_stream([{"role": "user", "content": "test"}], user_id="a")])
        self.assertEqual("Olá", answer)
        result = costs.overview(USERS, "all")
        self.assertEqual(30, result["totals"]["totalTokens"])
        self.assertEqual(1, result["totals"]["requests"])

    async def test_gemini_gateway_measures_reasoning_and_preserves_usage_id(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"model": GEMINI["model"], "steps": [{"type": "model_output", "content": [{"type": "text", "text": "Pronto"}]}], "usage": {"total_input_tokens": 20, "total_output_tokens": 10, "total_thought_tokens": 30}})))
        with patch.object(service, "assert_public_dns", AsyncMock()), patch.object(service.httpx, "AsyncClient", return_value=client):
            _, metadata = await service.complete_with_provider(USERS[0], "gemini-runtime", [{"role": "user", "content": "test"}], "system")
        self.assertEqual(40, metadata["usage"]["outputTokens"])
        result = costs.overview(USERS, "all")
        self.assertEqual(1, result["totals"]["requests"])
        self.assertEqual(60, result["totals"]["totalTokens"])

    async def test_admin_authorization_and_payload_validation(self):
        app = FastAPI()
        app.include_router(ai_costs_router.router)
        app.dependency_overrides[ai_costs_router.current_user] = lambda: {"id": "member", "role": "member", "permissions": {}}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual(403, (await client.get("/api/auth/admin/ai-costs")).status_code)
            app.dependency_overrides[ai_costs_router.current_user] = lambda: {"id": "admin", "systemAdmin": True}
            with patch.object(ai_costs_router, "read_user_store", AsyncMock(return_value={"users": USERS})):
                self.assertEqual(200, (await client.get("/api/auth/admin/ai-costs")).status_code)
                self.assertEqual(422, (await client.put("/api/auth/admin/ai-costs/users/a/limits", json={"monthlyBudgetUsd": -1})).status_code)
                self.assertEqual(404, (await client.put("/api/auth/admin/ai-costs/users/missing/limits", json={})).status_code)
                tariff = {"provider": "groq", "model": "test", "name": "Test", "unitTokens": 0, "inputUsd": 0, "outputUsd": 1}
                self.assertEqual(422, (await client.post("/api/auth/admin/ai-costs/tariffs", json=tariff)).status_code)
                tariff.update(unitTokens=1000, baseUrl="https://secret:password@example.test/v1")
                self.assertEqual(422, (await client.post("/api/auth/admin/ai-costs/tariffs", json=tariff)).status_code)

    def test_unknown_prices_cannot_bypass_budget(self):
        costs.save_limit("a", {"monthlyBudgetUsd": 1, "monthlyTokenLimit": None}, "admin")
        with self.assertRaises(HTTPException):
            costs.reserve({**GROQ, "model": "unknown"}, "a", 10, 20)
        self.record({**GROQ, "model": "unknown"})
        with self.assertRaises(HTTPException):
            costs.reserve(GROQ, "a", 10, 20)


if __name__ == "__main__":
    unittest.main()
