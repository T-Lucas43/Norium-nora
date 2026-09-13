import asyncio
import json
import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import HTTPException

from app.core.request_context import reset_request_context, set_request_context
from app.modules.intelligence.browser_access import access_state, navigate_readable
from app.modules.intelligence.browser_research import summarize
from app.modules.intelligence.browser_runtime import BrowserControl, _CONTROLS, _key, _update_run, browser_login_input, control_browser_run, request_browser_login, sanitize_run
from app.modules.intelligence.repository import read_store
from app.modules.intelligence.schemas import BrowserPlanPayload
from app.modules.intelligence.service import create_browser_plan
from app.services.nora import NoraIAService, NoraResearchUnavailable


class BrowserAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temp.name, "GROQ_API_KEY": "test-key"})
        self.env.start()
        self.user = {"id": "login-owner", "role": "owner", "plan": "enterprise"}
        self.run = await create_browser_plan(self.user, BrowserPlanPayload(objective="Leia e explique a página", startUrl="https://example.com/", taskType="summary").model_dump())

    async def asyncTearDown(self):
        _CONTROLS.pop(_key(self.user["id"], self.run["id"]), None)
        self.env.stop()
        self.temp.cleanup()

    async def wait_login(self):
        for _ in range(100):
            run = read_store(self.user["id"])["browserRuns"][0]
            if run.get("status") == "awaiting_login":
                return run
            await asyncio.sleep(.01)
        self.fail("login pause was not published")

    async def test_login_can_be_completed_without_persisting_input_or_consuming_execution_time(self):
        page = Mock(url="https://example.com/login", viewport_size={"width": 1440, "height": 900})
        page.keyboard = Mock(insert_text=AsyncMock())
        page.mouse = Mock(click=AsyncMock())
        control = BrowserControl()
        _CONTROLS[_key(self.user["id"], self.run["id"])] = control
        async with asyncio.timeout(3) as timer:
            control.timeout_context = timer
            original_deadline = timer.when()
            task = asyncio.create_task(request_browser_login(self.user["id"], self.run["id"], page, control, "Faça login."))
            try:
                run = await self.wait_login()
                self.assertIsNone(timer.when())
                self.assertEqual("Faça login.", run["loginRequest"]["message"])
                await browser_login_input(self.user["id"], self.run["id"], {"type": "text", "text": "test-password-not-stored"})
                await browser_login_input(self.user["id"], self.run["id"], {"type": "click", "x": .5, "y": .2})
                page.mouse.click.assert_awaited_with(720, 180)
                page.keyboard.insert_text.assert_awaited_once_with("test-password-not-stored")
                self.assertNotIn("test-password", json.dumps(read_store(self.user["id"])))
                tokens = set_request_context("test", "other-workspace")
                try:
                    with self.assertRaises(HTTPException):
                        await browser_login_input(self.user["id"], self.run["id"], {"type": "text", "text": "not allowed"})
                finally:
                    reset_request_context(tokens)
                await control_browser_run(self.user, self.run["id"], "resume")
                await task
                self.assertGreater(timer.when(), original_deadline)
            finally:
                task.cancel()
        self.assertEqual("running", read_store(self.user["id"])["browserRuns"][0]["status"])
        with self.assertRaises(HTTPException):
            await browser_login_input(self.user["id"], self.run["id"], {"type": "text", "text": "late input"})

    async def test_cancel_wakes_a_browser_waiting_for_login(self):
        control = BrowserControl()
        _CONTROLS[_key(self.user["id"], self.run["id"])] = control
        task = asyncio.create_task(request_browser_login(self.user["id"], self.run["id"], Mock(url="https://example.com/login"), control, "Login necessário."))
        await self.wait_login()
        await control_browser_run(self.user, self.run["id"], "cancel")
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_failed_actions_no_longer_remain_running_and_plan_can_be_edited(self):
        await _update_run(self.user["id"], self.run["id"], {"status": "running"}, action_id=self.run["plan"][1]["id"], action_updates={"status": "running"})
        failed = await _update_run(self.user["id"], self.run["id"], {"status": "failed", "error": "Página não encontrada."})
        self.assertEqual("failed", failed["plan"][1]["status"])
        revised = await create_browser_plan(self.user, BrowserPlanPayload(objective="Tente a página inicial", startUrl="https://example.com/", taskType="summary").model_dump(), replace_id=self.run["id"])
        self.assertEqual("planned", revised["status"])

    def test_old_pending_analyses_are_not_shown_as_completed(self):
        self.assertEqual("analysis_pending", sanitize_run({"status": "completed", "report": {"generator": "pending"}})["status"])

    async def test_reading_notes_survive_failure_and_are_reused_in_rewrite(self):
        pages = [{"title": "Uma fonte", "text": "A" * 10000 + "B" * 10000, "layout": {}}]
        save = AsyncMock()
        with patch.object(NoraIAService, "perguntar_nora", new=AsyncMock(side_effect=["Primeiro conceito [1].", "Segundo conceito [1].", NoraResearchUnavailable("rate_limit")])):
            _, generator, warnings = await summarize(pages, self.run, BrowserControl(), time.monotonic() + 150, on_material=save)
        self.assertEqual("pending", generator)
        self.assertIn("limite temporário", warnings[0])
        self.assertEqual(2, save.await_count)
        with patch.object(NoraIAService, "perguntar_nora", new=AsyncMock(return_value="Uma explicação concluída [1].")) as nora:
            _, generator, _ = await summarize(pages, self.run, BrowserControl(), time.monotonic() + 150)
        self.assertEqual("nora", generator)
        self.assertEqual(1, nora.await_count)

    async def test_provider_preserves_output_budget_and_respects_retry_after(self):
        service = NoraIAService()
        service.model = "openai/gpt-oss-20b"
        service.fallback_models = [service.model]
        service._client = Mock(is_closed=False, post=AsyncMock(side_effect=[httpx.Response(429, headers={"retry-after": "1"}), httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "Análise concluída."}}]})]))
        with patch("app.services.nora.asyncio.sleep", new=AsyncMock()) as sleep:
            self.assertEqual("Análise concluída.", await service.perguntar_nora([], research=True))
        self.assertEqual(1, sleep.await_count)
        self.assertGreater(sleep.call_args.args[0], .9)
        self.assertEqual("low", service._client.post.call_args.kwargs["json"]["reasoning_effort"])

    async def test_access_errors_distinguish_login_verification_and_missing_page(self):
        page = Mock(url="https://example.com/", title=AsyncMock(return_value="Site"))
        page.locator.return_value = Mock(inner_text=AsyncMock(return_value="Texto público para pesquisa."), count=AsyncMock(return_value=0))
        self.assertEqual("not_found", (await access_state(page, 404)).code)
        self.assertEqual("login", (await access_state(page, 401)).code)
        page.title.return_value = "Um momento…"
        self.assertEqual("verification", (await access_state(page, 403)).code)

    async def test_navigation_waits_for_client_rendered_content(self):
        from playwright.async_api import TimeoutError
        page = Mock(goto=AsyncMock(return_value=Mock(status=200, headers={"content-type": "text/html"})), wait_for_load_state=AsyncMock(side_effect=TimeoutError("load timed out")), wait_for_function=AsyncMock())
        self.assertEqual(200, await navigate_readable(page, "https://example.com/"))
        page.wait_for_function.assert_awaited_once()
