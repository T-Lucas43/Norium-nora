import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.modules.system.router import readiness, router


class ReadinessTests(unittest.TestCase):
    def _client(self):
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_writable_persistence_is_ready_and_marker_is_removed(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                "NORIUM_DATA_DIR": directory,
                "NORIUM_DATABASE_URL": "",
                "NORIUM_POSTGRES_REQUIRED": "0",
                "ENVIRONMENT": "test",
                "NORA_BRAIN_ENABLED": "0",
            },
        ), patch(
            "app.infrastructure.persistence.postgres_store.configured", return_value=False
        ), patch(
            "app.infrastructure.persistence.postgres_store.required", return_value=False
        ):
            result = asyncio.run(readiness())
            self.assertEqual("ready", result["status"])
            self.assertIs(True, result["ready"])
            self.assertEqual(result["checks"]["persistence"], result["persistence"])
            self.assertEqual("ready", result["checks"]["persistence"]["status"])
            self.assertEqual([], list(Path(directory).glob(".readiness-*")))

    def test_postgresql_readiness_exposes_required_contract(self):
        database_check = {"status": "ready", "driver": "postgresql", "schema": 1}
        with patch("app.infrastructure.persistence.postgres_store.configured", return_value=True), patch(
            "app.infrastructure.persistence.postgres_store.ping", return_value=database_check
        ), patch.dict(os.environ, {"NORA_BRAIN_ENABLED": "0"}):
            response = self._client().get("/health/ready")

        self.assertEqual(200, response.status_code)
        result = response.json()
        self.assertIs(True, result["ready"])
        self.assertEqual("postgresql", result["persistence"]["driver"])
        self.assertEqual(database_check, result["checks"]["persistence"])

    def test_postgresql_failure_returns_service_unavailable(self):
        with patch("app.infrastructure.persistence.postgres_store.configured", return_value=True), patch(
            "app.infrastructure.persistence.postgres_store.ping", side_effect=OSError("synthetic outage")
        ), patch.dict(os.environ, {"NORA_BRAIN_ENABLED": "0"}):
            response = self._client().get("/health/ready")

        self.assertEqual(503, response.status_code)
        self.assertEqual("not_ready", response.json()["detail"]["status"])

    def test_required_postgresql_without_configuration_is_not_ready(self):
        with patch.dict(
            os.environ, {"NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "1", "NORA_BRAIN_ENABLED": "0"}
        ):
            response = self._client().get("/health/ready")

        self.assertEqual(503, response.status_code)
        self.assertEqual("not_ready", response.json()["detail"]["status"])

    def test_invalid_persistence_path_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = Path(directory) / "not-a-directory"
            invalid.write_text("synthetic", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "NORIUM_DATA_DIR": str(invalid),
                    "NORIUM_DATABASE_URL": "",
                    "NORIUM_POSTGRES_REQUIRED": "0",
                    "ENVIRONMENT": "test",
                    "NORA_BRAIN_ENABLED": "0",
                },
            ), patch(
                "app.infrastructure.persistence.postgres_store.configured", return_value=False
            ), patch(
                "app.infrastructure.persistence.postgres_store.required", return_value=False
            ):
                with self.assertRaises(HTTPException) as error:
                    asyncio.run(readiness())
        self.assertEqual(503, error.exception.status_code)
        self.assertEqual("not_ready", error.exception.detail["status"])


if __name__ == "__main__":
    unittest.main()
