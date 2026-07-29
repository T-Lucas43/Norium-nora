from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.infrastructure.persistence.json_repository import read_json, write_json


class JsonRepositoryTest(unittest.TestCase):
    def test_roundtrip_preserves_unicode_and_nested_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            payload = {"nome": "Operação", "items": [{"id": 1, "ativo": True}]}
            write_json(path, payload)
            self.assertEqual(payload, read_json(path, {}))

    def test_corrupt_file_returns_independent_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            path.write_text("{quebrado", encoding="utf-8")
            fallback: list[str] = []
            result = read_json(path, fallback)
            result.append("novo")
            self.assertEqual([], fallback)

    def test_replacement_never_leaves_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"
            write_json(path, {"version": 1})
            write_json(path, {"version": 2})
            self.assertEqual({"version": 2}, json.loads(path.read_text(encoding="utf-8")))
            self.assertEqual([], list(Path(directory).glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
