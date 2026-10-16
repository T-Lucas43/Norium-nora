"""Cancellation before an idempotency claim must never run the operation."""
from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

from starlette.requests import Request
from starlette.responses import StreamingResponse

from app import bootstrap
from app.core import request_context


class RequestBodyDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not os.getenv("NORIUM_DATA_DIR") or os.getenv("PYTHON_DOTENV_DISABLED") != "1":
            raise RuntimeError("Use the isolated backend audit runner.")
        replacements = {
            "enforce_rate_limit": AsyncMock(),
            "decode_signed_token": lambda *args, **kwargs: {"sub": "synthetic-user"},
            "auth_secret": lambda: "synthetic-only",
            "idempotency_identity": AsyncMock(return_value="synthetic-user"),
            "begin_request": AsyncMock(return_value={"state": "started", "record": {"leaseId": "synthetic-lease"}}),
            "complete_request": AsyncMock(),
            "record_system_log": Mock(),
            "record_request": Mock(),
        }
        for name, replacement in replacements.items():
            self.enterContext(patch.object(bootstrap, name, replacement))
        self.middleware = next(
            item.kwargs["dispatch"] for item in bootstrap.create_app().user_middleware
            if "dispatch" in item.kwargs
        )
        self.parent = request_context.set_request_context("parent-request", "parent-workspace")
        request_context.set_ai_user_id("parent-ai")
        self.addCleanup(request_context.reset_request_context, self.parent)
        self.handler = AsyncMock(side_effect=self.respond)

    async def respond(self, request):
        self.assertEqual("test-request", request_context.current_request_id())
        self.assertEqual("test-workspace", request_context.current_workspace_id())
        self.assertEqual("", request_context.current_ai_user_id())
        self.assertEqual(b'{"synthetic":true}', await request.body())
        return StreamingResponse(iter([b'{"ok":true}']), media_type="application/json")

    def request(self, receive):
        return Request({
            "type": "http", "method": "PUT", "scheme": "https",
            "path": "/api/test-body-disconnect", "query_string": b"",
            "headers": [(b"authorization", b"Bearer synthetic-only"),
                        (b"idempotency-key", b"synthetic-key"),
                        (b"x-request-id", b"test-request"),
                        (b"x-norium-workspace", b"test-workspace")],
        }, receive=receive)

    def assert_parent_context(self):
        self.assertEqual("parent-request", request_context.current_request_id())
        self.assertEqual("parent-workspace", request_context.current_workspace_id())
        self.assertEqual("parent-ai", request_context.current_ai_user_id())

    def assert_no_operation(self):
        self.handler.assert_not_awaited()
        bootstrap.begin_request.assert_not_awaited()
        bootstrap.complete_request.assert_not_awaited()
        self.assert_parent_context()

    async def test_disconnect_before_claim_returns_499_without_running_operation(self):
        receive = AsyncMock(side_effect=[
            {"type": "http.request", "body": b'{"synthetic":', "more_body": True},
            {"type": "http.disconnect"},
        ])
        response = await self.middleware(self.request(receive), self.handler)
        self.assertEqual(499, response.status_code)
        self.assertEqual(b"", response.body)
        bootstrap.idempotency_identity.assert_awaited_once()
        bootstrap.record_system_log.assert_not_called()
        self.assert_no_operation()

    async def test_complete_body_keeps_operation_and_idempotency_completion(self):
        receive = AsyncMock(return_value={
            "type": "http.request", "body": b'{"synthetic":true}', "more_body": False,
        })
        response = await self.middleware(self.request(receive), self.handler)
        self.assertEqual(200, response.status_code)
        self.handler.assert_awaited_once()
        bootstrap.begin_request.assert_awaited_once()
        bootstrap.complete_request.assert_awaited_once()
        self.assertEqual("synthetic-lease", bootstrap.complete_request.await_args.kwargs["lease_id"])
        self.assert_parent_context()

    async def test_other_body_errors_still_propagate_and_are_recorded(self):
        receive = AsyncMock(side_effect=ValueError("synthetic body failure"))
        with self.assertRaisesRegex(ValueError, "synthetic body failure"):
            await self.middleware(self.request(receive), self.handler)
        bootstrap.record_system_log.assert_called_once()
        self.assertEqual("http_request_failed", bootstrap.record_system_log.call_args.args[0])
        self.assertEqual("ValueError", bootstrap.record_system_log.call_args.kwargs["metadata"]["errorType"])
        self.assert_no_operation()
