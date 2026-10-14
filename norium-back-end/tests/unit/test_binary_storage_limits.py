from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import stat
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from app.infrastructure.persistence import files, postgres_store


class BinaryStorageLimitsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.patches = [
            patch('app.core.tenant.get_data_root', return_value=self.root),
            patch.object(files, '_postgres', return_value=False),
            patch.dict('os.environ', {
                'NORIUM_STORAGE_GLOBAL_QUOTA_BYTES': '100',
                'NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES': '10',
            }),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.scratch.cleanup()

    def test_different_modules_share_the_workspace_budget(self):
        files.write(self.root / 'user_a/clients/a.pdf', b'123456')
        with self.assertRaises(HTTPException) as caught:
            files.write(self.root / 'user_a/documents/b.pdf', b'12345')
        self.assertEqual(413, caught.exception.status_code)
        self.assertFalse((self.root / 'user_a/documents/b.pdf').exists())

    def test_secondary_workspaces_and_other_users_are_independent(self):
        for key in ('user_a/clients/a.pdf', 'user_a/workspace_other/documents/b.pdf',
                    'user_b/documents/c.pdf'):
            files.write(self.root / key, b'1234567890')

    def test_global_budget_covers_other_scopes(self):
        with patch.dict('os.environ', {'NORIUM_STORAGE_GLOBAL_QUOTA_BYTES': '15'}):
            files.write(self.root / 'user_a/documents/a.pdf', b'1234567890')
            with self.assertRaises(HTTPException):
                files.write(self.root / 'user_b/clients/b.pdf', b'123456')

    def test_replacement_accounts_for_previous_size(self):
        target = self.root / 'user_a/documents/a.pdf'
        files.write(target, b'1234567890')
        files.write(target, b'12345')
        files.write(self.root / 'user_a/clients/b.pdf', b'12345')
        self.assertEqual(b'12345', target.read_bytes())

    def test_failed_replace_preserves_existing_bytes(self):
        target = self.root / 'user_a/documents/a.pdf'
        files.write(target, b'old')
        with patch.object(Path, 'replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                files.write(target, b'new')
        self.assertEqual(b'old', target.read_bytes())
        self.assertEqual([target], list(target.parent.iterdir()))

    def test_outside_data_root_rejected(self):
        with self.assertRaises(postgres_store.PostgresStoreError):
            files.write(self.root / '../outside-file', b'no')

    def test_concurrent_local_writes_cannot_overrun_budget(self):
        barrier = Barrier(2)
        def write_one(index):
            barrier.wait(timeout=5)
            try:
                files.write(self.root / f'user_a/documents/{index}.pdf', b'123456')
                return True
            except HTTPException:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(write_one, (1, 2)))
        self.assertEqual(1, sum(outcomes))

    def test_quota_scan_reads_fresh_metadata_once_for_each_entry(self):
        stored = self.root / 'user_a/documents/previous.pdf'
        files.write(stored, b'123456')
        original = Path.lstat
        reads = {}
        def lstat(path, *args, **kwargs):
            reads[path] = reads.get(path, 0) + 1
            return original(path, *args, **kwargs)
        with patch.object(Path, 'lstat', lstat):
            with files.local_write_budget(self.root / 'user_a/documents/new.pdf', 4):
                pass
        self.assertEqual({self.root / 'user_a': 1, self.root / 'user_a/documents': 1, stored: 1}, reads)
        with self.assertRaises(HTTPException):
            with files.local_write_budget(self.root / 'user_a/documents/new.pdf', 5):
                pass

    def test_quota_scan_rejects_links_before_temporary_name_exclusion(self):
        # Model lstat without requiring Windows symlink privileges. The
        # scanner must reject both a normal entry and a dangling temporary
        # link before considering its type or excluding a temporary file.
        original = Path.lstat
        for name in ('synthetic-link', '.synthetic.tmp-link'):
            with self.subTest(name=name):
                entry = self.root / name
                entry.write_bytes(b'x')
                def lstat(path, *args, **kwargs):
                    return SimpleNamespace(st_mode=stat.S_IFLNK, st_size=0) if path == entry else original(path, *args, **kwargs)
                with patch.object(Path, 'lstat', lstat):
                    with self.assertRaisesRegex(OSError, 'storage_symlink_not_supported'):
                        with files.local_write_budget(self.root / 'user_b/new.pdf', 1):
                            pass
                entry.unlink()

    def test_quota_scan_fails_closed_when_metadata_is_unreadable(self):
        entry = self.root / 'unreadable.pdf'
        entry.write_bytes(b'x')
        original = Path.lstat
        def lstat(path, *args, **kwargs):
            if path == entry:
                raise PermissionError('synthetic unreadable metadata')
            return original(path, *args, **kwargs)
        target = self.root / 'user_b/new.pdf'
        with patch.object(Path, 'lstat', lstat):
            with self.assertRaises(PermissionError):
                files.write(target, b'x')
        self.assertFalse(target.exists())

    def test_postgres_lock_usage_and_write_share_transaction(self):
        calls = []

        class DB:
            def execute(self, query, params=()):
                calls.append((query, params))
                return self
            def fetchone(self):
                return {'global_used': 0, 'workspace_used': 0, 'previous': 0}
            def fetchall(self):
                return []

        @contextmanager
        def conn():
            yield DB()

        with patch.object(postgres_store, 'initialize'), patch.object(postgres_store, 'connection', conn):
            postgres_store.write_blob('user_a/clients/a.pdf', b'1234', 'application/pdf')
        self.assertIn('lock_timeout', calls[0][0])
        self.assertIn('pg_advisory_xact_lock', calls[1][0])
        self.assertIn('global_used', calls[2][0])
        self.assertIn('INSERT INTO norium_blobs', calls[-1][0])
        self.assertEqual(('user_a/', 'user_a/workspace_', 'user_a/workspace_', 'user_a/clients/a.pdf', 'blob'), calls[2][1])

    def test_postgres_exhaustion_prevents_insert(self):
        calls = []

        class DB:
            def execute(self, query, params=()):
                calls.append(query)
                return self
            def fetchone(self):
                return {'global_used': 100, 'workspace_used': 0, 'previous': 0}
            def fetchall(self):
                return []

        @contextmanager
        def conn():
            yield DB()

        with patch.object(postgres_store, 'initialize'), patch.object(postgres_store, 'connection', conn):
            with self.assertRaises(HTTPException):
                postgres_store.write_blob('user_a/documents/a.pdf', b'1', 'application/pdf')
        self.assertFalse(any('INSERT INTO' in query for query in calls))
