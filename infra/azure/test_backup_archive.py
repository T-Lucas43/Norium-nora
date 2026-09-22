import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from cryptography.fernet import Fernet

from backup_archive import create_backup, restore_backup


class BackupArchiveTests(unittest.TestCase):
    def test_output_inside_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            with self.assertRaisesRegex(ValueError, "outside"):
                create_backup(source, source / "backup.enc", Fernet.generate_key())

    def test_wal_is_folded_into_backup_without_stale_sidecars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            with closing(sqlite3.connect(source / "ledger.sqlite3")) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE ledger(value INTEGER)")
                connection.execute("INSERT INTO ledger VALUES (42)")
                connection.commit()
                key = Fernet.generate_key()
                create_backup(source, root / "backup.enc", key)
                restored = root / "restored"
                result = restore_backup(root / "backup.enc", restored, key)
                self.assertEqual(1, result["files"])
                self.assertFalse((restored / "ledger.sqlite3-wal").exists())
                with closing(sqlite3.connect(restored / "ledger.sqlite3")) as restored_db:
                    self.assertEqual((42,), restored_db.execute("SELECT value FROM ledger").fetchone())

    def test_full_volume_round_trip_hashes_and_sqlite_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            restored = root / "restored"
            source.mkdir()
            (source / "user_a").mkdir()
            (source / "user_a" / "perfil_db.json").write_text(json.dumps({"name": "Synthetic"}), encoding="utf-8")
            workspace = source / "user_a" / "workspace_secondary" / "nora_files"
            workspace.mkdir(parents=True)
            (workspace / "attachment.bin").write_bytes(b"synthetic attachment")
            database = source / "ledger.sqlite3"
            with closing(sqlite3.connect(database)) as connection:
                with connection:
                    connection.execute("CREATE TABLE ledger(id TEXT PRIMARY KEY, amount INTEGER NOT NULL)")
                    connection.execute("INSERT INTO ledger VALUES ('synthetic', 42)")
            archive = root / "backup.enc"
            key = Fernet.generate_key()
            created = create_backup(source, archive, key)
            result = restore_backup(archive, restored, key)
            self.assertEqual(3, created["files"])
            self.assertEqual("restored_and_verified", result["status"])
            self.assertEqual(1, result["sqliteChecked"])
            self.assertEqual((source / "user_a" / "perfil_db.json").read_bytes(), (restored / "user_a" / "perfil_db.json").read_bytes())
            self.assertEqual(b"synthetic attachment", (restored / "user_a" / "workspace_secondary" / "nora_files" / "attachment.bin").read_bytes())
            with closing(sqlite3.connect(restored / "ledger.sqlite3")) as connection:
                self.assertEqual(("synthetic", 42), connection.execute("SELECT * FROM ledger").fetchone())


if __name__ == "__main__":
    unittest.main()
