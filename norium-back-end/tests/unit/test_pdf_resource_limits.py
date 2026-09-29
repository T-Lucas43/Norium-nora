"""Interrupção real do worker e disponibilidade da API com carga sintética."""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
import subprocess
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException

from app.modules.platform import pdf_text, pdf_worker
from tests.unit.test_pdf_text_service import make_pdf


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/pdf_resource_worker.py"


class PdfResourceLimitsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.processes: list[subprocess.Popen] = []
        original_popen = subprocess.Popen

        def track_process(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            self.processes.append(process)
            return process

        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(pdf_text.subprocess, "Popen", side_effect=track_process))

    def test_timeout_kills_worker_and_releases_capacity(self) -> None:
        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), patch.object(pdf_text, "PDF_TIMEOUT_SECONDS", 0.8):
            started = time.monotonic()
            with self.assertRaises(HTTPException) as error:
                pdf_text.extract_pdf_pages(b"%PDF-block")
            self.assertEqual(422, error.exception.status_code)
            self.assertIn("tempo", error.exception.detail)
            self.assertLess(time.monotonic() - started, 3)
            self.assertIsNotNone(self.processes[0].poll())
            self.assertEqual(["Worker sintetico pronto"], pdf_text.extract_pdf_pages(b"%PDF-ok"))

    def test_os_memory_budget_rejects_allocation(self) -> None:
        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), patch.object(pdf_text, "PDF_MEMORY_BYTES", 64 * 1024 * 1024):
            with self.assertRaises(HTTPException) as error:
                pdf_text.extract_pdf_pages(b"%PDF-memory")
        self.assertEqual(413, error.exception.status_code)
        self.assertIsNotNone(self.processes[0].poll())

    def test_os_cpu_budget_ends_busy_worker_before_wall_timeout(self) -> None:
        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), patch.object(pdf_text, "PDF_CPU_SECONDS", 1):
            started = time.monotonic()
            with self.assertRaises(HTTPException) as error:
                pdf_text.extract_pdf_pages(b"%PDF-cpu")
        self.assertEqual(422, error.exception.status_code)
        self.assertNotIn("tempo", error.exception.detail)
        self.assertLess(time.monotonic() - started, pdf_text.PDF_TIMEOUT_SECONDS)
        self.assertIsNotNone(self.processes[0].poll())

    def test_worker_does_not_inherit_application_secrets(self) -> None:
        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), patch.dict(os.environ, {"NORIUM_TEST_SECRET": "synthetic"}):
            self.assertEqual(["isolated"], pdf_text.extract_pdf_pages(b"%PDF-environment"))

    def test_output_budget_rejects_instead_of_truncating_evidence(self) -> None:
        with patch.object(pdf_text, "PDF_MAX_TEXT_CHARS", 12):
            with self.assertRaises(HTTPException) as error:
                pdf_text.extract_pdf_pages(make_pdf(["Texto sintetico maior que o limite de teste"]))
        self.assertEqual(413, error.exception.status_code)
        self.assertIn("texto", error.exception.detail)

    def test_unavailable_os_limits_fail_closed_before_reading_pdf(self) -> None:
        output = io.StringIO()
        with patch.object(pdf_worker, "apply_resource_limits", side_effect=OSError), \
                patch.object(pdf_worker.sys, "argv", ["worker", "4096", "1", "1", "100", "2", "100"]), \
                patch.object(pdf_worker.sys, "stdin", None), contextlib.redirect_stdout(output):
            pdf_worker.main()
        self.assertEqual('{"error":"limits"}', output.getvalue().strip())


class PdfAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_other_request_responds_and_second_pdf_is_rejected_while_busy(self) -> None:
        app = FastAPI()
        processes: list[subprocess.Popen] = []
        launched = threading.Event()
        original_popen = subprocess.Popen

        def track_process(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            processes.append(process)
            launched.set()
            return process

        @app.get("/heavy")
        async def heavy():
            return await pdf_text.extract_pdf_pages_async(b"%PDF-block")

        @app.get("/ping")
        async def ping():
            return {"alive": True}

        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), patch.object(pdf_text, "PDF_TIMEOUT_SECONDS", 1), \
                patch.object(pdf_text.subprocess, "Popen", side_effect=track_process):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                heavy_request = asyncio.create_task(client.get("/heavy"))
                self.assertTrue(await asyncio.to_thread(launched.wait, 2))
                response = await asyncio.wait_for(client.get("/ping"), timeout=0.5)
                self.assertEqual({"alive": True}, response.json())
                with self.assertRaises(HTTPException) as busy:
                    await pdf_text.extract_pdf_pages_async(b"%PDF-ok")
                self.assertEqual(503, busy.exception.status_code)
                self.assertEqual("2", busy.exception.headers["Retry-After"])
                self.assertEqual(1, len(processes))
                self.assertEqual(422, (await heavy_request).status_code)
                self.assertIsNotNone(processes[0].poll())
                self.assertEqual(["Worker sintetico pronto"], await pdf_text.extract_pdf_pages_async(b"%PDF-ok"))

    async def test_cancellation_kills_worker_and_preserves_capacity_until_cleanup(self) -> None:
        loop = asyncio.get_running_loop()
        errors: list[str] = []
        previous_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: errors.append(context.get("message", "")))
        self.addCleanup(loop.set_exception_handler, previous_handler)
        processes: list[subprocess.Popen] = []
        launched = threading.Event()
        original_popen = subprocess.Popen

        def track_process(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            processes.append(process)
            launched.set()
            return process

        with patch.object(pdf_text, "_PDF_WORKER", FIXTURE), \
                patch.object(pdf_text.subprocess, "Popen", side_effect=track_process):
            task = asyncio.create_task(pdf_text.extract_pdf_pages_async(b"%PDF-block"))
            self.assertTrue(await asyncio.to_thread(launched.wait, 2))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            deadline = time.monotonic() + 3
            while processes[0].poll() is None and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            self.assertIsNotNone(processes[0].poll())
            # O futuro do supervisor pode estar encerrando os pipes após o exit.
            await loop.run_in_executor(None, lambda: None)
            for _ in range(50):
                try:
                    pages = await pdf_text.extract_pdf_pages_async(b"%PDF-ok")
                    break
                except HTTPException as exc:
                    if exc.status_code != 503:
                        raise
                    await asyncio.sleep(0.02)
            else:
                self.fail("Slot de PDF nao liberado apos cancelamento")
            self.assertEqual(["Worker sintetico pronto"], pages)
            self.assertEqual([], errors)
