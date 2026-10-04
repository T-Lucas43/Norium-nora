from __future__ import annotations

import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_gate():
    source = Path(__file__).resolve().parents[3] / "infra/azure/test_postgres_persistence.py"
    spec = importlib.util.spec_from_file_location("postgres_ci_guard", source)
    module = importlib.util.module_from_spec(spec)
    # Loading the guard must not import migration/application code or read .env.
    migration = types.ModuleType("migrate_to_postgres")
    migration._initialize_schemas = lambda _url: None
    migration.migrate = lambda *_args: None
    with patch.dict(sys.modules, {"migrate_to_postgres": migration}):
        spec.loader.exec_module(module)
    return module


class PostgresCIGuardTests(unittest.TestCase):
    def test_only_local_test_database_is_allowed(self):
        gate = load_gate()
        for host in ("127.0.0.1", "localhost", "[::1]"):
            url = f"postgresql://test:test@{host}:5432/test"
            with self.subTest(host=host), patch.dict(os.environ, {"ENVIRONMENT": "test", "NORA_BRAIN_DATABASE_URL": url}):
                gate.require_local_test_database(url)

    def test_remote_production_and_mismatched_databases_are_rejected(self):
        gate = load_gate()
        local = "postgresql://test:test@127.0.0.1:5432/test"
        for url, mode, brain_url in (
            (local, "production", local),
            ("postgresql://test:test@postgres.example.com/test", "test", local),
            (local, "test", "postgresql://test:test@other.example.com/test"),
            ("https://127.0.0.1/test", "test", local),
        ):
            with self.subTest(mode=mode, url=url), patch.dict(os.environ, {"ENVIRONMENT": mode, "NORA_BRAIN_DATABASE_URL": brain_url}):
                with self.assertRaises(RuntimeError):
                    gate.require_local_test_database(url)


if __name__ == "__main__":
    unittest.main()
