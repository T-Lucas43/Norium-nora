from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch

from app.infrastructure.persistence import postgres_store
from app.infrastructure.persistence.postgres_tls import production_tls_mode_allowed
from app.modules.nora.brain.contracts import BrainError
from app.modules.nora.brain.repository import Repository


class PostgresTlsPolicyTests(unittest.TestCase):
    def tearDown(self):
        postgres_store._pool = None

    def test_unverified_modes_are_rejected_even_with_legacy_opt_in(self):
        for flag in ("", "1", "true", "yes"):
            with self.subTest(flag=flag), patch.dict(os.environ, {"NORIUM_DATABASE_ALLOW_UNVERIFIED_TLS": flag}, clear=True):
                for mode in ("require", "prefer", "disable", "allow"):
                    self.assertFalse(production_tls_mode_allowed(mode))

    def test_verified_modes_remain_allowed(self):
        self.assertTrue(production_tls_mode_allowed("verify-ca"))
        self.assertTrue(production_tls_mode_allowed("verify-full"))

    def test_explicit_local_context_remains_supported(self):
        self.assertTrue(production_tls_mode_allowed("prefer", local=True))

    def test_operational_store_rejects_require_even_with_legacy_opt_in(self):
        environment = {
            "NORIUM_DATABASE_URL": "postgresql://example.invalid/norium",
            "NORIUM_POSTGRES_REQUIRED": "1",
            "NORIUM_DATABASE_SSLMODE": "require",
            "NORIUM_DATABASE_ALLOW_UNVERIFIED_TLS": "1",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(postgres_store.PostgresStoreError, "postgresql_tls_verification_required"):
                postgres_store._pool_instance()

    def test_brain_store_rejects_require_even_with_legacy_opt_in(self):
        environment = {
            "ENVIRONMENT": "production", "NORA_BRAIN_DB_SSLMODE": "require",
            "NORIUM_DATABASE_ALLOW_UNVERIFIED_TLS": "true",
        }
        fake_rows = types.SimpleNamespace(dict_row=object())
        fake_psycopg = types.SimpleNamespace(rows=fake_rows)
        with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules, {"psycopg": fake_psycopg, "psycopg.rows": fake_rows}):
            with self.assertRaisesRegex(BrainError, "postgresql_tls_verification_required"):
                with Repository("postgresql://example.invalid/norium").transaction():
                    pass


if __name__ == "__main__":
    unittest.main()
