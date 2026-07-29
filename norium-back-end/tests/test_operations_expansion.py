from __future__ import annotations

import os
import shutil
import tempfile
import unittest


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_operations_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client, list_clients  # noqa: E402
from app.modules.operations.router import _redact_sensitive  # noqa: E402
from app.modules.operations.schemas import (  # noqa: E402
    FollowUpCreate,
    OperationSettingsUpdate,
    OperationTemplateCreate,
    ReceiptCreate,
)
from app.modules.operations.service import (  # noqa: E402
    create_follow_up,
    create_template,
    get_operation_settings,
    global_search,
    record_receipt,
    undo_receipt,
    update_operation_settings,
)
from app.services.task_store import create_task, list_tasks  # noqa: E402


class OperationsExpansionTests(unittest.IsolatedAsyncioTestCase):
    user = {"id": "test-user", "nome": "Teste", "email": "teste@norium.local"}

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def test_created_task_can_be_undone_from_receipt(self) -> None:
        task = create_task(self.user["id"], {"title": "Tarefa reversivel", "projectId": "default"})
        receipt = await record_receipt(
            self.user,
            ReceiptCreate(
                action="task_created",
                title="Tarefa criada",
                entityType="task",
                entityId=task["id"],
                undoAction="delete_task",
                metadata={"current": task},
            ),
        )
        result = await undo_receipt(self.user, receipt["id"])
        self.assertIsNotNone(result)
        self.assertFalse(any(item["id"] == task["id"] for item in list_tasks(self.user["id"])["tasks"]))

    async def test_templates_followups_settings_and_clients_are_persistent(self) -> None:
        template = await create_template(
            self.user,
            OperationTemplateCreate(name="Resposta comercial", kind="email", content={"body": "Ola"}),
        )
        follow_up = await create_follow_up(
            self.user,
            FollowUpCreate(title="Cobrar retorno da proposta", channel="gmail"),
        )
        settings = await update_operation_settings(
            self.user,
            OperationSettingsUpdate(autonomy="confirm_all", followUpHours=72),
        )
        client = await create_client(
            ClientCreate(name="Cliente de teste", email="cliente@teste.local"),
            self.user,
        )
        listed = await list_clients(q="Cliente de teste", status=None, stage=None, user=self.user)

        self.assertTrue(template["id"].startswith("template_"))
        self.assertEqual(follow_up["status"], "open")
        self.assertEqual(settings["autonomy"], "confirm_all")
        self.assertEqual((await get_operation_settings(self.user))["followUpHours"], 72)
        self.assertEqual(listed["items"][0]["id"], client["item"]["id"])
        search = await global_search(self.user, "Cliente de teste")
        self.assertEqual(search["items"][0]["tab"], "Clientes")

    def test_backup_redacts_nested_credentials(self) -> None:
        payload = {
            "nome": "Teste",
            "google": {"access_token": "segredo", "refreshToken": "segredo-2"},
            "passwordHash": "segredo-3",
        }
        sanitized = _redact_sensitive(payload)
        self.assertEqual(sanitized["nome"], "Teste")
        self.assertEqual(sanitized["google"]["access_token"], "[REMOVIDO DO BACKUP]")
        self.assertEqual(sanitized["google"]["refreshToken"], "[REMOVIDO DO BACKUP]")
        self.assertEqual(sanitized["passwordHash"], "[REMOVIDO DO BACKUP]")


if __name__ == "__main__":
    unittest.main()
