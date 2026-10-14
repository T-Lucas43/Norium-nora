from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.modules.team import meeting_router as api
from tests.unit.test_meeting_session import CALL, CoordinatorSessionTests


class RouterTests(CoordinatorSessionTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.publish()
        self.user = {"id": "member", "nome": "Member", "status": "ativo", "teamOwnerId": "owner", "teamChatEnabled": True,
                     "plan": "equipe", "role": "member", "permissions": {"chat": True, "nora": True}}
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.dependency_overrides[api.team.current_user] = lambda: self.user
        self.mock_model = AsyncMock(return_value=json.dumps({"text": "A proposta será revisada.", "segmentIds": ["s1"]}))
        self.patches = [patch.object(api.team, "call_coordinator", return_value=self.coordinator),
                        patch.object(api.team, "read_user_store", AsyncMock(side_effect=lambda: {"users": [self.user]})),
                        patch.object(api.nora_service, "perguntar_nora", self.mock_model)]
        for item in self.patches:
            item.start()
        api._results.clear()
        api._pending.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        for item in reversed(self.patches):
            item.stop()
        api._results.clear()
        api._pending.clear()
        await super().asyncTearDown()

    async def question(self, request_id="question-1", question="Qual foi a decisão?"):
        return await self.client.post(f"/api/team-chat/calls/{CALL}/nora/question",
                                      json={"clientId": "member-tab", "requestId": request_id, "question": question})

    async def test_private_answer_cached_no_room_event_and_exact_scope(self):
        count = len(self.publisher.sent)
        first = await self.question()
        second = await self.question()
        self.assertEqual(200, first.status_code)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(1, self.mock_model.await_count)
        self.assertTrue(self.mock_model.call_args.kwargs["usage_source"].startswith("nora-meeting:private:"))
        self.assertEqual("member", first.json()["recipientUserId"])
        self.assertTrue(first.json()["private"])
        self.assertEqual("s1", first.json()["sources"][0]["segmentId"])
        self.assertEqual(count, len(self.publisher.sent))
        self.assertEqual(409, (await self.question(question="Outra pergunta com mesmo ID")).status_code)
        self.assertIn("no-store", first.headers["cache-control"])

    async def test_no_permission_or_wrong_client_never_calls_model(self):
        self.user["permissions"]["nora"] = False
        self.assertEqual(403, (await self.question()).status_code)
        self.user["permissions"]["nora"] = True
        response = await self.client.get(f"/api/team-chat/calls/{CALL}/nora/session?clientId=old-tab")
        self.assertEqual(409, response.status_code)
        self.mock_model.assert_not_awaited()

    async def test_private_view_hides_media_session_and_audio_upload_route_absent(self):
        response = await self.client.get(f"/api/team-chat/calls/{CALL}/nora/session?clientId=member-tab")
        self.assertEqual(200, response.status_code)
        self.assertNotIn("mediaSessionId", response.json())
        self.assertEqual(404, (await self.client.post(f"/api/team-chat/calls/{CALL}/nora/audio", content=b"audio")).status_code)

    async def test_model_action_fields_or_unknown_sources_rejected_and_not_retried(self):
        self.mock_model.return_value = json.dumps({"text": "Enviado", "segmentIds": ["s1"], "execute": "email.send"})
        self.assertEqual(502, (await self.question()).status_code)
        self.assertEqual(409, (await self.question()).status_code)
        self.assertEqual(1, self.mock_model.await_count)
        self.mock_model.return_value = json.dumps({"text": "Resposta", "segmentIds": ["outside"]})
        self.assertEqual(502, (await self.question(request_id="question-2")).status_code)

    async def test_roster_change_during_answer_refuses_response(self):
        async def answer(*args, **kwargs):
            from tests.unit.test_call_coordinator import actor, event
            await self.coordinator.handle_event(actor("other"), event("CALL_ACCEPT", client="other"))
            return json.dumps({"text": "Resposta antiga", "segmentIds": ["s1"]})
        self.mock_model.side_effect = answer
        self.assertEqual(409, (await self.question()).status_code)

    async def test_nora_permission_revalidated_after_model_and_no_sources_no_claim(self):
        self.mock_model.return_value = json.dumps({"text": "Eu executei a ação", "segmentIds": []})
        response = await self.question()
        self.assertEqual(200, response.status_code)
        self.assertNotIn("executei", response.json()["text"])
        async def answer(*args, **kwargs):
            self.user["permissions"]["nora"] = False
            return json.dumps({"text": "Não devolver resposta", "segmentIds": ["s1"]})
        self.mock_model.side_effect = answer
        self.assertEqual(403, (await self.question(request_id="question-2")).status_code)
