"""AUD-05: retrying a partial automation never repeats a completed effect."""
from __future__ import annotations

import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.automations import router
from app.core.tenant import get_system_db_path, write_json_file
from app.modules.auth import router as auth
from app.services import task_store


class AuditAutomationCheckpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": directory.name,
                                              "NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.actor = {"id": "owner", "status": "ativo", "role": "owner", "plan": "equipe"}
        user_path = Path(get_system_db_path("usuarios"))
        user_path_patch = patch.object(auth, "USERS_DB_PATH", user_path)
        user_path_patch.start()
        self.addCleanup(user_path_patch.stop)
        write_json_file(user_path, {"users": [self.actor]})
        task_store.create_project("owner", {"id": "private", "name": "Synthetic private"})

    async def test_failure_after_send_requires_reconciliation_and_does_not_resend(self):
        automation = {
            "id": "automation-a", "name": "Synthetic", "active": True,
            "version": 1, "variables": {}, "logs": [], "executions": 0,
            "savedMinutes": 0, "savedMinutesPerRun": 8,
            "flow": {"nodes": [
                {
                    "id": "send", "kind": "action", "title": "Enviar WhatsApp",
                    "config": {
                        "actionType": "send_whatsapp", "message": "Synthetic message",
                        "recipientMode": "number", "recipient": "+55 11 99999-9999",
                    },
                },
                {"id": "task", "kind": "action", "title": "Criar tarefa", "config": {}},
            ]},
        }
        persisted = {"automations": [automation], "history": []}

        def read_store(_user_id):
            return copy.deepcopy(persisted)

        def write_store(_user_id, value):
            persisted.clear()
            persisted.update(copy.deepcopy(value))

        actor = self.actor

        def create_with_first_failure(*args, **kwargs):
            if create.call_count == 1:
                raise RuntimeError("synthetic failure")
            return task_store.create_task(*args, **kwargs)
        with (
            patch.object(router, "read_store", side_effect=read_store),
            patch.object(router, "write_store", side_effect=write_store),
            patch("app.routers.auth_router.read_user_store", AsyncMock(return_value={"users": [actor]})),
            patch("app.modules.chat.router.assert_channel_permission"),
            patch("app.modules.chat.router.enviar_mensagem", AsyncMock()) as send,
            patch.object(
                router, "create_task",
                side_effect=create_with_first_failure,
            ) as create,
            patch.object(router, "append_team_message_for_user", AsyncMock()),
            patch.object(router, "record_event", AsyncMock()),
        ):
            first = await router.execute_automation("owner", "automation-a")
            self.assertEqual("erro", first["historyItem"]["status"])
            self.assertEqual("succeeded", first["historyItem"]["effectCheckpoints"]["message:send"]["status"])
            self.assertEqual("uncertain", first["historyItem"]["effectCheckpoints"]["task:create"]["status"])
            self.assertEqual(1, send.await_count)

            with self.assertRaises(HTTPException) as blocked:
                await router.reexecutar_automacao(
                    "automation-a", first["historyItem"]["id"], actor
                )
            self.assertEqual(409, blocked.exception.status_code)

            await router.reconcile_automation_effect(
                "automation-a", first["historyItem"]["id"], "task:create",
                router.EffectReconciliationPayload(
                    outcome="no_effect", note="Fake confirmou que a tarefa nao foi persistida."
                ),
                actor,
            )
            second = await router.reexecutar_automacao(
                "automation-a", first["historyItem"]["id"], actor
            )
            self.assertEqual("sucesso", second["lastExecution"]["historyItem"]["status"])
            self.assertEqual(1, send.await_count)
            self.assertEqual(2, create.call_count)


if __name__ == "__main__":
    unittest.main()
