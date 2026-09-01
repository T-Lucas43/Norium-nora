from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.team import router as team_router


def team_user(user_id: str, *, owner_id: str | None = None) -> dict:
    return {
        "id": user_id,
        "nome": user_id.title(),
        "email": f"{user_id}@example.test",
        "status": "ativo",
        "role": "owner" if owner_id is None else "member",
        "teamOwnerId": owner_id,
        "permissions": {"chat": True, "equipe": True},
        "systemAdmin": False,
    }


class TeamCollaborationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="norium_team_")
        self.chat_path = Path(self.temp_dir.name) / "team_chat.json"
        self.owner = team_user("owner")
        self.member = team_user("member", owner_id="owner")
        self.other_member = team_user("other", owner_id="owner")
        self.users = {"users": [self.owner, self.member, self.other_member]}

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_subteam_is_persisted_and_only_members_can_read_its_messages(self) -> None:
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
        ):
            created = await team_router.create_subteam(
                team_router.SubteamCreatePayload(
                    name="Comercial",
                    description="Propostas e negociacoes",
                    memberIds=["member"],
                ),
                self.owner,
            )
            subteam = created["subteam"]
            self.assertEqual({"owner", "member"}, set(subteam["memberIds"]))

            await team_router.send_subteam_message(
                subteam["id"],
                team_router.SendSubteamMessagePayload(
                    text="Revisar proposta hoje.",
                ),
                self.member,
            )
            listing = await team_router.list_subteam_messages(
                subteam_id=subteam["id"],
                user=self.owner,
            )
            self.assertEqual("Revisar proposta hoje.", listing["messages"][0]["text"])

            with self.assertRaises(HTTPException) as error:
                await team_router.list_subteam_messages(
                    subteam_id=subteam["id"],
                    user=self.other_member,
                )
            self.assertEqual(403, error.exception.status_code)

    async def test_direct_message_is_sent_only_to_its_two_participants(self) -> None:
        manager = team_router.PresenceManager()
        manager.send_to_users = AsyncMock()
        with (
            patch.object(team_router, "team_chat_path", return_value=str(self.chat_path)),
            patch.object(team_router, "read_user_store", AsyncMock(return_value=self.users)),
            patch.object(team_router, "read_profile_db", return_value={}),
            patch.object(team_router, "record_team_event", AsyncMock()),
            patch.object(team_router, "manager", manager),
        ):
            await team_router.send_message(
                team_router.SendTeamMessagePayload(scope="direct", recipientId="member", text="Privado"),
                self.owner,
            )

        recipients = manager.send_to_users.await_args.args[1]
        self.assertEqual({"owner", "member"}, recipients)
        self.assertNotIn("other", recipients)


if __name__ == "__main__":
    unittest.main()
