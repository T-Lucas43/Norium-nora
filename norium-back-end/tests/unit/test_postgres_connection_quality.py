from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

from psycopg import InterfaceError, OperationalError
from app.infrastructure.persistence import postgres_store


class PostgresConnectionQualityTests(unittest.TestCase):
    def test_pool_validates_checkout_with_the_official_health_callback(self):
        constructor = MagicMock()
        callback = MagicMock()
        constructor.check_connection = callback
        env = {
            "NORIUM_DATABASE_URL": "postgresql://example.invalid/norium",
            "NORIUM_POSTGRES_REQUIRED": "1",
            "NORIUM_DATABASE_SSLMODE": "verify-full",
            "NORIUM_DATABASE_SSLROOTCERT": "system",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(postgres_store, "_pool", None), patch("psycopg_pool.ConnectionPool", constructor):
            postgres_store._pool_instance()
        self.assertIs(constructor.call_args.kwargs["check"], callback)
        self.assertEqual(constructor.call_args.kwargs["timeout"], 5)
        self.assertEqual(constructor.call_args.kwargs["max_waiting"], 32)
        self.assertEqual(constructor.call_args.kwargs["kwargs"]["sslmode"], "verify-full")

    def context(self):
        pool, context, db = MagicMock(), MagicMock(), MagicMock()
        pool.connection.return_value = context
        context.__enter__.return_value = db
        context.__exit__.return_value = False
        return pool, context, db

    def test_operation_disconnect_fails_closed_without_replaying_body(self):
        pool, context, db = self.context()
        db.execute.side_effect = OperationalError("synthetic disconnected socket")
        with patch.object(postgres_store, "_pool_instance", return_value=pool):
            with self.assertRaisesRegex(postgres_store.PostgresStoreError, "postgresql_operation_unavailable"):
                with postgres_store.connection() as connection:
                    connection.execute("synthetic write")
        db.execute.assert_called_once_with("synthetic write")
        self.assertEqual(context.__exit__.call_count, 1)

    def test_commit_disconnect_reports_unknown_outcome_without_replay(self):
        pool, context, db = self.context()
        context.__exit__.side_effect = InterfaceError("synthetic lost commit response")
        with patch.object(postgres_store, "_pool_instance", return_value=pool):
            with self.assertRaisesRegex(postgres_store.PostgresStoreError, "postgresql_transaction_outcome_unknown"):
                with postgres_store.connection() as connection:
                    connection.execute("synthetic write")
        db.execute.assert_called_once_with("synthetic write")

    def test_rollback_disconnect_reports_unknown_outcome_without_replay(self):
        pool, context, db = self.context()
        context.__exit__.side_effect = OperationalError("synthetic lost rollback response")
        with patch.object(postgres_store, "_pool_instance", return_value=pool):
            with self.assertRaisesRegex(postgres_store.PostgresStoreError, "postgresql_transaction_outcome_unknown"):
                with postgres_store.connection() as connection:
                    connection.execute("synthetic write")
                    raise ValueError("synthetic business failure")
        db.execute.assert_called_once_with("synthetic write")

    def test_business_error_is_not_rewritten_as_connection_error(self):
        pool, context, _ = self.context()
        with patch.object(postgres_store, "_pool_instance", return_value=pool):
            with self.assertRaisesRegex(ValueError, "synthetic business failure"):
                with postgres_store.connection():
                    raise ValueError("synthetic business failure")


if __name__ == "__main__":
    unittest.main()
