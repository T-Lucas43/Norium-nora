import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.services import nora_files
from app.modules.intelligence import browser_runtime


class NoraUploadQuotaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(
            os.environ,
            {
                "NORIUM_DATA_DIR": self.directory.name,
                "ENVIRONMENT": "test",
                "NORA_FILES_WORKSPACE_QUOTA_BYTES": "1024",
                "NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": "4096",
            },
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_retention_removes_evicted_physical_file(self):
        with patch.object(nora_files, "MAX_FILES", 2):
            created = [
                nora_files.save_bytes("user-a", value, f"{index}.txt", "text/plain", source="test")
                for index, value in enumerate((b"one", b"two", b"three"), start=1)
            ]
        root = nora_files._workspace_root("user-a")
        self.assertEqual(2, len(list(root.glob("nora_file_*"))))
        with self.assertRaises(HTTPException) as error:
            nora_files.owned_file("user-a", created[0]["id"])
        self.assertEqual(404, error.exception.status_code)

    def test_workspace_quota_rejects_without_orphan(self):
        with patch.dict(os.environ, {"NORA_FILES_WORKSPACE_QUOTA_BYTES": "5"}):
            nora_files.save_bytes("user-a", b"1234", "first.txt", "text/plain", source="test")
            with self.assertRaises(HTTPException) as error:
                nora_files.save_bytes("user-a", b"5678", "second.txt", "text/plain", source="test")
        self.assertEqual(413, error.exception.status_code)
        self.assertEqual(1, len(list(nora_files._workspace_root("user-a").glob("nora_file_*"))))

    def test_metadata_failure_removes_new_file(self):
        with patch.object(nora_files, "write_user_db", side_effect=OSError("synthetic persistence failure")):
            with self.assertRaises(OSError):
                nora_files.save_bytes("user-a", b"content", "failed.txt", "text/plain", source="test")
        self.assertEqual([], list(nora_files._workspace_root("user-a").glob("nora_file_*")))


class BrowserUploadQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(
            os.environ,
            {
                "NORIUM_DATA_DIR": self.directory.name,
                "ENVIRONMENT": "test",
                "BROWSER_RUN_STORAGE_QUOTA_BYTES": "5",
                "NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": "4096",
            },
        )
        self.environment.start()
        self.run = {"id": "run-a", "status": "paused", "artifacts": []}

    async def asyncTearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    async def test_browser_upload_quota_and_persistence_cleanup(self):
        payload = "data:text/plain;base64," + base64.b64encode(b"1234").decode("ascii")
        with patch.object(browser_runtime, "_fresh_run", return_value=self.run), patch.object(
            browser_runtime, "mutate_store", new=AsyncMock(side_effect=OSError("synthetic failure"))
        ):
            with self.assertRaises(OSError):
                await browser_runtime.store_uploaded_artifact("user-a", "run-a", "one.txt", "text/plain", payload)
        run_dir = Path(self.directory.name) / "user_user-a" / "browser_runs" / "run-a"
        self.assertEqual([], list(run_dir.glob("artifact_*")))

        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "existing.bin").write_bytes(b"1234")
        with patch.object(browser_runtime, "_fresh_run", return_value=self.run):
            with self.assertRaises(HTTPException) as error:
                await browser_runtime.store_uploaded_artifact("user-a", "run-a", "two.txt", "text/plain", payload)
        self.assertEqual(413, error.exception.status_code)
        self.assertEqual(["existing.bin"], [item.name for item in run_dir.iterdir()])


if __name__ == "__main__":
    unittest.main()
