"""AUD-01: reject incompatible authentication stores without changing bytes."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.infrastructure.persistence.json_repository import PersistenceError
from app.modules.auth import router as auth


class AuthStoreFailClosedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="audit-auth-storage-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "users.json"
        patcher = patch.object(auth, "USERS_DB_PATH", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_invalid_json_and_nested_schema_preserve_original_bytes(self):
        user = {"id": "synthetic", "role": "member", "permissions": {"chat": True}}
        values = [None, [], {}, {"users": {}}, {"users": [None]}, {"users": ["invalid"]},
                  {"users": [{**user, "sessionVersion": "NaN"}]}, {"users": [{**user, "permissions": []}]},
                  {"users": [{**user, "permissions": {"admin": "false"}}]},
                  {"users": [user, user]}, {"users": [user], "teams": {}},
                  {"users": [user], "teamRoles": [False]}, {"users": [user], "adminAudit": {}}]
        for content in [b"{broken", b"", b"\xff", *(json.dumps(value).encode() for value in values)]:
            with self.subTest(content=content):
                self.path.write_bytes(content)
                with self.assertRaises(PersistenceError):
                    await auth.read_user_store()
                self.assertEqual(content, self.path.read_bytes())

    async def test_stat_io_permission_and_read_disappearance_do_not_initialize(self):
        healthy = b'{"users":[]}'
        for error in [OSError("synthetic I/O"), PermissionError("synthetic private detail")]:
            with self.subTest(error=type(error).__name__):
                self.path.write_bytes(healthy)
                with patch.object(Path, "stat", side_effect=error):
                    with self.assertRaises(PersistenceError):
                        await auth.read_user_store()
                self.assertEqual(healthy, self.path.read_bytes())
        with patch.object(auth, "read_json_file", return_value={}):
            with self.assertRaises(PersistenceError):
                await auth.read_user_store()
        self.assertEqual(healthy, self.path.read_bytes())

    async def test_missing_file_initializes_and_healthy_restore_recovers(self):
        store = await auth.read_user_store()
        self.assertEqual([], store["users"])
        healthy = self.path.read_bytes()
        self.path.write_bytes(b"{synthetic broken")
        with self.assertRaises(PersistenceError):
            await auth.read_user_store()
        self.path.write_bytes(healthy)
        self.assertEqual(store, await auth.read_user_store())

    async def test_postgres_store_is_read_before_local_path_existence_check(self):
        stored = {
            "users": [{
                "id": "persisted-owner",
                "email": "owner@example.invalid",
                "role": "owner",
                "plan": "individual",
                "status": "ativo",
                "passwordHash": "synthetic-hash",
            }]
        }
        with (
            patch.dict(os.environ, {"NORIUM_DATABASE_URL": "postgresql://example.invalid/database"}),
            patch.object(auth, "read_json_file", return_value=stored) as read_store,
            patch.object(auth, "write_json_file") as write_store,
            patch.object(Path, "stat", side_effect=AssertionError("local stat must not gate PostgreSQL")),
        ):
            loaded = await auth.read_user_store()
        self.assertEqual("persisted-owner", loaded["users"][0]["id"])
        read_store.assert_called_once_with(self.path, None)
        write_store.assert_not_called()

    async def test_derived_capability_cannot_be_forged_in_store_and_is_not_persisted(self):
        store = {"users": [{"id": "synthetic", "role": "member", "plan": "individual", "status": "ativo",
                            "permissions": {"chat": True}, "teamChatEnabled": True}]}
        self.path.write_text(json.dumps(store), encoding="utf-8")
        loaded = await auth.read_user_store()
        self.assertFalse(loaded["users"][0]["teamChatEnabled"])
        await auth.write_user_store(loaded)
        self.assertNotIn("teamChatEnabled", json.loads(self.path.read_text(encoding="utf-8"))["users"][0])

    async def test_legacy_missing_team_link_migrates_but_explicit_detachment_does_not(self):
        store = {"users": [{"id": "owner", "role": "owner", "plan": "equipe", "status": "ativo"},
                            {"id": "legacy", "role": "member", "createdBy": "owner"},
                            {"id": "detached", "role": "member", "createdBy": "owner", "teamOwnerId": None}]}
        self.path.write_text(json.dumps(store), encoding="utf-8")
        loaded = await auth.read_user_store()
        self.assertEqual("owner", loaded["users"][1]["teamOwnerId"])
        self.assertIsNone(loaded["users"][2]["teamOwnerId"])
