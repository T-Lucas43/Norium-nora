from __future__ import annotations

import asyncio
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.request_context import set_request_context, reset_request_context
from app.core.tenant import write_user_db
from app.modules.workhub import pending, service
from app.modules.workhub.router import router
from app.modules.auth.router import current_user
from app.services import task_store, wapi_binding


class PendingSourceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "APP_ENV": "test", "ENVIRONMENT": "test"})
        self.env.start()
        self.legacy = patch.object(task_store, "TASKS_PATH", Path(self.directory.name) / "legacy.json")
        self.legacy.start()

    def tearDown(self):
        self.legacy.stop()
        self.env.stop()
        self.directory.cleanup()

    async def test_real_locked_wapi_does_not_block_tasks_or_messages_http_requests(self):
        task_store.create_task("a", {"title": "Entregar proposta", "dueDate": "2020-01-01"})
        locked = threading.Event()
        release = threading.Event()

        def hold_lock():
            with wapi_binding._ownership_lock:
                locked.set()
                release.wait(15)

        worker = threading.Thread(target=hold_lock)
        worker.start()
        await asyncio.to_thread(locked.wait, 1)
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[current_user] = lambda: {"id": "a"}
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                stalled = asyncio.create_task(client.get("/api/operacao/pendencias/fontes/integrations"))
                await asyncio.sleep(.02)
                response = await asyncio.wait_for(client.get("/api/operacao/pendencias/fontes/tasks"), 3)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["items"][0]["title"], "Entregar proposta")
                self.assertNotIn("inboxOpen", response.json())
                self.assertFalse(stalled.done())
                release.set()
                self.assertEqual((await stalled).status_code, 200)
        finally:
            release.set()
            await asyncio.to_thread(worker.join, 2)

    async def test_aggregate_returns_available_items_after_bounded_wait(self):
        release = asyncio.Event()

        async def blocked(*_args):
            await release.wait()
            return []

        with (
            patch.object(pending, "SOURCE_TIMEOUT_SECONDS", 1),
            patch.object(pending, "read_integration_health", side_effect=blocked),
            patch.object(service, "read_events", AsyncMock(return_value=[])),
            patch.object(service, "list_records", AsyncMock(return_value=[])),
            patch.object(service, "list_items", AsyncMock(return_value=[])),
            patch.object(service, "list_tasks", return_value={"tasks": [{"id": "1", "title": "Prazo", "dueDate": "2020-01-01"}]}),
            patch.object(service, "list_finance", return_value={}),
        ):
            try:
                result = await asyncio.wait_for(service.pending_center({"id": "a"}), 3)
                self.assertFalse(result["complete"])
                self.assertEqual(result["sources"]["integrations"], "unavailable")
                self.assertEqual(result["items"][0]["title"], "Prazo")
            finally:
                release.set()
                await asyncio.gather(*list(pending._reads.values()))

    async def test_concurrent_requests_and_retry_share_only_the_same_scope(self):
        release = asyncio.Event()
        started = []

        async def load(user_id, source):
            from app.core.request_context import current_workspace_id
            scope = (user_id, current_workspace_id())
            started.append(scope)
            await release.wait()
            return {"scope": scope}

        async def request(user_id, workspace):
            context = set_request_context("test", workspace)
            try:
                return await pending.pending_source({"id": user_id}, "tasks")
            finally:
                reset_request_context(context)

        with patch.object(pending, "_load", side_effect=load):
            calls = [asyncio.create_task(request(*scope)) for scope in (("a", "primary"), ("a", "primary"), ("b", "primary"), ("a", "other"))]
            await asyncio.sleep(.02)
            release.set()
            results = await asyncio.gather(*calls)
        self.assertEqual(len(started), 3)
        self.assertEqual([result["scope"] for result in results], [("a", "primary"), ("a", "primary"), ("b", "primary"), ("a", "other")])

    async def test_activity_reads_only_the_authenticated_account_and_workspace(self):
        for user_id, workspace in (("a", "primary"), ("b", "primary"), ("a", "other")):
            context = set_request_context("test", workspace)
            write_user_db(user_id, service.APPROVAL_DB, [{"id": user_id + workspace, "title": user_id + workspace, "status": "pending", "payload": {"secret": "never transmit"}}])
            reset_request_context(context)
        for user_id, workspace in (("a", "primary"), ("b", "primary"), ("a", "other")):
            context = set_request_context("test", workspace)
            try:
                result = await pending.pending_source({"id": user_id}, "activity")
            finally:
                reset_request_context(context)
            self.assertEqual([item["title"] for item in result["items"]], [user_id + workspace])
            self.assertNotIn("never transmit", str(result))

    async def test_failed_source_does_not_expose_private_exception_details(self):
        with patch.object(pending, "_load", side_effect=RuntimeError("private-credential")):
            with self.assertRaises(Exception) as caught:
                await pending.pending_source({"id": "a"}, "integrations")
        self.assertNotIn("private-credential", str(caught.exception))
        self.assertEqual(caught.exception.status_code, 503)

    async def test_message_priorities_do_not_transport_bodies_or_attachments(self):
        import json
        event = {"id": "1", "source": "gmail", "title": "Responder ao cliente", "description": "x" * 100_000,
                 "metadata": {"unread": True, "emailId": "email-1", "body": "x" * 1_000_000, "attachments": [{"data": "x" * 1_000_000}]}}
        with patch.object(service, "read_events", AsyncMock(return_value=[event])), patch.object(service, "list_records", AsyncMock(return_value=[])):
            result = await pending.pending_source({"id": "a"}, "messages")
        self.assertEqual(result["inboxOpen"], 1)
        self.assertEqual(result["items"][0]["deepLink"]["entityId"], "email-1")
        self.assertEqual(result["items"][0]["deepLink"]["metadata"], {"emailId": "email-1"})
        self.assertLess(len(json.dumps(result)), 4000)

    async def test_source_endpoint_requires_login_and_validates_the_source(self):
        app = FastAPI()
        app.include_router(router)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual((await client.get("/api/operacao/pendencias/fontes/tasks")).status_code, 401)
            app.dependency_overrides[current_user] = lambda: {"id": "a"}
            self.assertEqual((await client.get("/api/operacao/pendencias/fontes/not-a-source")).status_code, 422)
