"""AUD-01: existing valid JSON with incompatible domain schema must not be repaired by reads."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.core.tenant import get_user_db_path
from app.infrastructure.persistence.json_repository import PersistenceError
from app.modules.commercial import repository as commercial
from app.services import task_store


class StoreSchemaAuditTests(unittest.TestCase):
    def setUp(self):
        if not os.getenv("NORIUM_DATA_DIR") or os.getenv("PYTHON_DOTENV_DISABLED") != "1":
            raise RuntimeError("Execute somente pelo runner descartavel da auditoria.")
        temporary = tempfile.TemporaryDirectory(prefix="audit-store-schema-")
        self.addCleanup(temporary.cleanup)
        legacy = patch.object(task_store, "TASKS_PATH", Path(temporary.name) / "legacy.json")
        legacy.start()
        self.addCleanup(legacy.stop)
        self.task_path = Path(get_user_db_path("synthetic-task-owner", "tarefas"))
        self.commercial_path = Path(get_user_db_path("synthetic-commercial-owner", "comercial"))

    def test_task_collections_and_nested_objects_fail_closed_without_writing(self):
        for payload in ({"tasks": {"mustKeep": True}, "projects": []},
                        {"tasks": [None], "projects": []},
                        {"tasks": [], "projects": [None]},
                        {"tasks": [], "projects": [{"id": "x", "sharedUserIds": {"mustKeep": True}}]},
                        {"tasks": [], "projects": [], "columns": {}},
                        {"tasks": [], "projects": [], "labels": [None]}):
            with self.subTest(payload=payload):
                original = json.dumps(payload).encode("utf-8")
                self.task_path.write_bytes(original)
                with self.assertRaises(PersistenceError):
                    task_store.list_tasks("synthetic-task-owner")
                with self.assertRaises(PersistenceError):
                    task_store.create_task("synthetic-task-owner", {"title": "Never created"})
                self.assertEqual(original, self.task_path.read_bytes())

    def test_commercial_invalid_collection_item_preserves_document_and_other_fields(self):
        original = b'{"proposals":[{"id":"keep"},null],"contracts":[],"customLegacy":{"mustKeep":true}}'
        self.commercial_path.write_bytes(original)
        with self.assertRaises(PersistenceError):
            commercial.read_store("synthetic-commercial-owner")
        self.assertEqual(original, self.commercial_path.read_bytes())

    def test_valid_empty_and_legacy_collections_remain_readable(self):
        self.task_path.write_text('{"tasks":[],"projects":[],"columns":[],"labels":[]}', encoding="utf-8")
        self.assertEqual([], task_store.list_tasks("synthetic-task-owner")["tasks"])
        self.commercial_path.write_text('{"proposals":[],"customLegacy":{"mustKeep":true}}', encoding="utf-8")
        store = commercial.read_store("synthetic-commercial-owner")
        self.assertEqual([], store["proposals"])
        self.assertEqual({"mustKeep": True}, store["customLegacy"])


if __name__ == "__main__":
    unittest.main()
