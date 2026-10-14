from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import patch
import os
import httpx

from app.modules.team.meeting_intelligence_bridge import MeetingIntelligenceBridge
from tests.unit.test_call_coordinator import actor, event
from tests.unit.test_meeting_session import CALL, CoordinatorSessionTests


class IntelligenceBridgeTests(CoordinatorSessionTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.publish()
        response = {"summary": [], "decisions": [{"segmentId": "s1", "quote": self.segment.text}], "tasks": [], "questions": []}
        self.service = type("Model", (), {})()
        self.service.perguntar_nora = AsyncMock(return_value=json.dumps(response))
        async def names():
            return {"owner": "Ana", "member": "Bruno", "other": "Carla"}
        self.bridge = MeetingIntelligenceBridge(self.coordinator, actor("owner"), CALL, "owner-tab",
                                               model_service=self.service, participant_names=names)
        # Register the real lifecycle hook, then stop the periodic loop to test
        # explicit refresh deterministically without sleeps or duplicate calls.
        self.bridge._unsubscribe = await self.coordinator.subscribe_nora_policy(actor("owner"), CALL, "owner-tab", self.bridge._changed)

    async def asyncTearDown(self):
        await self.bridge.close()
        await super().asyncTearDown()

    async def test_gateway_binds_user_and_publishes_evidence_only(self):
        result = await self.bridge.refresh(force=True)
        self.assertEqual(self.segment.text, result.decisions[0].quote)
        kwargs = self.service.perguntar_nora.call_args.kwargs
        self.assertEqual("owner", kwargs["user_id"])
        self.assertTrue(kwargs["require_complete"])
        self.assertTrue(kwargs["research"])
        self.assertTrue(kwargs["usage_source"].startswith("nora-meeting:shared:"))
        self.assertEqual("CALL_NORA_UNDERSTANDING", self.publisher.sent[-1][2]["type"])

    async def test_pause_never_calls_model(self):
        await self.coordinator.handle_event(actor("owner"), event("CALL_NORA_CONTROL", enabled=False))
        self.assertIsNone(await self.bridge.refresh(force=True))
        self.service.perguntar_nora.assert_not_awaited()

    async def test_new_audience_cannot_be_given_old_speech_by_understanding(self):
        await self.coordinator.handle_event(actor("other"), event("CALL_ACCEPT", client="other"))
        state = (await self.coordinator.active_calls_for(actor("owner")))[0]["nora"]
        for user in ("owner", "member", "other"):
            await self.coordinator.handle_event(actor(user), event("CALL_NORA_CONSENT", client=user, accepted=True, revision=state["revision"]))
        self.assertIsNone(await self.bridge.refresh(force=True))
        self.service.perguntar_nora.assert_not_awaited()

    async def test_actual_nora_gateway_records_token_usage_with_meeting_scope(self):
        from app.services.nora import NoraIAService
        from app.services import ai_costs
        def respond(request):
            answer = {"summary": [], "decisions": [{"segmentId": "s1", "quote": self.segment.text}], "tasks": [], "questions": []}
            return httpx.Response(200, json={"model": "openai/gpt-oss-20b", "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                                             "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(answer)}}]})
        with patch.dict(os.environ, {"GROQ_API_KEY": "synthetic-key", "NORA_PROVIDER": "groq", "NORA_MODEL": "openai/gpt-oss-20b"}):
            service = NoraIAService()
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                service._client = client
                self.bridge.model_service = service
                await self.bridge.refresh(force=True)
        with ai_costs.database() as db:
            row = db.execute("SELECT user_id,input_tokens,output_tokens,source FROM usage ORDER BY created_at DESC LIMIT 1").fetchone()
        self.assertEqual(("owner", 100, 50), (row["user_id"], row["input_tokens"], row["output_tokens"]))
        self.assertTrue(row["source"].startswith("nora-meeting:shared:"))
