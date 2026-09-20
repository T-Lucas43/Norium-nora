"""Tarefa 2: notificacoes sem repeticao — identidade estavel por canal.

Mesma ocorrencia logica (mesmo messageId/evento/aprovacao) gravada duas
vezes nao duplica nem retransmite; ocorrencia nova ou atualizacao material
com identidade propria continua aparecendo. Isolamento por usuario.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.modules.inbox import router as inbox_router
from app.modules.team.router import record_team_event, team_inbox_event_id


def isolated_db(root: Path):
    def isolated_path(user_id: str) -> Path:
        path = root / user_id / "events.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    return isolated_path


class TeamStableIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_message_id_twice_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_db(Path(temp_dir))),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                metadata = {
                    "action": "team_message_created",
                    "messageId": "team_msg_1",
                    "senderId": "user2",
                }
                self.assertEqual("team_time-1_team_msg_1", team_inbox_event_id("time-1", metadata))
                await record_team_event("time-1", "Mensagem no chat interno", "Bia: Oi.", dict(metadata))
                await record_team_event("time-1", "Mensagem no chat interno", "Bia: Oi.", dict(metadata))

                stored = await inbox_router.read_events("time-1")

            self.assertEqual(1, len(stored))
            self.assertEqual("team_time-1_team_msg_1", stored[0]["id"])
            broadcast.assert_awaited_once()

    async def test_new_message_id_is_new_occurrence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_db(Path(temp_dir))),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                await record_team_event(
                    "time-1", "Mensagem no chat interno", "Bia: Oi.",
                    {"action": "team_message_created", "messageId": "team_msg_1", "senderId": "user2"},
                )
                await record_team_event(
                    "time-1", "Mensagem no chat interno", "Cid: Olá.",
                    {"action": "team_message_created", "messageId": "team_msg_2", "senderId": "user3"},
                )

                stored = await inbox_router.read_events("time-1")

            self.assertEqual(2, len(stored))
            self.assertEqual(2, broadcast.await_count)

    async def test_team_event_without_message_id_keeps_previous_behavior(self) -> None:
        self.assertIsNone(team_inbox_event_id("time-1", {"action": "other"}))
        self.assertIsNone(team_inbox_event_id("time-1", None))


class ApprovalStableIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_approval_request_twice_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_db(Path(temp_dir))),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                for _ in range(2):
                    await inbox_router.record_event(
                        source="sistema",
                        title="Nova aprovacao pendente",
                        description="Compra de insumo",
                        metadata={"userId": "ana", "action": "approval_requested", "approvalId": "ap1"},
                        event_id="sistema_ana_approval_ap1_requested",
                    )

                stored = await inbox_router.read_events("ana")

            self.assertEqual(1, len(stored))
            broadcast.assert_awaited_once()

    async def test_approval_decision_has_own_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_db(Path(temp_dir))),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                await inbox_router.record_event(
                    source="sistema",
                    title="Nova aprovacao pendente",
                    description="Compra de insumo",
                    metadata={"userId": "ana", "action": "approval_requested", "approvalId": "ap1"},
                    event_id="sistema_ana_approval_ap1_requested",
                )
                await inbox_router.record_event(
                    source="sistema",
                    title="Aprovacao concluida",
                    description="Compra de insumo: approved.",
                    metadata={"userId": "ana", "action": "approval_decided", "approvalId": "ap1"},
                    event_id="sistema_ana_approval_ap1_decided",
                )

                stored = await inbox_router.read_events("ana")

            self.assertEqual(2, len(stored))
            self.assertEqual(2, broadcast.await_count)


if __name__ == "__main__":
    unittest.main()
