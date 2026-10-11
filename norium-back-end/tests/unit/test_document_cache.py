"""Cache de documentos com fila por usuário: quando um entra, o usado há mais tempo sai."""

import os
import unittest
from unittest.mock import patch

from app.infrastructure.persistence import document_cache as cache


class DocumentCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = patch.dict(os.environ, {"NORIUM_DOCUMENT_CACHE": "1", "NORIUM_DOCUMENT_CACHE_USERS": "2", "NORIUM_DOCUMENT_CACHE_MB": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        cache.clear()
        self.addCleanup(cache.clear)

    def test_hit_returns_independent_copy(self) -> None:
        cache.put("user_a/tasks_db.json", True, {"items": [1]})
        found, exists, payload = cache.get("user_a/tasks_db.json")
        self.assertTrue(found and exists)
        payload["items"].append(2)
        self.assertEqual({"items": [1]}, cache.get("user_a/tasks_db.json")[2])

    def test_missing_documents_are_cached_too(self) -> None:
        cache.put("user_a/vazio_db.json", False, None)
        self.assertEqual((True, False, None), cache.get("user_a/vazio_db.json"))

    def test_new_user_evicts_least_recently_used_user(self) -> None:
        cache.put("user_a/x.json", True, {"a": 1})
        cache.put("user_b/x.json", True, {"b": 1})
        cache.get("user_a/x.json")  # a volta para o fim da fila
        cache.put("user_c/x.json", True, {"c": 1})  # b é o mais antigo e sai

        self.assertTrue(cache.get("user_a/x.json")[0])
        self.assertFalse(cache.get("user_b/x.json")[0])
        self.assertTrue(cache.get("user_c/x.json")[0])
        self.assertEqual(2, cache.snapshot()["users"])

    def test_system_documents_do_not_take_a_user_slot(self) -> None:
        cache.put("users_db.json", True, {"users": []})
        cache.put("user_a/x.json", True, {})
        cache.put("user_b/x.json", True, {})
        self.assertTrue(cache.get("users_db.json")[0])
        self.assertEqual(2, cache.snapshot()["users"])

    def test_forget_and_disabled(self) -> None:
        cache.put("user_a/x.json", True, {"a": 1})
        cache.forget("user_a/x.json")
        self.assertFalse(cache.get("user_a/x.json")[0])
        with patch.dict(os.environ, {"NORIUM_DOCUMENT_CACHE": "0"}):
            cache.put("user_a/y.json", True, {})
            self.assertFalse(cache.get("user_a/y.json")[0])

    def test_byte_limit_is_respected(self) -> None:
        big = {"data": "x" * 200_000}
        for user in "abc":
            cache.put(f"user_{user}/big.json", True, big)
        self.assertLessEqual(cache.snapshot()["bytes"], 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
