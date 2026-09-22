import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from backup_production_data import download_snapshot, safe_relative


class FakeShare:
    def list_directories_and_files(self, directory_name=None):
        if directory_name is None:
            return [{"name": "user_test", "is_directory": True}]
        return [{"name": "data.json", "is_directory": False}]

    def get_file_client(self, name):
        return SimpleNamespace(get_file_properties=lambda: SimpleNamespace(size=2),
                               download_file=lambda **kwargs: SimpleNamespace(readinto=lambda stream: stream.write(b"{}")))


class SnapshotDownloadTests(unittest.TestCase):
    def test_download_uses_snapshot_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = download_snapshot(FakeShare(), root)
            self.assertEqual({"downloadedFiles": 1, "downloadedBytes": 2}, result)
            self.assertEqual(b"{}", (root / "user_test" / "data.json").read_bytes())

    def test_reject_unsafe_names(self):
        for name in ("", "/root", "../secret", "a/../../b", "a\\b", "C:/b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_relative(name)


if __name__ == "__main__":
    unittest.main()
