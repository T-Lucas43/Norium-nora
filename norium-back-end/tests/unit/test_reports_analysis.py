import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
import httpx
from pydantic import ValidationError

from app.modules.reports import router as reports
from app.modules.auth.router import OWNER_PERMISSIONS, current_user
from app.services.nora import NoraIncompleteResponse, NoraResearchUnavailable


def payload():
    return reports.AnalyzePayload(report={"title": "Resultado financeiro", "period": "Agosto de 2026", "filters": [], "recordCount": 2, "notes": ["Saldo do período não representa lucro."], "metrics": [{"id": "balance", "label": "Saldo do período", "value": "R$ -200,00", "detail": "Entradas menos saídas pagas", "tone": "negative"}], "tables": []})


def valid_analysis():
    return {"summary": "O período apresentou saldo negativo de R$ 200,00, pois os pagamentos excederam os recebimentos registrados.", "insights": [{"kind": "attention", "title": "Saídas superiores às entradas", "explanation": "O saldo negativo reduz os recursos gerados neste período, mas não permite concluir que a empresa teve prejuízo.", "evidenceIds": ["balance"], "recommendation": "Revise os pagamentos próximos e confirme os recebimentos pendentes antes de assumir novas despesas."}], "limitations": ["O recorte não informa o saldo bancário inicial."]}


class ReportsAnalysisTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = {"id": "reports-test", "role": "owner", "plan": "enterprise", "permissions": dict(OWNER_PERMISSIONS)}
        reports._active.clear()

    async def test_grounded_analysis_returns_real_insights_and_timestamp(self):
        with patch.object(reports.nora, "perguntar_nora", AsyncMock(return_value=json.dumps(valid_analysis()))) as ask:
            response = await reports.analyze_report(payload(), self.user)
        self.assertEqual(response["item"]["insights"][0]["kind"], "attention")
        self.assertTrue(response["item"]["generatedAt"])
        self.assertTrue(ask.call_args.kwargs["research"])
        self.assertIn("R$ -200,00", ask.call_args.args[0][-1]["content"])

    async def test_unknown_evidence_is_retried_and_never_returned_as_success(self):
        answer = valid_analysis(); answer["insights"][0]["evidenceIds"] = ["invented"]
        with patch.object(reports.nora, "perguntar_nora", AsyncMock(return_value=json.dumps(answer))) as ask:
            with self.assertRaises(HTTPException) as error:
                await reports.analyze_report(payload(), self.user)
        self.assertEqual(error.exception.status_code, 502)
        self.assertEqual(ask.await_count, 2)
        self.assertFalse(reports._active)

    async def test_incomplete_response_and_provider_limit_preserve_report(self):
        for reason in (NoraIncompleteResponse(), NoraResearchUnavailable("rate_limit")):
            material = payload(); before = material.model_dump()
            with patch.object(reports.nora, "perguntar_nora", AsyncMock(side_effect=reason)):
                with self.assertRaises(HTTPException) as error:
                    await reports.analyze_report(material, self.user)
            self.assertEqual(error.exception.status_code, 503)
            self.assertEqual(before, material.model_dump())
            self.assertFalse(reports._active)

    async def test_permissions_and_empty_reports_do_not_call_model(self):
        with patch.object(reports.nora, "perguntar_nora", AsyncMock()) as ask:
            for permission in ("relatorios", "nora"):
                self.user["permissions"] = {**OWNER_PERMISSIONS, permission: False}
                with self.assertRaises(HTTPException) as error:
                    await reports.analyze_report(payload(), self.user)
                self.assertEqual(error.exception.status_code, 403)
            self.user["permissions"] = dict(OWNER_PERMISSIONS)
            empty = payload(); empty.report.recordCount = 0
            with self.assertRaises(HTTPException) as error:
                await reports.analyze_report(empty, self.user)
            self.assertEqual(error.exception.status_code, 422)
            ask.assert_not_awaited()

    async def test_duplicate_analysis_is_rejected_without_canceling_original(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def answer(*args, **kwargs):
            entered.set(); await release.wait(); return json.dumps(valid_analysis())
        with patch.object(reports.nora, "perguntar_nora", answer):
            task = asyncio.create_task(reports.analyze_report(payload(), self.user))
            await entered.wait()
            try:
                with self.assertRaises(HTTPException) as error:
                    await reports.analyze_report(payload(), self.user)
                self.assertEqual(error.exception.status_code, 409)
            finally:
                release.set(); await task
        self.assertFalse(reports._active)

    async def test_anonymous_api_access_is_rejected(self):
        app = FastAPI(); app.include_router(reports.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/relatorios/analisar", json=payload().model_dump())
        self.assertIn(response.status_code, (401, 403))

    def test_invalid_table_or_oversized_material_is_rejected(self):
        material = payload().report.model_dump()
        material["tables"] = [{"id": "bad", "title": "Tabela", "columns": ["Valor"], "totalRows": 1, "rows": [{"id": "row", "cells": ["1", "2"]}]}]
        with self.assertRaises(ValidationError): reports.ReportEvidence.model_validate(material)
        material["tables"][0].update(columns=["A", "B"], totalRows=25, rows=[{"id": str(i), "cells": ["a" * 1000, "b" * 1000]} for i in range(25)])
        with self.assertRaises(ValidationError): reports.ReportEvidence.model_validate(material)
