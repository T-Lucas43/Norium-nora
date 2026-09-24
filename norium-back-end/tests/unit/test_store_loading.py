from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.core.request_context import reset_request_context, set_request_context
from app.core.tenant import get_user_db_path
from app.services import finance_store, task_store


class StoreLoadingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name})
        self.environment.start()
        self.legacy_finance = patch.object(finance_store, "FINANCE_PATH", Path(self.directory.name) / "legacy-finance.json")
        self.legacy_tasks = patch.object(task_store, "TASKS_PATH", Path(self.directory.name) / "legacy-tasks.json")
        self.legacy_finance.start()
        self.legacy_tasks.start()
        self.context = set_request_context("store-test", "primary")

    def tearDown(self):
        reset_request_context(self.context)
        self.legacy_tasks.stop()
        self.legacy_finance.stop()
        self.environment.stop()
        self.directory.cleanup()

    def test_finance_never_enumerates_other_accounts(self):
        finance_store.create_lancamento("a", {"title": "A", "amount": 10})
        finance_store.create_lancamento("b", {"title": "B", "amount": 20})
        with patch.object(Path, "glob", side_effect=AssertionError("Cross-account scan")):
            result = finance_store.list_finance("a")
        self.assertEqual(["A"], [item["title"] for item in result["lancamentos"]])

    def test_finance_and_tasks_do_not_read_or_overwrite_primary_from_another_workspace(self):
        finance_store.create_lancamento("a", {"title": "Primary", "amount": 10})
        task_store.create_task("a", {"title": "Primary"})
        finance_path = Path(get_user_db_path("a", "financeiro"))
        tasks_path = Path(get_user_db_path("a", "tarefas"))
        original = (finance_path.read_bytes(), tasks_path.read_bytes())
        context = set_request_context("store-test", "other")
        try:
            self.assertEqual([], finance_store.list_finance("a")["lancamentos"])
            self.assertEqual([], task_store.list_tasks("a")["tasks"])
            finance_store.create_lancamento("a", {"title": "Other", "amount": 20})
            task_store.create_task("a", {"title": "Other"})
        finally:
            reset_request_context(context)
        self.assertEqual(original, (finance_path.read_bytes(), tasks_path.read_bytes()))

    def test_task_list_reads_the_store_once_and_mutation_writes_only_its_owner(self):
        task_store.create_task("a", {"title": "A"})
        task_store.create_task("b", {"title": "B"})
        with patch.object(task_store, "_read_db", wraps=task_store._read_db) as read:
            task_store.list_tasks("a")
            self.assertEqual(1, read.call_count)
        with patch.object(task_store, "write_json_file", wraps=task_store.write_json_file) as write:
            task_store.create_task("a", {"title": "New"})
            self.assertEqual([get_user_db_path("a", "tarefas")], [call.args[0] for call in write.call_args_list])

    def test_shared_tasks_keep_access_control_and_only_update_the_project_owner(self):
        project = task_store.create_project("owner", {"name": "Shared", "sharedUserIds": ["member"]})
        task = task_store.create_task("owner", {"title": "Shared task", "projectId": project["id"]})
        self.assertEqual([task["id"]], [item["id"] for item in task_store.list_tasks("member")["tasks"]])
        self.assertEqual([], task_store.list_tasks("stranger")["tasks"])
        with patch.object(task_store, "write_json_file", wraps=task_store.write_json_file) as write:
            task_store.update_task("member", task["id"], {"title": "Updated"})
            self.assertEqual([get_user_db_path("owner", "tarefas")], [call.args[0] for call in write.call_args_list])

    def test_postgres_task_loading_enumerates_documents_without_touching_legacy_files(self):
        owner_workspace = {
            "columns": [],
            "labels": [],
            "projects": [{
                "id": "shared",
                "name": "Shared",
                "ownerUserId": "owner",
                "sharedUserIds": ["member"],
            }],
            "tasks": [{"id": "task-1", "title": "Postgres task", "projectId": "shared"}],
        }
        member_workspace = {"columns": [], "labels": [], "projects": [], "tasks": []}

        def read_document(path, fallback):
            return owner_workspace if "user_owner" in str(path) else member_workspace

        with (
            patch.object(task_store.postgres_store, "configured", return_value=True),
            patch.object(task_store.postgres_store, "required", return_value=False),
            patch.object(
                task_store.postgres_store,
                "list_document_keys",
                return_value=[
                    "user_owner/tarefas_db.json",
                    "user_owner/perfil_db.json",
                    "user_member/tarefas_db.json",
                ],
            ),
            patch.object(task_store, "read_json_file", side_effect=read_document) as read_store,
        ):
            result = task_store.list_tasks("member")

        self.assertEqual(["task-1"], [item["id"] for item in result["tasks"]])
        self.assertEqual(2, read_store.call_count)
        read_store.assert_any_call(Path(self.directory.name) / "user_owner" / "tarefas_db.json", {})
        read_store.assert_any_call(Path(self.directory.name) / "user_member" / "tarefas_db.json", {})

    def test_postgres_missing_finance_store_does_not_fall_back_to_legacy_file(self):
        with (
            patch.object(finance_store.postgres_store, "configured", return_value=True),
            patch.object(finance_store.postgres_store, "required", return_value=False),
            patch.object(finance_store, "read_json_file", return_value=None) as read_store,
            patch.object(finance_store, "write_json_file") as write_store,
        ):
            result = finance_store.list_finance("owner")

        self.assertEqual([], result["lancamentos"])
        read_store.assert_called_once_with(Path(get_user_db_path("owner", "financeiro")), None)
        write_store.assert_called_once()
