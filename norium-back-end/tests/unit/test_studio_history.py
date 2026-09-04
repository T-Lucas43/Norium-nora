import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.request_context import reset_request_context, set_request_context
from app.modules.nora import conversations as history
from app.services.brainstorm_store import create_brainstorm_session, get_brainstorm_session, save_brainstorm_board
from app.services.studio_templates import TEMPLATES, build_template_board


class StudioTemplateTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_template_creates_editable_persisted_nodes(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"NORIUM_DATA_DIR": folder}):
            for template in TEMPLATES:
                with self.subTest(template=template):
                    session = await create_brainstorm_session("owner", {"title": "Projeto de teste", "template": template, "objective": "Objetivo informado"}, {"id": "owner"})
                    board = session["board"]
                    self.assertGreater(len(board["nodes"]), 3)
                    self.assertEqual(len(board["nodes"]), len({node["id"] for node in board["nodes"]}))
                    card = next(node for node in board["nodes"] if node["data"]["variant"] == "sticky")
                    self.assertEqual(card["data"]["description"], "Objetivo informado")
                    card["data"].update(label="Entrega revisada", completed=True, dueDate="2026-09-30")
                    await save_brainstorm_board("owner", session["id"], board, {"id": "owner"})
                    reopened = await get_brainstorm_session("owner", session["id"])
                    self.assertIn("Entrega revisada", [node["data"]["label"] for node in reopened["board"]["nodes"]])
                    self.assertIsNone(await get_brainstorm_session("another-owner", session["id"]))

    def test_blank_board_and_independent_instances(self):
        self.assertEqual(build_template_board("livre")["nodes"], [])
        a = build_template_board("lista-afazeres")
        b = build_template_board("lista-afazeres")
        self.assertNotEqual(a["nodes"][0]["id"], b["nodes"][0]["id"])
        self.assertTrue(all(not node["data"]["completed"] for node in a["nodes"] if "completed" in node["data"]))


class NoraHistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name})
        self.environment.start()
        self.app = FastAPI()
        self.app.include_router(history.router, prefix="/api/nora")
        self.user = {"id": "person-a", "permissions": {"nora": True}}
        self.app.dependency_overrides[history.current_user] = lambda: self.user
        self.client = TestClient(self.app)
        self.url = "/api/nora/conversations/chat-test-123"

    def tearDown(self):
        self.client.close()
        self.environment.stop()
        self.directory.cleanup()

    def payload(self, revision=0):
        return {"title": "Planejamento", "revision": revision, "state": {"messages": [{"role": "user", "text": "Meu plano"}, {"role": "ai", "text": "Vamos organizar."}], "agendaSessionId": "agenda-123", "agendaAgentActive": True}}

    def test_save_reopen_rename_and_delete_without_resurrection(self):
        response = self.client.put(self.url, json=self.payload())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["revision"], 1)
        record = self.client.get(self.url).json()
        self.assertEqual(record["state"]["messages"][1]["text"], "Vamos organizar.")
        self.assertTrue(record["state"]["agendaAgentActive"])
        renamed = {**self.payload(1), "title": "Novo nome"}
        self.assertEqual(self.client.put(self.url, json=renamed).status_code, 200)
        listing = self.client.get("/api/nora/conversations").json()
        self.assertEqual(listing[0]["title"], "Novo nome")
        self.assertNotIn("state", listing[0])
        self.assertEqual(self.client.delete(self.url).status_code, 200)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.get("/api/nora/conversations").json(), [])
        self.assertEqual(self.client.put(self.url, json=self.payload(2)).status_code, 409)

    def test_isolates_users_and_workspaces_and_requires_permission(self):
        self.assertEqual(self.client.put(self.url, json=self.payload()).status_code, 200)
        self.user = {"id": "person-b", "teamOwnerId": "person-a", "permissions": {"nora": True}}
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.get("/api/nora/conversations").json(), [])
        self.assertEqual(self.client.delete(self.url).status_code, 404)
        self.user = {"id": "person-a", "permissions": {"nora": True}}
        tokens = set_request_context("test", "workspace-b")
        try:
            self.assertEqual(self.client.get(self.url).status_code, 404)
        finally:
            reset_request_context(tokens)
        self.user["permissions"]["nora"] = False
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.assertEqual(self.client.put(self.url, json=self.payload()).status_code, 403)

    def test_rejects_conflicting_or_unbounded_payloads(self):
        self.client.put(self.url, json=self.payload())
        self.assertEqual(self.client.put(self.url, json=self.payload()).status_code, 409)
        invalid = self.payload(1)
        invalid["state"]["messages"][0]["role"] = "system"
        self.assertEqual(self.client.put(self.url, json=invalid).status_code, 422)
        self.assertEqual(self.client.get("/api/nora/conversations/..").status_code, 404)
