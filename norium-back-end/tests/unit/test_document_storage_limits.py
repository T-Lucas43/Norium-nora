from __future__ import annotations

import tempfile
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from fastapi import HTTPException

from app.infrastructure.persistence import files, postgres_store
from app.infrastructure.persistence.json_repository import write_json


class DocumentStorageLimitsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for active in (patch("app.core.tenant.get_data_root", return_value=self.root),
                       patch.dict("os.environ", {"NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0",
                         "NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": "100", "NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES": "10"})):
            active.start(); self.addCleanup(active.stop)

    def test_json_and_binary_use_the_same_budget_and_replacement_credit(self):
        document = self.root / "user_a/profile.json"
        write_json(document, {"x": "a"})
        with self.assertRaises(HTTPException):
            files.write(self.root / "user_a/file.bin", b"12")
        write_json(document, {"x": ""})
        files.write(self.root / "user_a/file.bin", b"12")
        self.assertEqual(10, sum(item.stat().st_size for item in document.parent.iterdir()))

    def test_extended_path_spelling_preserves_drive_unc_and_outside_root_denial(self):
        normalize = postgres_store._strip_windows_extended_prefix
        self.assertEqual("C:\\data\\user\\file.bin", normalize("\\\\?\\C:\\data\\user\\file.bin"))
        self.assertEqual("\\\\server\\share\\file.bin", normalize("\\\\?\\UNC\\server\\share\\file.bin"))
        self.assertEqual("\\\\?\\GLOBALROOT\\Device", normalize("\\\\?\\GLOBALROOT\\Device"))
        with self.assertRaises(postgres_store.PostgresStoreError):
            postgres_store.canonical_key(self.root.parent / "outside.bin")
        if os.name == "nt":
            candidate = self.root / "user_a/file.bin"
            with patch.object(Path, "resolve", side_effect=[self.root.resolve(), Path("\\\\?\\"+str(candidate))]):
                self.assertEqual("user_a/file.bin", postgres_store.canonical_key(candidate))

    def test_global_budget_covers_json_in_different_accounts(self):
        with patch.dict("os.environ", {"NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": "15"}):
            write_json(self.root / "user_a/profile.json", {"x": "a"})
            with self.assertRaises(HTTPException):
                write_json(self.root / "user_b/profile.json", {"x": "a"})
        self.assertFalse((self.root / "user_b/profile.json").exists())

    def test_concurrent_json_and_binary_cannot_both_exhaust_workspace(self):
        barrier = Barrier(2)
        def write(kind):
            barrier.wait(timeout=5)
            try:
                if kind == "json":
                    write_json(self.root / "user_a/profile.json", {"x": "a"})
                else:
                    files.write(self.root / "user_a/file.bin", b"123456")
                return True
            except HTTPException:
                return False
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(1, sum(pool.map(write, ("json", "binary"))))

    def test_postgres_document_check_and_write_share_one_transaction(self):
        calls = []
        class Database:
            def execute(self, query, values=()):
                calls.append((query, values)); self.query = query; return self
            def fetchone(self):
                if "AS size" in self.query and "WITH objects" not in self.query:
                    return {"size": 8}
                return {"global_used": 2, "workspace_used": 2, "previous": 0}
            def fetchall(self):
                return []
        @contextmanager
        def connection():
            yield Database()
        with patch.object(postgres_store, "initialize"), patch.object(postgres_store, "connection", connection):
            postgres_store.write_document("user_a/profile.json", {"x": ""})
        self.assertIn("pg_advisory_xact_lock", calls[1][0])
        self.assertIn("norium_blobs", calls[3][0])
        self.assertIn("norium_documents", calls[3][0])
        self.assertIn("INSERT INTO norium_documents", calls[-1][0])
