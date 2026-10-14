from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from decimal import Decimal
from unittest.mock import patch

from fastapi import HTTPException

from app.core.request_context import reset_request_context, set_request_context
from app.services import ai_costs
from app.services.ai_speech_costs import CallSpeechMeter, SpeechBudget, SpeechBudgetDenied, reserve_speech, settle_speech, speech_overview


class SpeechCostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temp.name})
        self.env.start()
        self.context = set_request_context("test-speech", "primary")
        self.budget = SpeechBudget("groq", "whisper-large-v3-turbo", "seconds", Decimal("40000000") / 3600, 20, 30)
        self.scope = dict(user_id="a", workspace="primary", team_id="t", call_id="c", budget=self.budget)

    async def asyncTearDown(self):
        reset_request_context(self.context)
        self.env.stop()
        self.temp.cleanup()

    def test_billable_minimum_snapshot_and_terminal_idempotency(self):
        key = reserve_speech(**self.scope, event_id="one", quantity=5)
        settle_speech(key, sent=True, completed=False)
        settle_speech(key, sent=False, completed=False)
        result = speech_overview("a", "primary")
        self.assertEqual(10, result["seconds"])
        self.assertEqual("uncertain", result["recentUsage"][0]["status"])
        self.assertEqual(5000, result["recentUsage"][0]["actual_millis"])
        self.assertGreater(result["costUsd"], 0)
        with self.assertRaises(SpeechBudgetDenied):
            reserve_speech(**self.scope, event_id="one", quantity=5)

    def test_token_allowance_and_usd_do_not_become_speech_limits(self):
        ai_costs.save_limit("a", {"monthlyTokenLimit": 100, "monthlyBudgetUsd": 0}, "admin")
        key = reserve_speech(**self.scope, event_id="one", quantity=5)
        settle_speech(key, sent=True, completed=True)
        with ai_costs.database() as db:
            self.assertEqual(0, db.execute("SELECT COUNT(*) FROM usage").fetchone()[0])
        self.assertEqual(10, speech_overview("a", "primary")["seconds"])

    async def test_concurrent_reservations_enforce_meeting_limit(self):
        results = await asyncio.gather(*(asyncio.to_thread(reserve_speech, **self.scope, event_id=str(i), quantity=5) for i in range(5)), return_exceptions=True)
        self.assertEqual(2, sum(isinstance(item, str) for item in results))
        self.assertEqual(3, sum(isinstance(item, SpeechBudgetDenied) for item in results))
        self.assertEqual(20, speech_overview("a", "primary")["seconds"])

    def test_cycle_limit_across_workspaces_and_private_report_scope(self):
        for workspace, call in [("primary", "c1"), ("second", "c2"), ("third", "c3")]:
            key = reserve_speech(**{**self.scope, "workspace": workspace, "call_id": call}, event_id="one", quantity=5)
            settle_speech(key, sent=True, completed=True)
        with self.assertRaises(SpeechBudgetDenied):
            reserve_speech(**{**self.scope, "workspace": "fourth"}, event_id="two", quantity=5)
        self.assertEqual(10, speech_overview("a", "primary")["seconds"])
        self.assertEqual(0, speech_overview("b", "primary")["seconds"])

    def test_unsent_release_and_pending_reset_guard(self):
        key = reserve_speech(**self.scope, event_id="one", quantity=5)
        with self.assertRaises(HTTPException) as exc:
            ai_costs.reset_limit("a", "admin")
        self.assertEqual(409, exc.exception.status_code)
        settle_speech(key, sent=False, completed=False)
        self.assertEqual(0, speech_overview("a", "primary")["seconds"])
        ai_costs.reset_limit("a", "admin")

    async def test_async_meter_and_character_unit(self):
        meter = CallSpeechMeter(**self.scope)
        await meter.reserve("audio", 5)
        await meter.settle("audio", sent=True, completed=True)
        budget = SpeechBudget("elevenlabs", "synthetic", "characters", Decimal(10), 100, 100)
        key = reserve_speech(**{**self.scope, "budget": budget}, event_id="voice", quantity=50)
        settle_speech(key, sent=True, completed=True)
        result = speech_overview("a", "primary")
        self.assertEqual((10, 50), (result["seconds"], result["characters"]))

    def test_administrative_projection_filters_period_user_model_and_preserves_tokens(self):
        key = reserve_speech(**self.scope, event_id="audio", quantity=5)
        settle_speech(key, sent=True, completed=False)
        users = [{"id": "a", "nome": "Ana"}, {"id": "b", "nome": "Bruno"}]
        result = ai_costs.overview(users, "all")
        self.assertEqual(0, result["totals"]["totalTokens"])
        self.assertEqual((10, 5, 1), (result["speech"]["totals"]["seconds"], result["speech"]["totals"]["actualSeconds"], result["speech"]["totals"]["uncertainRequests"]))
        self.assertEqual("uncertain", result["speech"]["recentUsage"][0]["status"])
        self.assertEqual(0, ai_costs.overview(users, "all", user_filter="b")["speech"]["totals"]["requests"])
        self.assertEqual(0, ai_costs.overview(users, "2000-01")["speech"]["totals"]["requests"])
        model_id = ai_costs.identity({"provider": "groq", "model": "whisper-large-v3-turbo"})["id"]
        self.assertEqual(1, ai_costs.overview(users, "cycle", model_filter=model_id)["speech"]["totals"]["requests"])
        self.assertEqual(0, ai_costs.overview(users, "all", model_filter="other")["speech"]["totals"]["requests"])
