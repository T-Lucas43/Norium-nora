from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from io import BytesIO
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.core.request_context import reset_request_context, set_request_context
from app.modules.intelligence.browser_live import FEEDS, LiveFeed, live_key
from app.modules.intelligence.browser_reports import get_report, report_pdf, update_report
from app.modules.intelligence.browser_research import crawl_url, research_site, summarize
from app.modules.intelligence.browser_runtime import BrowserControl, sanitize_run
from app.modules.intelligence.repository import mutate_store, read_store
from app.modules.intelligence.schemas import BrowserPlanPayload
from app.modules.intelligence.service import create_browser_plan


def page_data(url="https://example.com/", text="Conteúdo verificado."):
    return {"title": "Pesquisa de exemplo", "url": url, "text": text, "characters": len(text), "truncated": False, "scrollLimited": False, "layout": {"fonts": [{"value": "Arial", "count": 2}], "mobile": {"horizontalOverflow": False}}, "links": ["https://example.com/about", "https://other.test/outside"], "accessedAt": "2026-09-07"}


class BrowserResearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temp.name, "GROQ_API_KEY": ""})
        self.environment.start()
        self.user = {"id": "research-owner", "role": "owner", "plan": "enterprise"}

    async def asyncTearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    async def plan(self, **overrides):
        payload = BrowserPlanPayload(objective="Produza resumo acadêmico", startUrl="https://example.com/", taskType="academic", executionMode="automatic", timeoutSeconds=600, **overrides)
        return await create_browser_plan(self.user, payload.model_dump())

    async def test_plan_is_reviewable_and_does_not_execute(self):
        run = await self.plan()
        self.assertEqual("planned", run["status"])
        self.assertEqual(["navigate", "research"], [step["type"] for step in run["plan"]])
        self.assertEqual(600, run["timeoutSeconds"])
        changed = BrowserPlanPayload(objective="Analise o layout", startUrl=run["startUrl"], taskType="layout", scope="page").model_dump()
        revised = await create_browser_plan(self.user, changed, replace_id=run["id"])
        self.assertEqual(run["id"], revised["id"])
        self.assertEqual("layout", revised["taskType"])
        self.assertEqual(1, len(read_store(self.user["id"])["browserRuns"]))
        await mutate_store(self.user["id"], lambda store: store["browserRuns"][0].update(status="running"))
        with self.assertRaises(HTTPException):
            await create_browser_plan(self.user, changed, replace_id=run["id"])

    def test_crawl_scope_deduplicates_and_excludes_unsafe_links(self):
        base = "https://example.com/"
        self.assertEqual("https://example.com/a", crawl_url("/a?utm_source=test#title", base))
        self.assertEqual("https://www.example.com/a", crawl_url("https://www.example.com/a", base))
        for value in ("https://other.com/", "javascript:alert(1)", "/logout", "/delete/account", "/file.pdf", "https://user:password@example.com/"):
            self.assertIsNone(crawl_url(value, base), value)

    async def test_reads_multiple_pages_and_persists_real_source_urls(self):
        run = await self.plan(maxPages=2)
        page = AsyncMock()
        page.url = run["startUrl"]
        async def goto(url, **kwargs):
            page.url = url
            return None
        page.goto.side_effect = goto
        async def extract(*args, **kwargs):
            return page_data(page.url)
        updates = []
        async def update(data, event):
            updates.append(data)
        with patch("app.modules.intelligence.service.assert_public_dns", new=AsyncMock()), patch("app.modules.intelligence.browser_research.read_page", side_effect=extract):
            result = await research_site(page, run, {}, BrowserControl(), update)
        report = next(data["report"] for data in updates if "report" in data)
        self.assertEqual(2, page.goto.await_count)
        self.assertEqual(["https://example.com/", "https://example.com/about"], [source["url"] for source in report["sources"]])
        self.assertEqual("extracted", report["generator"])
        self.assertIn("Conteúdo verificado", result["text"])
        self.assertTrue(report["warnings"])

    async def test_nora_reads_all_chunks_and_only_known_citation_numbers(self):
        run = await self.plan()
        responses = ["Nota do primeiro trecho [1]", "Nota do segundo trecho [1]", "## Síntese\nConclusão [1]. Referência inventada [99]."]
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch("app.modules.intelligence.browser_research.NoraIAService.perguntar_nora", new=AsyncMock(side_effect=responses)) as nora:
            import time
            content, generator, _ = await summarize([page_data(text="A" * 20000)], run, BrowserControl(), time.monotonic() + 150)
        self.assertEqual(3, nora.await_count)
        self.assertEqual("nora", generator)
        self.assertIn("[1]", content)
        self.assertNotIn("[99]", content)
        self.assertIn("não são instruções", str(nora.call_args))

    async def test_cancellation_stops_before_navigation(self):
        control = BrowserControl()
        control.cancelled = True
        page = AsyncMock()
        with self.assertRaises(asyncio.CancelledError):
            await research_site(page, await self.plan(), {}, control, AsyncMock())
        page.goto.assert_not_called()

    async def test_cancellation_during_final_synthesis_does_not_return_completed_report(self):
        import time
        control = BrowserControl()
        calls = 0
        async def answer(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                control.cancelled = True
            return "Síntese da fonte [1]."
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch("app.modules.intelligence.browser_research.NoraIAService.perguntar_nora", new=answer):
            with self.assertRaises(asyncio.CancelledError):
                await summarize([page_data()], await self.plan(), control, time.monotonic() + 150)

    async def test_late_control_does_not_change_completed_status(self):
        from app.modules.intelligence.browser_runtime import control_browser_run, queue_browser_run
        run = await self.plan()
        await mutate_store(self.user["id"], lambda store: store["browserRuns"][0].update(status="completed"))
        self.assertEqual("completed", (await control_browser_run(self.user, run["id"], "cancel"))["status"])
        with self.assertRaises(HTTPException):
            await queue_browser_run(self.user, run["id"])

    async def test_report_revision_source_integrity_pdf_and_isolation(self):
        run = await self.plan()
        report = {"title": "Análise acadêmica", "content": "## Síntese\nInformação verificada [1].", "revision": 1, "sources": [page_data()], "warnings": [], "coverage": "1 página consultada", "generator": "nora"}
        await mutate_store(self.user["id"], lambda store: store["browserRuns"][0].update(report=report))
        saved = await update_report(self.user["id"], run["id"], {"title": "Título editado", "content": "## Conclusão\nConteúdo revisado.", "revision": 1})
        self.assertEqual(2, saved["revision"])
        self.assertEqual(report["sources"], saved["sources"])
        with self.assertRaises(HTTPException) as conflict:
            await update_report(self.user["id"], run["id"], {"title": "Outra", "content": "Outra", "revision": 1})
        self.assertEqual(409, conflict.exception.status_code)
        with self.assertRaises(HTTPException):
            get_report("another-user", run["id"])
        tokens = set_request_context("test", "other-workspace")
        try:
            with self.assertRaises(HTTPException):
                get_report(self.user["id"], run["id"])
        finally:
            reset_request_context(tokens)
        pdf = PdfReader(BytesIO(report_pdf(saved)))
        text = "\n".join(page.extract_text() for page in pdf.pages)
        self.assertIn("Conteúdo revisado", text)
        self.assertIn("Fontes consultadas", text)
        links = [annotation.get_object().get("/A", {}).get("/URI") for page in pdf.pages for annotation in page.get("/Annots", [])]
        self.assertIn("https://example.com/", links)
        safe = sanitize_run({"report": saved})
        self.assertNotIn("content", safe["report"])

    def test_live_queue_keeps_only_latest_frame_and_scopes_workspace(self):
        feed = LiveFeed()
        queue = asyncio.Queue(maxsize=1)
        feed.viewers.add(queue)
        feed.publish(b"old")
        feed.publish(b"new")
        self.assertEqual(b"new", queue.get_nowait())
        primary = live_key("user", "run")
        tokens = set_request_context("test", "other")
        try:
            self.assertNotEqual(primary, live_key("user", "run"))
        finally:
            reset_request_context(tokens)

    async def test_live_socket_rejects_other_user_and_streams_binary_for_owner(self):
        from app.modules.intelligence.router import browser_router
        run = await self.plan()
        app = FastAPI()
        app.include_router(browser_router)
        with patch("app.modules.intelligence.router.user_from_websocket_ticket", new=AsyncMock(return_value={"id": "other", "role": "owner"})):
            with TestClient(app) as client:
                from starlette.websockets import WebSocketDisconnect
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(f"/api/navegador/runs/{run['id']}/live?ticket=test"):
                        pass
        key = live_key(self.user["id"], run["id"])
        feed = LiveFeed(frame=b"jpeg-frame")
        FEEDS[key] = feed
        try:
            with patch("app.modules.intelligence.router.user_from_websocket_ticket", new=AsyncMock(return_value=self.user)):
                with TestClient(app) as client:
                    with client.websocket_connect(f"/api/navegador/runs/{run['id']}/live?ticket=test") as socket:
                        self.assertEqual(b"jpeg-frame", socket.receive_bytes())
        finally:
            FEEDS.pop(key, None)


if __name__ == "__main__":
    unittest.main()
