import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from cryptography.fernet import Fernet

from backup_archive import create_backup, restore_backup


class BackupArchiveTests(unittest.TestCase):
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
