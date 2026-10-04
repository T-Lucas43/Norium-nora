from __future__ import annotations

import copy
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from app.bootstrap import safe_validation_error
from app.core import security
from app.modules.auth import router as auth
from tests.unit.test_persistent_sessions import TemporarySessionFixture


class PasswordStorageTests(TemporarySessionFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.store = {"users": [], "teams": [], "adminAudit": []}
        self.read = patch.object(auth, "read_user_store", AsyncMock(side_effect=lambda: copy.deepcopy(self.store)))
        self.write = patch.object(auth, "write_user_store", AsyncMock(side_effect=lambda value: self.store.update(copy.deepcopy(value))))
        for active in (self.read, self.write):
            active.start(); self.addCleanup(active.stop)
        auth.register_limiter._attempts.clear()
        application = FastAPI()
        application.add_exception_handler(RequestValidationError, safe_validation_error)
        application.include_router(auth.router)
        self.client = TestClient(application)
        self.addCleanup(self.client.close)

    def register(self):
        return self.client.post("/api/auth/register", json={"nome": "Synthetic", "email": "test@example.test",
            "password": "synthetic-password-only-for-test", "acceptedTerms": True, "acceptedPrivacy": True})

    def test_registration_persists_real_hash_and_never_returns_password_or_hash(self):
        response = self.register()
        self.assertEqual(200, response.status_code)
        stored = self.store["users"][0]
        self.assertNotIn("password", stored)
        self.assertTrue(stored["passwordHash"].startswith("pbkdf2_sha256_v2$600000$"))
        self.assertTrue(security.verify_password("synthetic-password-only-for-test", stored["passwordHash"]))
        self.assertNotIn("synthetic-password-only-for-test", response.text)
        self.assertNotIn("passwordHash", response.text)

    def test_change_password_persists_hash_and_replaces_old_session(self):
        token = self.register().json()["token"]
        old_hash = self.store["users"][0]["passwordHash"]
        response = self.client.post("/api/auth/change-password", headers={"Authorization": "Bearer " + token},
            json={"currentPassword": "synthetic-password-only-for-test", "newPassword": "synthetic-replacement-only-for-test"})
        self.assertEqual(200, response.status_code)
        new_hash = self.store["users"][0]["passwordHash"]
        self.assertNotEqual(old_hash, new_hash)
        self.assertTrue(security.verify_password("synthetic-replacement-only-for-test", new_hash))
        self.assertFalse(security.verify_password("synthetic-password-only-for-test", new_hash))
        self.assertNotIn("passwordHash", response.text)
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)

    def test_recovery_persists_real_hash_and_revokes_previous_version(self):
        from app.modules.auth.email_router import apply_token
        from app.services import system_email
        import asyncio
        self.register()
        record = {"user_id": self.store["users"][0]["id"], "email": "test@example.test", "version": 0}
        with patch.object(system_email, "consume_action", return_value=record):
            asyncio.run(apply_token("synthetic-single-use-action", "reset", "synthetic-reset-password-for-test"))
        self.assertTrue(security.verify_password("synthetic-reset-password-for-test", self.store["users"][0]["passwordHash"]))
        self.assertEqual(1, self.store["users"][0]["sessionVersion"])

    def test_validation_errors_do_not_echo_rejected_password(self):
        response = self.client.post("/api/auth/register", json={"nome": "Synthetic", "email": "test@example.test", "password": "zz9Secret"})
        self.assertEqual(422, response.status_code)
        self.assertNotIn("zz9Secret", response.text)
        self.assertNotIn('"input"', response.text)
        self.assertIn("password", response.text)

    def test_user_sanitizer_discards_legacy_secret_fields_and_internal_identity(self):
        user = {"id": "alice", "nome": "Alice", "passwordHash": "hash", "password": "sensitive", "senha": "sensitive",
                "apiToken": "sensitive", "clientSecret": "sensitive", "_authSession": "internal", "permissions": {}}
        result = auth.sanitize_user(user)
        for key in ("passwordHash", "password", "senha", "apiToken", "clientSecret", "_authSession"):
            self.assertNotIn(key, result)

    def test_malformed_or_excessive_password_hash_fails_without_processing(self):
        with patch.object(security.hashlib, "pbkdf2_hmac") as derive:
            for value in (None, "plain-password", "pbkdf2_sha256_v2$999999999$" + "a" * 32 + "$" + "b" * 64):
                self.assertFalse(security.verify_password("synthetic", value))
        derive.assert_not_called()
