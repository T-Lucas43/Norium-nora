from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from app.infrastructure.persistence.json_repository import PersistenceError, read_json, write_json


class JsonRepositoryTest(unittest.TestCase):
    def test_repeated_reads_do_not_reparse_and_return_independent_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            write_json(path, {"items": [{"value": 1}]})
            with patch("app.infrastructure.persistence.json_repository.json.loads", wraps=json.loads) as parse:
                first = read_json(path, {})
                first["items"][0]["value"] = 9
                self.assertEqual({"items": [{"value": 1}]}, read_json(path, {}))
                self.assertEqual(1, parse.call_count)

    def test_cache_observes_external_replacement_and_deletion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            write_json(path, {"value": 1})
            read_json(path, {})
            replacement = Path(directory) / "replacement.json"
            replacement.write_text('{"value": 2}', encoding="utf-8")
            replacement.replace(path)
            self.assertEqual({"value": 2}, read_json(path, {}))
            path.unlink()
            self.assertEqual({}, read_json(path, {}))

    def test_cache_is_scoped_by_full_path_and_invalidated_after_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "user_a" / "data.json"
            b = Path(directory) / "user_b" / "data.json"
            write_json(a, {"value": 1})
            write_json(b, {"value": 2})
            self.assertEqual({"value": 1}, read_json(a, {}))
            self.assertEqual({"value": 2}, read_json(b, {}))
            write_json(a, {"value": 3})
            self.assertEqual({"value": 3}, read_json(a, {}))

    def test_compact_encoding_preserves_the_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            payload = {"name": "Operação", "items": [{"id": number} for number in range(20)]}
            write_json(path, payload)
            self.assertLess(path.stat().st_size, len(json.dumps(payload, indent=2, ensure_ascii=False).encode()))
            self.assertEqual(payload, json.loads(path.read_text(encoding="utf-8")))

    def test_roundtrip_preserves_unicode_and_nested_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            payload = {"nome": "Operação", "items": [{"id": 1, "ativo": True}]}
            write_json(path, payload)
            self.assertEqual(payload, read_json(path, {}))

    def test_corrupt_file_raises_and_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            path.write_text("{quebrado", encoding="utf-8")
            fallback: list[str] = []
            with self.assertRaises(PersistenceError):
                read_json(path, fallback)
            self.assertEqual([], fallback)
            self.assertEqual("{quebrado", path.read_text(encoding="utf-8"))

    def test_replacement_never_leaves_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            write_json(path, {"version": 1})
            write_json(path, {"version": 2})
            self.assertEqual({"version": 2}, json.loads(path.read_text(encoding="utf-8")))
            self.assertEqual([], list(Path(directory).glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
