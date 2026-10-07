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
            self.assertIs(True, result["ready"])
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
        self.assertIs(False, error.exception.detail["ready"])

    def test_postgres_readiness_includes_boolean_contract(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.modules.system.router import router
        app = FastAPI()
        app.include_router(router)
        with patch("app.infrastructure.persistence.postgres_store.configured", return_value=True), patch("app.infrastructure.persistence.postgres_store.ping", return_value={"status": "ready", "driver": "postgresql", "schema": 1}), patch("app.infrastructure.auth_sessions.readiness") as sessions_ready, patch.dict(os.environ, {"NORA_BRAIN_ENABLED": "0"}):
            response = TestClient(app).get("/health/ready")
        sessions_ready.assert_called_once()
        self.assertEqual(200, response.status_code)
        self.assertIs(True, response.json()["ready"])
        self.assertEqual("postgresql", response.json()["checks"]["persistence"]["driver"])

    def test_postgres_readiness_rejects_unavailable_session_registry(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.modules.system.router import router
        from app.infrastructure.persistence.postgres_store import PostgresStoreError
        app = FastAPI()
        app.include_router(router)
        with patch("app.infrastructure.persistence.postgres_store.configured", return_value=True), patch("app.infrastructure.persistence.postgres_store.ping", return_value={"status": "ready", "driver": "postgresql", "schema": 1}), patch("app.infrastructure.auth_sessions.readiness", side_effect=PostgresStoreError("synthetic-session-unavailable")), patch.dict(os.environ, {"NORA_BRAIN_ENABLED": "0"}):
            response = TestClient(app).get("/health/ready")
        self.assertEqual(503, response.status_code)
        self.assertIs(False, response.json()["detail"]["ready"])


if __name__ == "__main__":
    unittest.main()
