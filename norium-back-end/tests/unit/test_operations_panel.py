from __future__ import annotations

import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

from app.core.request_context import current_workspace_id, reset_request_context, set_request_context
from app.modules.operations import panel, service


class OperationsPanelTests(unittest.IsolatedAsyncioTestCase):
    async def test_locked_accounts_do_not_exhaust_data_threads_and_preserve_workspace(self):
        release = threading.Event()
        both_started = threading.Event()
        scopes = []
        def locked(user_id, *_args):
            scopes.append((user_id, current_workspace_id()))
            if len(scopes) == 2:
                both_started.set()
            release.wait(5)
            return []

        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        with patch.object(service, "integration_health", side_effect=locked):
            context = set_request_context("isolation", "other")
            try:
                requests = [asyncio.create_task(service.read_integration_health(user, [], [])) for user in ("a", "b", "c")]
            finally:
                reset_request_context(context)
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(both_started.wait, 1), 2))
                self.assertEqual("data available", await asyncio.wait_for(asyncio.to_thread(lambda: "data available"), 1))
                self.assertEqual(len(scopes), 2)
            finally:
                release.set()
                await asyncio.gather(*requests)
        self.assertEqual(sorted(scopes), [("a", "other"), ("b", "other"), ("c", "other")])

    async def test_summary_never_waits_for_integrations_or_hidden_resources(self):
        with (
            patch.object(service, "read_events", new=AsyncMock(return_value=[])),
            patch.object(service, "list_tasks", return_value={"tasks": [], "stats": {"ativas": 3, "vencidas": 1}}),
            patch.object(service, "list_finance", return_value={}),
            patch.object(service, "read_integration_health", side_effect=AssertionError("Unexpected integration read")),
            patch.object(panel, "list_items", side_effect=AssertionError("Unexpected secondary read")),
        ):
            result = await panel.panel_section({"id": "a"}, "summary")
        self.assertEqual(3, result["summary"]["activeTasks"])
        self.assertNotIn("pendingApprovals", result["summary"])
        self.assertNotIn("aprovacao", result["briefing"]["description"])

    async def test_pending_approvals_are_not_lost_behind_a_history_limit(self):
        items = [{"id": str(i), "status": "executed", "payload": {"private": True}} for i in range(60)]
        items.append({"id": "pending", "status": "pending", "payload": {"private": True}})
        with patch.object(panel, "list_items", new=AsyncMock(return_value=items)):
            result = await panel.panel_section({"id": "a"}, "approvals")
        self.assertEqual([{"id": "pending", "status": "pending"}], result["approvals"])
        self.assertEqual(1, result["summary"]["pendingApprovals"])

    async def test_history_does_not_transport_full_undo_snapshots(self):
        with patch.object(panel, "list_items", new=AsyncMock(return_value=[{"id": "1", "metadata": {"previous": {"large": "x" * 10000}, "undoneAt": "today"}}])):
            result = await panel.panel_section({"id": "a"}, "history")
        self.assertEqual({"undoneAt": "today"}, result["receipts"][0]["metadata"])

    async def test_locked_integration_read_does_not_block_event_loop_and_reuses_pending_work(self):
        release = threading.Event()
        def slow(*_args):
            release.wait(timeout=3)
            return []
        with patch.object(service, "integration_health", side_effect=slow) as read:
            first = asyncio.create_task(service.read_integration_health("a", [], []))
            second = asyncio.create_task(service.read_integration_health("a", [], []))
            try:
                await asyncio.sleep(0.05)
                self.assertFalse(first.done())
                self.assertEqual(1, read.call_count)
            finally:
                release.set()
                await asyncio.gather(first, second)
