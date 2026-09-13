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
from app.services import brainstorm_store as library


def member(user_id, owner="owner"):
    return {"id": user_id, "nome": user_id.title(), "teamOwnerId": owner,
            "status": "ativo", "permissions": {"chat": True}}


class CallStudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.owner, self.member, self.other = member("owner"), member("member"), member("other")
        self.socket = MagicMock(send_json=AsyncMock())
        self.patches = [
            patch.object(library, "brainstorm_lock", asyncio.Lock()),
            patch.object(library, "read_user_db", side_effect=lambda tenant, _db, default: studio.read_json_file(Path(self.temp.name) / f"library-{tenant}.json", default)),
            patch.object(library, "write_user_db", side_effect=lambda tenant, _db, data: studio.write_json_file(Path(self.temp.name) / f"library-{tenant}.json", data)),
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

    async def test_save_imports_complete_editable_board_without_duplicate_or_overwrite(self):
        await self.open()
        await self.op("add", label="Decisão")
        await self.op("comment", text="Comentário preservado")
        await self.op("vote")
        result = await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=True), self.owner)
        self.assertFalse(result["session"]["active"])
        saved_id = result["session"]["savedStudioId"]
        saved = await library.get_brainstorm_session("owner", saved_id)
        self.assertEqual(saved["board"], result["session"]["board"])
        self.assertEqual(saved["responsibleId"], "owner")
        self.assertEqual(saved["status"], "ativo")
        self.assertFalse(saved["timer"]["running"])
        saved["board"]["nodes"][0]["data"]["label"] = "Edição posterior na biblioteca"
        await library.save_brainstorm_board("owner", saved_id, saved["board"], self.owner)
        await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=True), self.owner)
        self.assertEqual(len(await library.list_brainstorm_sessions("owner")), 1)
        self.assertEqual((await library.get_brainstorm_session("owner", saved_id))["board"]["nodes"][0]["data"]["label"], "Edição posterior na biblioteca")
        self.assertIsNone(await library.get_brainstorm_session("other-team", saved_id))

    async def test_only_host_decides_and_declining_does_not_create_a_library_session(self):
        await self.open()
        await self.event("CALL_ACCEPT", self.member)
        with self.assertRaises(HTTPException) as denied:
            await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="member-tab", save=True), self.member)
        self.assertEqual(denied.exception.status_code, 403)
        await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=False), self.owner)
        self.assertEqual(await library.list_brainstorm_sessions("owner"), [])
        self.assertEqual(studio.read_studio("owner", self.call_id)["saveDecision"], "not_saved")
        reopened = await self.open()
        self.assertNotIn("saveDecision", reopened)

    async def test_failed_save_preserves_active_call_and_board(self):
        await self.open()
        await self.op("add")
        with patch.object(library, "_write_store", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=True), self.owner)
        self.assertTrue(studio.read_studio("owner", self.call_id)["active"])
        self.assertEqual(len(team.read_chat_store("owner")["activeCalls"]), 1)

    async def test_nora_uses_requester_budget_and_shares_response_as_saved_card(self):
        await self.open()
        await self.op("add", label="Planejar lançamento", description="Prazo a definir")
        self.member["permissions"]["nora"] = True
        await self.event("CALL_ACCEPT", self.member)
        payload = studio.StudioNora(clientId="member-tab", requestId="request-1", action="resumir")
        provider = AsyncMock(return_value="Definir responsáveis e aprovar o cronograma.")
        with patch.object(studio.nora_service, "perguntar_nora", provider):
            result = await studio.ask_nora(self.call_id, payload, self.member)
            await studio.ask_nora(self.call_id, payload, self.member)
        provider.assert_awaited_once()
        self.assertEqual(provider.call_args.kwargs["user_id"], "member")
        self.assertIn("Planejar lançamento", provider.call_args.args[0][0]["content"])
        self.assertIn("Prazo a definir", provider.call_args.args[0][0]["content"])
        self.assertEqual(len(result["session"]["board"]["nodes"]), 2)
        self.assertEqual(result["session"]["noraMessages"][0]["authorName"], "Member")
        saved = await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=True), self.owner)
        archived = await library.get_brainstorm_session("owner", saved["session"]["savedStudioId"])
        self.assertIn("Definir responsáveis", archived["board"]["nodes"][1]["data"]["description"])

    async def test_nora_permission_quota_and_provider_failures_preserve_board(self):
        await self.open()
        payload = studio.StudioNora(clientId="owner-tab", requestId="request-1", action="gerar_ideias")
        with patch.object(studio.nora_service, "perguntar_nora", AsyncMock()) as provider:
            with self.assertRaises(HTTPException) as denied:
                await studio.ask_nora(self.call_id, payload, self.owner)
            self.assertEqual(denied.exception.status_code, 403)
            provider.assert_not_awaited()
        self.owner["permissions"]["nora"] = True
        for error, status in ((HTTPException(402, "Saldo insuficiente"), 402), (studio.NoraResearchUnavailable("provider"), 503)):
            with patch.object(studio.nora_service, "perguntar_nora", AsyncMock(side_effect=error)):
                with self.assertRaises(HTTPException) as failed:
                    await studio.ask_nora(self.call_id, payload, self.owner)
            self.assertEqual(failed.exception.status_code, status)
            self.assertEqual(studio.read_studio("owner", self.call_id)["board"]["nodes"], [])
            self.assertNotIn(("owner", self.call_id), studio._nora_pending)

    async def test_nora_pending_blocks_finish_but_does_not_block_participant_edits(self):
        await self.open()
        self.owner["permissions"]["nora"] = True
        entered, release = asyncio.Event(), asyncio.Event()
        async def provider(*args, **kwargs):
            entered.set()
            await release.wait()
            return "Contribuição da Nora"
        with patch.object(studio.nora_service, "perguntar_nora", side_effect=provider):
            task = asyncio.create_task(studio.ask_nora(self.call_id, studio.StudioNora(clientId="owner-tab", requestId="request-1", action="resumir"), self.owner))
            await entered.wait()
            try:
                with self.assertRaises(HTTPException) as failed:
                    await studio.finish_studio(self.call_id, studio.StudioFinish(clientId="owner-tab", save=True), self.owner)
                self.assertEqual(failed.exception.status_code, 409)
                await self.op("add", label="Edição durante a resposta")
            finally:
                release.set()
            result = await task
        self.assertEqual(len(result["session"]["board"]["nodes"]), 2)

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
