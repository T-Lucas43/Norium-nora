from __future__ import annotations

import os
import shutil
import tempfile
import unittest


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_system_logs_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.services.system_logs import list_system_logs, record_system_log  # noqa: E402


class SystemLogsTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    def test_persists_sanitized_request_metadata_and_filters(self) -> None:
        record_system_log(
            "http_request",
            level="warning",
            message="POST /api/documentos · HTTP 409",
            user_id="user-a",
            workspace_id="primary",
            metadata={"method": "POST", "path": "/api/documentos", "statusCode": 409, "durationMs": 12.4},
        )
        record_system_log("http_request", message="GET /health · HTTP 200", user_id="anonymous")

        warnings = list_system_logs(level="warning", search="documentos")
        self.assertEqual(1, len(warnings))
        self.assertEqual("user-a", warnings[0]["userId"])
        self.assertEqual(409, warnings[0]["metadata"]["statusCode"])
        self.assertNotIn("authorization", str(warnings[0]).casefold())


if __name__ == "__main__":
    unittest.main()
