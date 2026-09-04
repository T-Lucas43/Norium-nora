from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from app.modules.workhub import service


class WorkHubLoadingTests(unittest.IsolatedAsyncioTestCase):
    user = {"id": "workhub-loading-test", "nome": "Teste"}

    async def test_pending_reuses_events_and_counts_open_inbox(self):
        now = datetime.now(timezone.utc).isoformat()
        events = [
            {"id": key, "source": "gmail", "title": key, "timestamp": now, "metadata": {"unread": True}}
            for key in ("new", "waiting", "resolved", "archived")
        ]
        overrides = [
            {"eventId": "waiting", "status": "aguardando"},
            {"eventId": "resolved", "status": "resolvido"},
            {"eventId": "archived", "status": "arquivado"},
        ]
        with (
            patch.object(service, "read_events", AsyncMock(return_value=events)) as read,
            patch.object(service, "list_records", AsyncMock(return_value=overrides)),
            patch.object(service, "list_items", AsyncMock(return_value=[])),
            patch.object(service, "list_tasks", return_value={"tasks": []}),
            patch.object(service, "list_finance", return_value={"lembretes": []}),
            patch.object(service, "integration_health", return_value=[]),
        ):
            result = await service.pending_center(self.user)
        read.assert_awaited_once_with(self.user["id"])
        self.assertEqual(result["inboxOpen"], 2)
        self.assertEqual([item["id"] for item in result["items"]], ["inbox_new"])
        self.assertEqual(result["counts"], {"message": 1})

    async def test_header_summary_skips_team_scan_without_changing_totals(self):
        now = datetime.now(timezone.utc).isoformat()
        events = [{"source": "gmail", "timestamp": now, "metadata": {"savedMinutes": 30}}]
        receipt = {"status": "executed", "timestamp": now, "metadata": {"savedMinutes": 15}}

        async def items(_user, db):
            return [receipt] if db == service.RECEIPT_DB else []

        with (
            patch.object(service, "read_events", AsyncMock(return_value=events)),
            patch.object(service, "list_items", side_effect=items),
            patch.object(service, "weekly_productivity", AsyncMock(return_value={"members": [{"userId": "member"}]})) as team,
        ):
            header = await service.weekly_summary(self.user, include_team=False)
            team.assert_not_awaited()
            full = await service.weekly_summary(self.user)
            team.assert_awaited_once_with(self.user)
        self.assertEqual(header["actionsExecuted"], 1)
        self.assertEqual(header["estimatedMinutesSaved"], 45)
        for key in ("actionsExecuted", "estimatedHoursSaved", "headline", "eventsByChannel"):
            self.assertEqual(header[key], full[key])
        self.assertNotIn("members", header)
        self.assertEqual(len(full["members"]), 1)
