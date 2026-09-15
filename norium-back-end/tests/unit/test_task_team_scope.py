from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.modules.tasks import router


class TaskTeamScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.user = {"id": "member", "nome": "Fernando", "teamOwnerId": "owner"}
        self.directory = {
            "users": [
                {"id": "owner", "nome": "Ana"},
                {"id": "member", "nome": "Fernando", "teamOwnerId": "owner"},
                {"id": "peer", "nome": "Joana", "teamOwnerId": "owner"},
                {"id": "outsider", "nome": "Outra pessoa", "teamOwnerId": "other"},
            ]
        }

    async def test_project_directory_excludes_stale_cross_team_shares(self) -> None:
        projects = [
            {"id": "mine", "ownerUserId": "member"},
            {"id": "team", "ownerUserId": "peer", "sharedUserIds": ["member"]},
            {"id": "stale", "ownerUserId": "outsider", "sharedUserIds": ["member"]},
        ]
        with (
            patch.object(router, "read_user_store", new=AsyncMock(return_value=self.directory)),
            patch.object(router, "list_projects", return_value={"projects": projects}),
        ):
            visible = await router.accessible_team_projects(self.user)
        self.assertEqual(["mine", "team"], [item["id"] for item in visible])

    async def test_project_sharing_is_sanitized_to_current_team(self) -> None:
        with patch.object(router, "read_user_store", new=AsyncMock(return_value=self.directory)):
            cleaned = await router.safe_project_payload(
                self.user,
                {"sharedUserIds": ["peer", "outsider"], "responsibleUserId": "outsider", "responsibleName": "Outra pessoa"},
            )
        self.assertEqual(["peer"], cleaned["sharedUserIds"])
        self.assertEqual("member", cleaned["responsibleUserId"])
        self.assertEqual("Fernando", cleaned["responsibleName"])


if __name__ == "__main__":
    unittest.main()
