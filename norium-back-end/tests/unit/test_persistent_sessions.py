from __future__ import annotations

import copy
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.infrastructure import auth_sessions as sessions
from app.infrastructure.persistence import postgres_store
from app.modules.auth import router as auth
from app.modules.auth import session_http


class TemporarySessionFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for active in (patch.object(sessions, "get_data_root", return_value=self.root),
                       patch.dict(os.environ, {"ENVIRONMENT": "test", "APP_ENV": "test", "NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0"})):
            active.start()
            self.addCleanup(active.stop)


class SessionStoreTests(TemporarySessionFixture, unittest.TestCase):
    def test_stores_only_hashes_and_normalized_metadata(self):
        row, refresh, csrf = sessions.create("alice", 0, persistent=True, agent="Chrome Windows <script>private text</script>")
        raw = (self.root / "_system" / "auth_sessions.sqlite3").read_bytes()
        self.assertNotIn(refresh.encode(), raw)
        self.assertNotIn(csrf.encode(), raw)
        self.assertNotIn(b"private text", raw)
        self.assertEqual("Chrome", row["browser"])
        self.assertEqual(sessions.ABSOLUTE_SECONDS, row["expires"] - row["created"])

    def test_rotation_preserves_absolute_deadline_and_replay_revokes(self):
        row, original, csrf = sessions.create("alice", 0)
        rotated, replacement = sessions.rotate(original, csrf, "alice", 0)
        self.assertNotEqual(original, replacement)
        self.assertEqual(row["expires"], rotated["expires"])
        with self.assertRaisesRegex(sessions.SessionError, "refresh_reused"):
            sessions.rotate(original, csrf, "alice", 0)
        with self.assertRaises(sessions.SessionError):
            sessions.validate(row["id"], "alice", 0)

    def test_csrf_failure_does_not_consume_or_revoke(self):
        row, refresh, csrf = sessions.create("alice", 0)
        with self.assertRaisesRegex(sessions.SessionError, "csrf_invalid"):
            sessions.rotate(refresh, sessions.credential(), "alice", 0)
        self.assertEqual(row["id"], sessions.rotate(refresh, csrf, "alice", 0)[0]["id"])

    def test_revocation_is_authoritative_after_reopening_database(self):
        row, refresh, csrf = sessions.create("alice", 0)
        sessions.revoke("alice", sid=row["id"])
        for operation in (lambda: sessions.validate(row["id"], "alice", 0),
                          lambda: sessions.rotate(refresh, csrf, "alice", 0)):
            with self.assertRaises(sessions.SessionError):
                operation()

    def test_batch_binds_full_identity_version_and_rechecks_revocation(self):
        alice, _, _ = sessions.create("alice", 2)
        bob, _, _ = sessions.create("bob", 0)
        permitted = (alice["id"], "alice", 2)
        other = (bob["id"], "bob", 0)
        bindings = [permitted, permitted, other, (alice["id"], "bob", 2),
                    (alice["id"], "alice", 1), ("'; DROP TABLE norium_auth_sessions;--", "alice", 2)]
        self.assertEqual({permitted, other}, sessions.valid_bindings(bindings))
        sessions.revoke("alice", sid=alice["id"])
        self.assertEqual({other}, sessions.valid_bindings(bindings))
        sessions.validate(bob["id"], "bob", 0)

    def test_batch_expiry_idle_and_bound_fail_closed(self):
        row, _, _ = sessions.create("alice", 0)
        binding = (row["id"], "alice", 0)
        for deadline in (row["expires"], row["created"] + sessions.IDLE_SECONDS):
            with patch.object(sessions.time, "time", return_value=deadline):
                self.assertEqual(set(), sessions.valid_bindings([binding]))
        with patch.object(sessions, "transaction") as transaction:
            self.assertEqual(set(), sessions.valid_bindings([]))
            with self.assertRaisesRegex(sessions.SessionError, "session_batch_limit"):
                sessions.valid_bindings([binding] * 1001)
            transaction.assert_not_called()

    def test_batch_database_failure_propagates_without_grant(self):
        with patch.object(sessions, "transaction", side_effect=postgres_store.PostgresStoreError("unavailable")):
            with self.assertRaises(postgres_store.PostgresStoreError):
                sessions.valid_bindings([("opaque-session", "alice", 0)])

    def test_other_account_cannot_revoke_or_rename(self):
        row, _, _ = sessions.create("alice", 0)
        sessions.revoke("bob", sid=row["id"])
        self.assertEqual(row["id"], sessions.validate(row["id"], "alice", 0)["id"])
        with self.assertRaises(sessions.SessionError):
            sessions.rename(row["id"], "bob", 0, "stolen")
        self.assertEqual([], sessions.list_sessions("bob", 0))

    def test_global_revoke_blocks_pending_login_but_allows_new_password_proof(self):
        old_epoch = sessions.epoch("alice")
        sessions.create("alice", 0, expected_epoch=old_epoch)
        sessions.revoke("alice")
        with self.assertRaisesRegex(sessions.SessionError, "session_creation_conflict"):
            sessions.create("alice", 0, expected_epoch=old_epoch)
        fresh = sessions.epoch("alice")
        self.assertEqual(fresh, old_epoch + 1)
        sessions.create("alice", 0, expected_epoch=fresh)

    def test_revoke_others_preserves_current(self):
        first, _, _ = sessions.create("alice", 0)
        second, _, _ = sessions.create("alice", 0)
        sessions.revoke("alice", except_sid=first["id"])
        sessions.validate(first["id"], "alice", 0)
        with self.assertRaises(sessions.SessionError):
            sessions.validate(second["id"], "alice", 0)

    def test_expiry_idle_and_version_fail_closed(self):
        row, _, _ = sessions.create("alice", 1)
        for version, now in ((0, row["created"]), (1, row["expires"]), (1, row["created"] + sessions.IDLE_SECONDS)):
            with patch.object(sessions.time, "time", return_value=now):
                with self.assertRaises(sessions.SessionError):
                    sessions.validate(row["id"], "alice", version)

    def test_sql_payload_is_only_label_data(self):
        row, _, _ = sessions.create("alice", 0)
        label = "'; DROP TABLE norium_auth_sessions; --"
        sessions.rename(row["id"], "alice", 0, label)
        self.assertEqual(label, sessions.list_sessions("alice", 0)[0]["label"])
        sessions.create("bob", 0)

    def test_concurrent_rotation_has_no_second_grant_and_replay_is_committed(self):
        row, refresh, csrf = sessions.create("alice", 0)
        barrier = threading.Barrier(2)
        def rotate():
            barrier.wait()
            try:
                sessions.rotate(refresh, csrf, "alice", 0)
                return "issued"
            except sessions.SessionError as exc:
                return exc.code
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(lambda _: rotate(), range(2)))
        self.assertCountEqual(["issued", "refresh_reused"], results)
        with self.assertRaises(sessions.SessionError):
            sessions.validate(row["id"], "alice", 0)

    def test_unavailable_production_has_no_local_fallback(self):
        with patch.dict(os.environ, {"ENVIRONMENT": "staging", "APP_ENV": "staging"}):
            with self.assertRaises(postgres_store.PostgresStoreError):
                sessions.create("alice", 0)
        self.assertFalse((self.root / "_system" / "auth_sessions.sqlite3").exists())

    def test_session_limit_and_activity_throttle(self):
        row, _, _ = sessions.create("alice", 0)
        for _ in range(sessions.MAX_SESSIONS - 1):
            sessions.create("alice", 0)
        with self.assertRaisesRegex(sessions.SessionError, "session_limit"):
            sessions.create("alice", 0)
        with patch.object(sessions.time, "time", return_value=row["created"] + 61):
            touched = sessions.validate(row["id"], "alice", 0, touch=True)
        self.assertEqual(row["created"] + 61, touched["last_activity"])

    def test_events_are_bounded_and_do_not_include_credentials_or_label(self):
        row, refresh, csrf = sessions.create("alice", 0)
        sessions.rename(row["id"], "alice", 0, "private-label")
        sessions.rotate(refresh, csrf, "alice", 0)
        with patch.object(sessions, "MAX_EVENTS_PER_ACCOUNT", 3):
            for _ in range(5):
                sessions.reauthenticate(row["id"], "alice", 0)
        with sessions.transaction(read_only=True) as db:
            rows = [dict(item) for item in db.execute("SELECT * FROM norium_auth_events WHERE user_id=%s", ("alice",)).fetchall()]
        self.assertEqual(3, len(rows))
        self.assertNotIn(refresh, str(rows))
        self.assertNotIn(csrf, str(rows))
        self.assertNotIn("private-label", str(rows))

    def test_erasure_removes_metadata_and_credentials_but_fences_pending_login(self):
        before = sessions.epoch("alice")
        _, refresh, _ = sessions.create("alice", 0)
        other, _, _ = sessions.create("bob", 0)
        sessions.erase_personal_sessions("alice")
        self.assertIsNone(sessions.lookup(refresh))
        self.assertEqual([], sessions.list_sessions("alice", 0))
        self.assertEqual(before + 1, sessions.epoch("alice"))
        with sessions.transaction(read_only=True) as db:
            self.assertEqual(0, db.execute("SELECT COUNT(*) AS n FROM norium_auth_events WHERE user_id=%s", ("alice",)).fetchone()["n"])
        sessions.validate(other["id"], "bob", 0)


class SessionHttpTests(TemporarySessionFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.user = {"id": "alice", "nome": "Alice", "email": "alice@example.test", "status": "ativo",
                     "sessionVersion": 0, "passwordHash": "synthetic", "permissions": auth.permissions_for_plan("free"), "plan": "free", "role": "owner"}
        self.store = {"users": [self.user], "teams": [], "adminAudit": []}
        for active in (patch.object(auth, "read_user_store", AsyncMock(side_effect=lambda: copy.deepcopy(self.store))),
                       patch.object(auth, "write_user_store", AsyncMock()),
                       patch.object(auth, "verify_password", return_value=True),
                       patch.object(auth, "password_needs_rehash", return_value=False)):
            active.start()
            self.addCleanup(active.stop)
        application = FastAPI()
        application.include_router(auth.router)
        self.client = TestClient(application, base_url="https://testserver")
        self.addCleanup(self.client.close)
        auth.login_limiter._attempts.clear()

    def login(self, persistent=True):
        context = self.client.get("/api/auth/session-context", headers={"Origin": "https://testserver"})
        self.assertEqual(200, context.status_code)
        self.csrf = context.json()["csrf"]
        response = self.client.post("/api/auth/login", json={"email": self.user["email"], "password": "synthetic-test-password", "persistent": persistent},
                                    headers={"Origin": "https://testserver", "X-Norium-CSRF": self.csrf})
        self.assertEqual(200, response.status_code, response.text)
        self.csrf = self.client.get("/api/auth/session-context", headers={"Origin": "https://testserver"}).json()["csrf"]
        return response

    def test_persistent_cookie_and_short_access(self):
        response = self.login()
        cookies = response.headers.get_list("set-cookie")
        for value in cookies:
            self.assertIn("HttpOnly", value)
            self.assertIn("Secure", value)
            self.assertIn("SameSite=lax", value)
            self.assertIn("Path=/", value)
            self.assertNotIn("Domain=", value)
            self.assertIn("Max-Age=604800", value)
        payload = auth.decode_token(response.json()["token"])
        self.assertTrue(payload["sid"])
        self.assertTrue(payload["jti"])
        self.assertLessEqual(payload["exp"] - int(time.time()), 900)
        self.assertEqual("no-store", response.headers["cache-control"])

    def test_cookie_without_bearer_cannot_access_private_api(self):
        self.login()
        self.assertEqual(401, self.client.get("/api/auth/me").status_code)

    def test_feature_suspension_does_not_disable_access_validation_or_revocation(self):
        token = self.login().json()["token"]
        with patch.dict(os.environ, {"NORIUM_PERSISTENT_SESSIONS_ENABLED": "false"}):
            response = self.client.post("/api/auth/refresh", json={}, headers={"Origin": "https://testserver", "X-Norium-CSRF": self.csrf})
            self.assertEqual(503, response.status_code)
            self.assertEqual(200, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)
            sessions.revoke(self.user["id"])
            self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)

    def test_browser_reopen_restores_without_token_storage(self):
        self.login()
        response = self.client.post("/api/auth/refresh", json={}, headers={"Origin": "https://testserver", "X-Norium-CSRF": self.csrf})
        self.assertEqual(200, response.status_code)
        token = response.json()["token"]
        self.assertEqual(200, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)

    def test_csrf_origin_and_missing_origin_rejected(self):
        self.login()
        for headers in ({"Origin": "https://evil.test", "X-Norium-CSRF": self.csrf},
                        {"Origin": "https://testserver"}, {"X-Norium-CSRF": self.csrf}):
            self.assertEqual(403, self.client.post("/api/auth/refresh", json={}, headers=headers).status_code)

    def test_browser_password_login_requires_csrf(self):
        response = self.client.post("/api/auth/login", json={"email": self.user["email"], "password": "synthetic"}, headers={"Origin": "https://testserver"})
        self.assertEqual(403, response.status_code)

    def test_nonpersistent_cookie_has_no_max_age(self):
        for value in self.login(False).headers.get_list("set-cookie"):
            self.assertNotIn("Max-Age", value)
            self.assertNotIn("expires=", value.lower())

    def test_current_logout_does_not_revoke_other_device(self):
        first = self.login().json()["token"]
        second = self.login().json()["token"]
        self.assertEqual(200, self.client.post("/api/auth/logout", headers={"Authorization": "Bearer " + second}).status_code)
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + second}).status_code)
        self.assertEqual(200, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + first}).status_code)

    def test_list_has_no_secrets_and_revokes_access_immediately(self):
        token = self.login().json()["token"]
        headers = {"Authorization": "Bearer " + token}
        response = self.client.get("/api/auth/sessions", headers=headers)
        row = response.json()["sessions"][0]
        self.assertTrue(row["current"])
        self.assertNotIn("csrf_hash", row)
        self.assertEqual(200, self.client.delete("/api/auth/sessions/" + row["id"], headers=headers).status_code)
        self.assertEqual(401, self.client.get("/api/auth/me", headers=headers).status_code)

    def test_legacy_access_requires_new_login(self):
        token = auth.create_signed_token(self.user, secret=auth.AUTH_SECRET)
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)

    def test_cookie_logout_with_missing_refresh_cookie_revokes_signed_session(self):
        token = self.login().json()["token"]
        self.client.cookies.delete(session_http.REFRESH_COOKIE)
        response = self.client.post("/api/auth/cookie-logout", json={}, headers={
            "Origin": "https://testserver", "X-Norium-CSRF": self.csrf, "Authorization": "Bearer " + token})
        self.assertEqual(200, response.status_code)
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)

    def test_cookie_logout_of_old_tab_preserves_new_cookie_session(self):
        first = self.login().json()["token"]
        second = self.login().json()["token"]
        response = self.client.post("/api/auth/cookie-logout", json={}, headers={
            "Origin": "https://testserver", "X-Norium-CSRF": self.csrf, "Authorization": "Bearer " + first})
        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.headers.get_list("set-cookie"))
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + first}).status_code)
        self.assertEqual(200, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + second}).status_code)

    def test_expired_signature_can_only_revoke_its_own_session(self):
        session = self.login().json()["token"]
        claims = auth.decode_token(session)
        expired = auth.create_signed_token(self.user, secret=auth.AUTH_SECRET, ttl_seconds=-1, session_id=claims["sid"])
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + expired}).status_code)
        response = self.client.post("/api/auth/cookie-logout", json={}, headers={
            "Origin": "https://testserver", "X-Norium-CSRF": self.csrf, "Authorization": "Bearer " + expired})
        self.assertEqual(200, response.status_code)
        self.assertEqual(401, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + session}).status_code)

    def test_cookie_logout_with_forged_signature_does_not_revoke_session(self):
        token = self.login().json()["token"]
        forged = auth.create_signed_token(self.user, secret=b"synthetic-wrong-key", session_id=auth.decode_token(token)["sid"])
        response = self.client.post("/api/auth/cookie-logout", json={}, headers={
            "Origin": "https://testserver", "X-Norium-CSRF": self.csrf, "Authorization": "Bearer " + forged})
        self.assertEqual(401, response.status_code)
        self.assertEqual(200, self.client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code)
