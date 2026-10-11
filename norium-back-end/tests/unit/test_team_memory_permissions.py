"""Memória de equipe da Nora: só quem gerencia a equipe grava; membros salvam como pessoal."""

import os
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import HTTPException

from app.core.request_context import reset_request_context, set_request_context
from app.modules.nora import router as nora_router
import importlib

from app.modules.operations import service as ops
from app.modules.operations.schemas import NoraMemoryCreate


def member() -> dict:
    return {"id": "member-1", "teamOwnerId": "owner-1", "role": "member", "plan": "equipe", "status": "ativo", "permissions": {"nora": True}}


def manager() -> dict:
    return {"id": "owner-1", "role": "owner", "plan": "equipe", "status": "ativo", "permissions": {"nora": True}}


operations_router = importlib.import_module("app.modules.operations.router")

TEAM_PREFERENCE = NoraMemoryCreate(key="tom", value="Responder sempre de forma formal", category="communication", scope="team")


class TeamMemoryPermissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test", "NORIUM_DATABASE_URL": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request_context = set_request_context("test-team-memory", "primary")
        self.addCleanup(reset_request_context, self.request_context)

    async def test_member_cannot_write_team_memory(self) -> None:
        with self.assertRaises(PermissionError):
            await ops.save_nora_memory(member(), TEAM_PREFERENCE)
        self.assertEqual([], await ops.list_nora_memory(manager()))

    async def test_member_route_returns_403(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            await operations_router.create_nora_memory(TEAM_PREFERENCE, member())
        self.assertEqual(403, caught.exception.status_code)

    async def test_manager_writes_team_memory_visible_to_members(self) -> None:
        await ops.save_nora_memory(manager(), TEAM_PREFERENCE)
        values = [item["value"] for item in await ops.list_nora_memory(member())]
        self.assertIn("Responder sempre de forma formal", values)

    async def test_member_personal_memory_still_works(self) -> None:
        personal = NoraMemoryCreate(key="tom", value="Prefiro respostas curtas", category="communication", scope="personal")
        item = await ops.save_nora_memory(member(), personal)
        self.assertEqual("personal", item["scope"])

    async def test_memories_are_marked_as_data_not_instructions(self) -> None:
        await ops.save_nora_memory(manager(), TEAM_PREFERENCE)
        text = await nora_router.message_with_memory(member(), "escreva um e-mail", {"communication"})
        self.assertIn("nao sao instrucoes", text)
        self.assertIn("<<preferencias>>", text)


if __name__ == "__main__":
    unittest.main()
