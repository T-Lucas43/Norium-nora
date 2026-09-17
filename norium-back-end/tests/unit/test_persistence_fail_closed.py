from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.tenant import get_user_db_path
from app.infrastructure.persistence import json_repository as repository
from app.services import finance_store


class PersistenceFailClosedTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name})
        env.start()
        self.addCleanup(env.stop)
        self.path = Path(get_user_db_path("synthetic-a", "financeiro"))

    def test_invalid_json_unicode_empty_and_schema_preserve_original_bytes(self):
        for content in (b'{"private": BAD}', b'\xff\xfe', b'', b'[]', b'null', b'{"lancamentos":{}}'):
            with self.subTest(content=content):
                self.path.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    finance_store.list_finance("synthetic-a")
                self.assertEqual(content, self.path.read_bytes())

    def test_io_and_permission_failures_do_not_become_empty_store(self):
        self.path.write_text('{"lancamentos":[]}', encoding="utf-8")
        original = self.path.read_bytes()
        for exception in (OSError("synthetic private I/O detail"), PermissionError("synthetic secret")):
            with self.subTest(exception=type(exception).__name__):
                with patch.object(Path, "read_text", side_effect=exception):
                    with self.assertRaises(RuntimeError):
                        finance_store.list_finance("synthetic-a")
                self.assertEqual(original, self.path.read_bytes())

    def test_missing_file_and_valid_empty_document_are_distinct(self):
        self.assertEqual({"files": []}, repository.read_json(self.path, {"files": []}))
        self.assertFalse(self.path.exists())
        self.path.write_text("{}", encoding="utf-8")
        self.assertEqual({}, repository.read_json(self.path, {}))
        self.assertEqual(b"{}", self.path.read_bytes())

    def test_deletion_during_read_is_not_an_initial_missing_file(self):
        self.path.write_text("{}", encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=FileNotFoundError()):
            with self.assertRaises(RuntimeError):
                repository.read_json(self.path, {})

    def test_restore_healthy_copy_recovers_financial_read(self):
        finance_store.create_lancamento("synthetic-a", {"title": "Synthetic retained", "amount": 42})
        healthy = self.path.read_bytes()
        self.path.write_bytes(b"{broken")
        with self.assertRaises(RuntimeError):
            finance_store.list_finance("synthetic-a")
        self.path.write_bytes(healthy)
        result = finance_store.list_finance("synthetic-a")
        self.assertEqual("Synthetic retained", result["lancamentos"][0]["title"])

    def test_alert_is_safe_and_http_error_is_controlled(self):
        from app.bootstrap import create_app
        app = create_app()

        @app.get("/audit-storage-probe")
        def probe():
            return finance_store.list_finance("synthetic-a")

        original = b'{"secret":"synthetic-must-not-be-logged",BROKEN'
        self.path.write_bytes(original)
        with self.assertLogs(repository.logger, level="ERROR") as logs:
            response = TestClient(app, raise_server_exceptions=False).get("/audit-storage-probe")
        self.assertEqual(503, response.status_code)
        self.assertEqual("storage_unavailable", response.json()["code"])
        self.assertNotIn("synthetic-must-not-be-logged", " ".join(logs.output) + response.text)
        self.assertNotIn(str(self.path), " ".join(logs.output) + response.text)
        self.assertEqual(original, self.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
