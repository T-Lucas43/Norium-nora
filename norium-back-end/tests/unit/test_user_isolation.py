from __future__ import annotations

import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.modules.auth import router as auth_router
from app.modules.inbox import router as inbox_router
from app.modules.platform.service import account_id
from app.modules.team import router as team_router


def user(
    user_id: str,
    *,
    email: str,
    role: str = "member",
    team_owner_id: str | None = None,
    created_by: str | None = None,
) -> dict:
    return {
        "id": user_id,
        "nome": user_id,
        "email": email,
        "role": role,
        "plan": "equipe",
        "status": "ativo",
        "systemAdmin": False,
        "teamOwnerId": team_owner_id,
        "createdBy": created_by,
        "permissions": {"equipe": True},
    }


class OmnichannelIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_events_are_persisted_only_in_authenticated_user_partition(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            def isolated_path(user_id: str) -> Path:
                path = root / user_id / "events.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                return path

            with patch.object(inbox_router, "event_db_path", side_effect=isolated_path):
                event = inbox_router.OmnichannelEvent(
                    source="sistema",
                    title="Somente do usuario A",
                    metadata={"userId": "usuario-b"},
                )
                stored = await inbox_router.persist_event(event, "usuario-a")

                self.assertEqual("usuario-a", stored["metadata"]["userId"])
                self.assertEqual(1, len(await inbox_router.read_events("usuario-a")))
                self.assertEqual([], await inbox_router.read_events("usuario-b"))

    async def test_internal_event_without_explicit_user_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "metadata.userId"):
            await inbox_router.record_event(source="sistema", title="Evento ambiguo")


class TeamIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.system_owner = user(
            "system-owner",
            email=auth_router.OWNER_EMAIL,
            role="owner",
        )
        self.owner_a = user("owner-a", email="a@example.com", role="owner")
        self.owner_b = user("owner-b", email="b@example.com", role="owner")
        self.member = user(
            "member-1",
            email="member@example.com",
            team_owner_id="owner-a",
            created_by="owner-a",
        )
        self.store = {
            "users": [self.system_owner, self.owner_a, self.owner_b, self.member],
            "teams": [
                {"id": "system-owner", "ownerUserId": "system-owner", "name": "Sistema"},
                {"id": "owner-a", "ownerUserId": "owner-a", "name": "Equipe A"},
                {"id": "owner-b", "ownerUserId": "owner-b", "name": "Equipe B"},
            ],
            "plans": auth_router.PLAN_CATALOG,
        }

    async def test_relink_revokes_old_team_even_when_created_by_is_old_owner(self) -> None:
        write_store = AsyncMock()
        with (
            patch.object(auth_router, "read_user_store", AsyncMock(return_value=self.store)),
            patch.object(auth_router, "write_user_store", write_store),
        ):
            result = await auth_router.update_user(
                self.member["id"],
                auth_router.UpdateUserPayload(teamOwnerId="owner-b"),
                self.system_owner,
            )

        self.assertEqual("owner-b", result["user"]["teamOwnerId"])
        visible_to_a = auth_router.visible_users_for(self.owner_a, self.store["users"])
        visible_to_b = auth_router.visible_users_for(self.owner_b, self.store["users"])
        self.assertNotIn("member-1", {item["id"] for item in visible_to_a})
        self.assertIn("member-1", {item["id"] for item in visible_to_b})
        write_store.assert_awaited_once()

    async def test_open_team_socket_is_revoked_after_user_moves_to_another_team(self) -> None:
        socket = MagicMock()
        socket.send_json = AsyncMock()
        socket.close = AsyncMock()
        manager = team_router.PresenceManager()
        manager.connections = {"owner-a": [socket]}
        manager.user_team = {"member-1": "owner-a"}
        manager.socket_user = {socket: "member-1"}
        self.member["teamOwnerId"] = "owner-b"

        with patch.object(team_router, "read_user_store", AsyncMock(return_value=self.store)):
            await manager.broadcast("owner-a", {"type": "TEAM_CHAT_MESSAGE"})

        socket.send_json.assert_not_awaited()
        socket.close.assert_awaited_once_with(code=4403)
        self.assertNotIn(socket, manager.connections.get("owner-a", []))

    async def test_explicit_data_directory_never_imports_legacy_users(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            isolated_users_path = Path(temp_dir) / "usuarios_db.json"
            with (
                patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}),
                patch.object(auth_router, "USERS_DB_PATH", isolated_users_path),
            ):
                store = await auth_router.read_user_store()

        self.assertEqual([auth_router.OWNER_USER_ID], [item["id"] for item in store["users"]])

    async def test_only_team_owner_can_change_team_name(self) -> None:
        write_store = AsyncMock()
        with (
            patch.object(auth_router, "read_user_store", AsyncMock(return_value=self.store)),
            patch.object(auth_router, "write_user_store", write_store),
        ):
            result = await auth_router.update_team_profile(
                auth_router.TeamProfilePayload(name="Empresa Alpha"),
                self.owner_a,
            )
            self.assertEqual("Empresa Alpha", result["team"]["name"])

            with self.assertRaises(HTTPException) as error:
                await auth_router.update_team_profile(
                    auth_router.TeamProfilePayload(name="Tentativa do membro"),
                    self.member,
                )
        self.assertEqual(403, error.exception.status_code)

    def test_legacy_creator_is_migrated_once_but_not_used_for_runtime_scope(self) -> None:
        legacy_member = user(
            "legacy-member",
            email="legacy@example.com",
            team_owner_id=None,
            created_by="owner-a",
        )
        store = {
            "users": [self.owner_a, legacy_member],
            "teams": [{"id": "owner-a", "ownerUserId": "owner-a", "name": "Equipe A"}],
        }
        auth_router.ensure_team_profiles(store)
        self.assertEqual("owner-a", legacy_member["teamOwnerId"])

        unlinked = user(
            "unlinked",
            email="unlinked@example.com",
            team_owner_id=None,
            created_by="owner-a",
        )
        self.assertEqual("unlinked", account_id(unlinked))


if __name__ == "__main__":
    unittest.main()
