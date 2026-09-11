from __future__ import annotations

import asyncio
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.modules.team import router as team
from app.modules.team import studio_router as studio


def member(user_id, owner="owner"):
    return {"id": user_id, "nome": user_id.title(), "teamOwnerId": owner,
            "status": "ativo", "permissions": {"chat": True}}


class CallStudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.owner, self.member, self.other = member("owner"), member("member"), member("other")
        self.socket = MagicMock(send_json=AsyncMock())
        self.patches = [
            patch.object(team, "chat_lock", asyncio.Lock()),
            patch.object(team, "_call_coordinator_instance", None),
            patch.object(team, "team_chat_path", side_effect=lambda tenant: str(Path(self.temp.name) / f"{tenant}.json")),
            patch.object(team, "read_user_store", AsyncMock(return_value={"users": [self.owner, self.member, self.other]})),
            patch.object(team, "read_profile_db", return_value={}),
            patch.object(team.manager, "send_to_users", AsyncMock()),
        ]
        for item in self.patches:
            item.start()
        self.call_id = "call_0123456789abcdef"
        await self.event("CALL_INVITE", self.owner)

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def event(self, kind, user):
        await team.handle_call_event(self.socket, user, {"type": kind, "callId": self.call_id,
                                                        "scope": "team", "clientId": f"{user['id']}-tab"})

    async def open(self, user=None, **kwargs):
        user = user or self.owner
        return (await studio.start_studio(self.call_id, studio.StudioStart(clientId=f"{user['id']}-tab", **kwargs), user))["session"]

    async def op(self, kind, item="note", user=None, **kwargs):
        user = user or self.owner
        return (await studio.mutate_studio(self.call_id, studio.StudioOperation(
            clientId=f"{user['id']}-tab", operationId=kwargs.pop("operationId", uuid.uuid4().hex),
            kind=kind, itemId=item, **kwargs), user))["session"]

    async def test_only_host_opens_and_joined_participants_can_read_and_edit(self):
        await self.event("CALL_ACCEPT", self.member)
        with self.assertRaises(HTTPException) as failure:
            await self.open(self.member)
        self.assertEqual(failure.exception.status_code, 403)
        await self.open()
        for user, client_id in [(self.other, "other-tab"), (self.owner, "old-tab"), (member("owner", "another-team"), "owner-tab")]:
            with self.assertRaises(HTTPException):
                await studio.get_studio(self.call_id, client_id, user)
        await self.op("add", user=self.member, label="Ideia da participante")
        result = await studio.get_studio(self.call_id, "owner-tab", self.owner)
        self.assertEqual(result["session"]["board"]["nodes"][0]["data"]["label"], "Ideia da participante")
        self.assertNotIn("operations", result["session"])
        recipients = team.manager.send_to_users.call_args.args[1]
        self.assertEqual(recipients, {"owner", "member"})

    async def test_late_join_reads_existing_board_and_reopen_preserves_content(self):
        opened = await self.open(template="anotacoes-reuniao", title="Pauta real")
        await self.op("add", label="Decisão tomada")
        await self.event("CALL_ACCEPT", self.member)
        result = (await studio.get_studio(self.call_id, "member-tab", self.member))["session"]
        self.assertEqual(result["id"], opened["id"])
        self.assertGreater(len(result["board"]["nodes"]), 4)
        await self.open(active=False)
        with self.assertRaises(HTTPException) as failure:
            await self.op("vote", user=self.member)
        self.assertEqual(failure.exception.status_code, 409)
        reopened = await self.open()
        self.assertEqual(reopened["board"], result["board"])
        self.assertEqual(studio.read_studio("owner", self.call_id)["id"], opened["id"])

    async def test_concurrent_independent_edits_merge_and_same_card_conflicts(self):
        await self.open()
        await self.event("CALL_ACCEPT", self.member)
        await self.op("add", "first")
        await self.op("add", "second")
        await asyncio.gather(self.op("edit", "first", version=1, label="A"),
                             self.op("edit", "second", user=self.member, version=1, label="B"))
        state = studio.read_studio("owner", self.call_id)
        self.assertEqual([node["data"]["label"] for node in state["board"]["nodes"]], ["A", "B"])
        with self.assertRaises(HTTPException) as failure:
            await self.op("edit", "first", user=self.member, version=1, label="Stale draft")
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(studio.read_studio("owner", self.call_id)["board"]["nodes"][0]["data"]["label"], "A")

    async def test_vote_comment_and_move_do_not_overwrite_card_edits_and_retries_deduplicate(self):
        await self.open()
        await self.event("CALL_ACCEPT", self.member)
        await self.op("add")
        await asyncio.gather(self.op("vote", user=self.member, operationId="vote-retry"),
                             self.op("edit", version=1, label="Revisado"),
                             self.op("comment", user=self.member, text="Comentário", operationId="comment-retry"))
        await self.op("vote", user=self.member, operationId="vote-retry")
        await self.op("comment", user=self.member, text="Comentário", operationId="comment-retry")
        result = await self.op("move", x=100, y=200)
        node = result["board"]["nodes"][0]
        self.assertEqual(node["data"]["label"], "Revisado")
        self.assertEqual(node["data"]["votes"], ["member"])
        self.assertEqual(len(node["data"]["comments"]), 1)
        self.assertEqual(node["data"]["comments"][0]["authorId"], "member")
        self.assertEqual(node["position"], {"x": 100, "y": 200})

    async def test_connections_are_validated_and_removed_with_deleted_card(self):
        await self.open()
        await self.op("add")
        with self.assertRaises(HTTPException):
            await self.op("connect", target="missing")
        await self.op("add", "target")
        result = await self.op("connect", target="target")
        self.assertEqual(len(result["board"]["edges"]), 1)
        result = await self.op("delete", version=1)
        self.assertEqual(result["board"]["edges"], [])

    async def test_reused_call_id_cannot_inherit_an_older_private_board(self):
        await self.open()
        await self.op("add", label="Conteúdo privado da chamada anterior")
        call = team.read_chat_store("owner")["activeCalls"][0]
        self.assertIsNotNone(studio.read_current_studio("owner", call))
        self.assertIsNone(studio.read_current_studio("owner", {**call, "startedAt": "2099-01-01T00:00:00+00:00"}))

    async def test_leaving_ended_calls_secondary_workspaces_and_revocation_block_operations(self):
        await self.open()
        await self.event("CALL_ACCEPT", self.member)
        await self.event("CALL_LEAVE", self.member)
        with self.assertRaises(HTTPException):
            await self.op("add", user=self.member)
        with patch.object(team, "current_workspace_id", return_value="secondary"):
            with self.assertRaises(HTTPException):
                await studio.get_studio(self.call_id, "owner-tab", self.owner)
        with self.assertRaises(HTTPException):
            await studio.get_studio(self.call_id, "owner-tab", {**self.owner, "permissions": {}})
        await self.event("CALL_END", self.owner)
        with self.assertRaises(HTTPException):
            await self.op("add")

    def test_operation_rejects_unbounded_and_nonfinite_values(self):
        for extra in ({"x": float("nan")}, {"description": "x" * 8001}, {"color": "url(http://example.com)"}, {"authorId": "forged"}):
            with self.assertRaises(ValidationError):
                studio.StudioOperation(clientId="c", operationId="o", kind="add", itemId="i", **extra)
