from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch
import httplib2
from googleapiclient.errors import HttpError
from fastapi import HTTPException
from app.services import gmail_read_limits as limits
from app.services.gmail_service import GmailService
from app.modules.mail import router


def provider_error(status=403, reason="rateLimitExceeded", body=None):
    content = body if body is not None else json.dumps({"error": {"errors": [{"reason": reason}], "message": "private provider data"}}).encode()
    return HttpError(httplib2.Response({"status": str(status)}), content, uri="https://provider.invalid/private-message-id")


class GmailReadLimitsTests(unittest.TestCase):
    def setUp(self):
        limits._budgets.clear(); limits._paused.clear()

    def test_recognizes_google_403_rate_and_429_without_leaking_details(self):
        for error in (provider_error(), provider_error(429, body=b"temporarily limited")):
            safe = limits.provider_throttle(error)
            self.assertIsInstance(safe, limits.GmailRateLimitError)
            self.assertNotIn("private", str(safe))
            self.assertNotIn("provider.invalid", str(safe))

    def test_permission_errors_are_not_misreported_as_quota(self):
        self.assertIsNone(limits.provider_throttle(provider_error(reason="insufficientPermissions")))

    def test_background_reads_leave_room_for_opening_a_message(self):
        limits.reserve_read("alice", 3_500, background=True)
        with self.assertRaises(limits.GmailRateLimitError): limits.reserve_read("alice", 20, background=True)
        limits.reserve_read("alice", 20)

    def test_read_budget_is_scoped_and_recovers_after_window(self):
        with patch.object(limits.time, "monotonic", return_value=100):
            limits.reserve_read("alice", limits.READ_UNITS_PER_MINUTE)
            with self.assertRaises(limits.GmailRateLimitError): limits.reserve_read("alice", 20)
            limits.reserve_read("bob", 20)
        with patch.object(limits.time, "monotonic", return_value=161):
            limits.reserve_read("alice", 20)

    def test_throttled_read_does_not_retry_provider_or_retain_contents(self):
        request = MagicMock(); request.execute.side_effect = provider_error()
        with self.assertRaises(limits.GmailRateLimitError): limits.execute_read("alice", request)
        with self.assertRaises(limits.GmailRateLimitError): limits.execute_read("alice", request)
        request.execute.assert_called_once()
        self.assertNotIn("alice", limits._budgets)

    def test_batch_quota_failure_stops_without_individual_retry_storm(self):
        service = MagicMock(); factory = MagicMock()
        def batch_factory(callback):
            batch = MagicMock()
            batch.execute.side_effect = lambda: callback("0", None, provider_error())
            return batch
        service.new_batch_http_request.side_effect = batch_factory
        with self.assertRaises(limits.GmailRateLimitError):
            GmailService("alice")._execute_batch(service, [{"id": "synthetic"}], factory)
        factory.return_value.execute.assert_not_called()

    def test_batch_chunks_are_bounded_and_keep_order(self):
        service = MagicMock(); chunks = []
        def batch_factory(callback):
            rows = []; chunks.append(rows); batch = MagicMock()
            batch.add.side_effect = lambda request, request_id: rows.append(request_id)
            batch.execute.side_effect = lambda: [callback(i, {"id": f"m{i}"}, None) for i in reversed(rows)]
            return batch
        service.new_batch_http_request.side_effect = batch_factory
        result = GmailService("alice")._execute_batch(service, [{"id": str(i)} for i in range(45)], MagicMock())
        self.assertEqual([len(chunk) for chunk in chunks], [20, 20, 5])
        self.assertEqual([item["id"] for item in result], [f"m{i}" for i in range(45)])


class GmailQuotaRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_body_read_returns_429_and_retry_after(self):
        with patch.object(router, "GmailService") as service:
            service.return_value.get_message.side_effect = limits.GmailRateLimitError(35)
            with self.assertRaises(HTTPException) as caught:
                await router.get_gmail_message("synthetic", user={"id": "alice"})
            self.assertEqual(caught.exception.status_code, 429)
            self.assertEqual(caught.exception.headers["Retry-After"], "35")

    async def test_list_returns_429_instead_of_generic_502(self):
        with patch.object(router, "GmailService") as service:
            service.return_value.list_messages.side_effect = limits.GmailRateLimitError()
            with self.assertRaises(HTTPException) as caught:
                await router.list_gmail_messages(user={"id": "alice"}, max_results=25)
            self.assertEqual(caught.exception.status_code, 429)
