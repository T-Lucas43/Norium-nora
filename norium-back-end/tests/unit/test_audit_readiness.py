import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.modules.system.router import readiness


class ReadinessTests(unittest.TestCase):
    def test_writable_persistence_is_ready_and_marker_is_removed(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"NORIUM_DATA_DIR": directory, "ENVIRONMENT": "test", "NORA_BRAIN_ENABLED": "0"},
        ):
            result = asyncio.run(readiness())
            self.assertEqual("ready", result["status"])
            self.assertEqual("ready", result["checks"]["persistence"]["status"])
            self.assertEqual([], list(Path(directory).glob(".readiness-*")))

    def test_invalid_persistence_path_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = Path(directory) / "not-a-directory"
            invalid.write_text("synthetic", encoding="utf-8")
            with patch.dict(
                os.environ,
                {"NORIUM_DATA_DIR": str(invalid), "ENVIRONMENT": "test", "NORA_BRAIN_ENABLED": "0"},
            ):
                with self.assertRaises(HTTPException) as error:
                    asyncio.run(readiness())
        self.assertEqual(503, error.exception.status_code)
        self.assertEqual("not_ready", error.exception.detail["status"])


if __name__ == "__main__":
    unittest.main()
