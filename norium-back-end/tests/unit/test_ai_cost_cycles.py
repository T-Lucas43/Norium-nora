from __future__ import annotations

import io
import asyncio
import threading
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException
from pypdf import PdfReader

from app.modules.auth import ai_costs_router
from app.modules.auth.ai_costs_pdf import render_costs
from app.services import ai_costs as costs
from tests.unit import test_ai_costs as fixtures

GROQ, USERS = fixtures.GROQ, fixtures.USERS


class CostCycleTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AiCostTests.asyncSetUp
    asyncTearDown = fixtures.AiCostTests.asyncTearDown
    record = fixtures.AiCostTests.record

    async def test_model_pricing_wait_does_not_block_other_requests(self):
        from app.modules.intelligence import router as models
        entered, release = threading.Event(), threading.Event()
        def blocked_prices(_):
            entered.set()
            if not release.wait(2):
                raise RuntimeError("Pricing blocked the event loop")
            return []
        with patch.object(models, "all_providers", blocked_prices), patch.object(models, "read_store", return_value={"modelPolicies": []}), patch.object(models, "usage_summary", return_value={}):
            task = asyncio.create_task(models.models_overview({"id": "a"}))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(entered.is_set())
                self.assertFalse(task.done())
            finally:
                release.set()
                await task

    def test_monthly_anchor_day_recovers_after_short_month(self):
        limit = {"period": "monthly", "startDate": "2024-01-31", "autoRenew": True}
        feb = costs.cycle_for(limit, "2024-02-29T03:00:00+00:00")
        self.assertEqual("2024-02-29T03:00:00+00:00", feb["startAt"])
        self.assertEqual("2024-03-31T03:00:00+00:00", feb["endAt"])
        before = costs.cycle_for(limit, "2024-03-31T02:59:59+00:00")
        self.assertEqual(feb, before)
        after = costs.cycle_for(limit, "2024-03-31T03:00:00+00:00")
        self.assertEqual("2024-04-30T03:00:00+00:00", after["endAt"])

    def test_weekly_quota_spans_calendar_month_and_renews_exactly(self):
        costs.save_limit("a", {"period": "weekly", "startDate": "2026-08-29", "monthlyTokenLimit": 100}, "admin")
        self.record(inp=60, out=40, created_at="2026-08-31T12:00:00+00:00")
        with self.assertRaises(HTTPException):
            costs.reserve(GROQ, "a", 10, 10, "2026-09-05T02:59:59+00:00")
        _, output, _ = costs.reserve(GROQ, "a", 10, 10, "2026-09-05T03:00:00+00:00")
        self.assertEqual(10, output)

    def test_future_and_manual_expiry_block_provider(self):
        costs.save_limit("a", {"period": "weekly", "startDate": "2026-09-10", "autoRenew": False}, "admin")
        for timestamp in ("2026-09-10T02:59:59+00:00", "2026-09-17T03:00:00+00:00"):
            with self.assertRaises(HTTPException) as error:
                costs.reserve(GROQ, "a", 1, 1, timestamp)
            self.assertEqual(402, error.exception.status_code)

    def test_reset_keeps_history_and_microsecond_boundary(self):
        costs.save_limit("a", {"period": "weekly", "startDate": "2026-09-07", "monthlyTokenLimit": 100}, "admin")
        self.record(inp=60, out=40, created_at="2026-09-10T12:00:00.123455+00:00")
        with patch.object(costs, "now", return_value="2026-09-10T12:00:00.123456+00:00"):
            costs.reset_limit("a", "admin", False, "Crédito autorizado")
            result = costs.overview(USERS, "all")
            account = next(u for u in result["users"] if u["id"] == "a")
            self.assertEqual(100, account["totalTokens"])
            self.assertEqual(100, account["remainingTokens"])
            self.assertEqual("2026-09-14T03:00:00+00:00", account["cycle"]["nextResetAt"])
            self.assertEqual(0, costs.overview(USERS, "cycle")["totals"]["totalTokens"])
            _, output, _ = costs.reserve(GROQ, "a", 10, 90)
            self.assertEqual(90, output)

    def test_restart_and_pending_call_protection(self):
        costs.save_limit("a", {"period": "weekly", "startDate": "2026-09-01", "autoRenew": False}, "admin")
        with patch.object(costs, "now", return_value="2026-09-10T12:00:00+00:00"):
            with self.assertRaises(HTTPException):
                costs.reset_limit("a", "admin", False)
            limit = costs.reset_limit("a", "admin", True)
            self.assertEqual("2026-09-10", limit["startDate"])
            self.assertEqual("2026-09-17T03:00:00+00:00", costs.cycle_for(limit)["endAt"])
            costs.reserve(GROQ, "a", 10, 10)
            for operation in (lambda: costs.reset_limit("a", "admin"), lambda: costs.save_limit("a", {}, "admin")):
                with self.assertRaises(HTTPException) as error:
                    operation()
                self.assertEqual(409, error.exception.status_code)

    def test_report_cycles_differ_per_user_and_financial_totals_survive(self):
        costs.save_limit("a", {"period": "weekly", "startDate": "2026-09-07"}, "admin")
        costs.save_limit("b", {"period": "monthly", "startDate": "2026-08-15"}, "admin")
        self.record(inp=50, out=50, created_at="2026-09-01T12:00:00+00:00")
        self.record(uid="b", inp=50, out=50, created_at="2026-09-01T12:00:00+00:00")
        with patch.object(costs, "now", return_value="2026-09-10T12:00:00+00:00"):
            result = costs.overview(USERS, "cycle")
            self.assertEqual(100, result["totals"]["totalTokens"])
            self.assertEqual(200, costs.overview(USERS, "all")["totals"]["totalTokens"])
            self.assertAlmostEqual(result["totals"]["costUsd"], sum(u["costUsd"] for u in result["users"]))

    def test_pdf_escapes_names_and_contains_cycles_and_totals(self):
        self.record()
        content = render_costs(costs.overview([{**USERS[0], "nome": "Ana <Teste> & Equipe"}], "all"))
        text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(content)).pages)
        self.assertIn("Ana <Teste> & Equipe", text)
        self.assertIn("openai/gpt-oss-20b", text)
        self.assertIn("Franquia por ciclo", text)
        self.assertIn("US$ 0,000225", text)

    async def test_cycle_api_access_validation_and_pdf(self):
        app = FastAPI()
        app.include_router(ai_costs_router.router)
        app.dependency_overrides[ai_costs_router.current_user] = lambda: {"id": "member", "permissions": {}}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual(403, (await client.get("/api/auth/admin/ai-costs/pdf")).status_code)
            self.assertEqual(403, (await client.post("/api/auth/admin/ai-costs/users/a/reset", json={})).status_code)
            app.dependency_overrides[ai_costs_router.current_user] = lambda: {"id": "admin", "systemAdmin": True}
            with patch.object(ai_costs_router, "read_user_store", AsyncMock(return_value={"users": USERS})):
                for payload in ({"period": "daily"}, {"startDate": "2026-02-31"}, {"period": "weekly"}, {"autoRenew": False}, {"startDate": "9999-01-01"}):
                    self.assertEqual(422, (await client.put("/api/auth/admin/ai-costs/users/a/limits", json=payload)).status_code)
                result = await client.put("/api/auth/admin/ai-costs/users/a/limits", json={"period": "weekly", "startDate": "2026-09-07", "monthlyTokenLimit": 900})
                self.assertEqual(200, result.status_code)
                self.assertEqual("2026-09-07", result.json()["limits"]["startDate"])
                self.assertEqual(200, (await client.post("/api/auth/admin/ai-costs/users/a/reset", json={})).status_code)
                response = await client.get("/api/auth/admin/ai-costs/pdf?month=cycle&userId=a")
                self.assertEqual(200, response.status_code)
                self.assertTrue(response.content.startswith(b"%PDF"))
                self.assertEqual("no-store", response.headers["cache-control"])
