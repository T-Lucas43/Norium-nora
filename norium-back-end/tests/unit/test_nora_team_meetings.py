from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.services.nora_team_meetings import NoraTeamMeetingAgent, is_team_meeting_intent


class NoraTeamMeetingAgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.agent = NoraTeamMeetingAgent()
        self.owner = {"id": "owner", "nome": "Ana", "email": "ana@example.com", "permissions": {"chat": True}}
        self.members = [
            {"id": "owner", "nome": "Ana", "email": "ana@example.com"},
            {"id": "member", "nome": "Fernando Lima", "email": "fernando@example.com", "teamOwnerId": "owner"},
        ]

    async def test_schedules_only_visible_team_members_after_confirmation(self) -> None:
        self.assertTrue(is_team_meeting_intent("Agende uma reunião de equipe"))
        with (
            patch("app.modules.team.router.visible_team_members", new=AsyncMock(return_value=self.members)),
            patch("app.modules.team.router.schedule_meeting", new=AsyncMock(return_value={"meeting": {"id": "meeting-1"}, "message": {"id": "message-1"}})) as schedule,
        ):
            prepared = await self.agent.handle(
                message="Agende uma reunião de equipe Revisão semanal em 20/09/2099 às 15h com Fernando por 30 minutos",
                session_id=None,
                user=self.owner,
            )
            self.assertEqual("confirmar", prepared["status"])
            self.assertEqual(["member", "owner"], prepared["fields"]["participantIds"])
            completed = await self.agent.handle(message="sim", session_id=prepared["session_id"], user=self.owner)

        self.assertEqual("criado", completed["status"])
        payload = schedule.await_args.args[0]
        self.assertEqual("team", payload.scope)
        self.assertEqual(["member", "owner"], payload.participantIds)
        self.assertEqual("Revisão semanal", payload.title)

    async def test_rejects_names_outside_the_visible_team_directory(self) -> None:
        with patch("app.modules.team.router.visible_team_members", new=AsyncMock(return_value=self.members)):
            response = await self.agent.handle(
                message="Agende uma reunião de equipe Planejamento em 20/09/2099 às 15h com Roberto",
                session_id=None,
                user=self.owner,
            )
        self.assertEqual("coletando", response["status"])
        self.assertIn("não encontrei roberto nesta equipe", response["response"].casefold())
        self.assertNotIn("participantIds", response["fields"])


if __name__ == "__main__":
    unittest.main()
