from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import unittest
from unittest.mock import patch


if os.environ.get("NORIUM_SECURITY_TEST_ISOLATED") != "1":
    raise RuntimeError(
        "Os cenarios AUTH-02 devem ser importados somente em um processo de teste isolado."
    )

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.auth import router as auth_router
from app.services import system_email


PUBLIC_PASSWORD = "public-account-password"
BOOTSTRAP_PASSWORD = "bootstrap-owner-password"
ORIGINAL_BOOTSTRAP_PASSWORD = "original-bootstrap-password"

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def local_socket_only(sock: socket.socket, address) -> None:
    if isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
        return _ORIGINAL_SOCKET_CONNECT(sock, address)
    raise AssertionError("A regressao AUTH-02 nao permite acesso a rede externa.")


def account(
    user_id: str,
    email: str,
    *,
    password: str = PUBLIC_PASSWORD,
    system_admin: bool = False,
    system_admin_role: str | None = None,
) -> dict:
    return {
        "id": user_id,
        "nome": user_id,
        "jobTitle": "Lider",
        "email": email,
        "passwordHash": auth_router.hash_password(password),
        "role": "owner",
        "plan": "enterprise" if system_admin else "free",
        "status": "ativo",
        "systemAdmin": system_admin,
        "systemAdminRole": system_admin_role,
        "sessionVersion": 0,
        "teamOwnerId": None,
        "createdBy": None,
        "permissions": auth_router.permissions_for_plan(
            "enterprise" if system_admin else "free"
        ),
        "requiresPlanSelection": False,
    }


def public_registration(email: str, password: str = PUBLIC_PASSWORD) -> dict:
    return {
        "nome": "Conta publica sintetica",
        "email": email,
        "password": password,
        "acceptedTerms": True,
        "acceptedPrivacy": True,
    }


class AdministrativeBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network_patch = patch.object(
            socket.socket,
            "connect",
            local_socket_only,
        )
        self.email_patch = patch.object(
            system_email,
            "issue_action",
            return_value=False,
        )
        self.network_patch.start()
        self.email_patch.start()
        self.addCleanup(self.network_patch.stop)
        self.addCleanup(self.email_patch.stop)

        app = FastAPI()
        app.include_router(auth_router.router)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()

    @staticmethod
    def write_fixture(*users: dict, system_owner_id: str | None = None) -> None:
        store = {
            "users": list(users),
            "plans": [],
            "teams": [],
            "systemOwnerId": system_owner_id,
            "adminAudit": [],
        }
        path = Path(auth_router.USERS_DB_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(store), encoding="utf-8")

    def login(self, email: str, password: str) -> dict:
        response = self.client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def profile(self, token: str) -> dict:
        response = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def assert_regular_access(self, token: str, payload: dict) -> None:
        self.assertFalse(payload["user"]["systemAdmin"])
        self.assertIsNone(payload["user"]["systemAdminRole"])
        self.assertEqual(["app"], payload["availableModes"])
        denied = self.client.get(
            "/api/auth/admin/overview",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(403, denied.status_code, denied.text)

    def assert_owner_access(self, token: str, payload: dict) -> None:
        self.assertTrue(payload["user"]["systemAdmin"])
        self.assertEqual("owner", payload["user"]["systemAdminRole"])
        self.assertEqual(["app", "admin"], payload["availableModes"])
        allowed = self.client.get(
            "/api/auth/admin/overview",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(200, allowed.status_code, allowed.text)

    def test_email_only_configuration_cannot_turn_public_registration_into_admin(
        self,
    ) -> None:
        response = self.client.post(
            "/api/auth/register",
            json=public_registration("reserved-owner@example.test"),
        )

        self.assertEqual(200, response.status_code, response.text)
        token = response.json()["token"]
        self.assert_regular_access(token, self.profile(token))

    def test_identifier_only_configuration_cannot_promote_existing_account(
        self,
    ) -> None:
        ordinary = account(
            "reserved-bootstrap-id",
            "ordinary-id-user@example.test",
        )
        self.write_fixture(ordinary)

        login = self.login(ordinary["email"], PUBLIC_PASSWORD)

        self.assert_regular_access(login["token"], self.profile(login["token"]))

    def test_complete_configuration_cannot_promote_public_registration_in_nonempty_store(
        self,
    ) -> None:
        existing = account("existing-account", "existing-account@example.test")
        self.write_fixture(existing)

        response = self.client.post(
            "/api/auth/register",
            json=public_registration("reserved-owner@example.test"),
        )

        self.assertEqual(200, response.status_code, response.text)
        token = response.json()["token"]
        self.assert_regular_access(token, self.profile(token))

        chosen_password_login = self.login(
            "reserved-owner@example.test",
            PUBLIC_PASSWORD,
        )
        self.assert_regular_access(
            chosen_password_login["token"],
            self.profile(chosen_password_login["token"]),
        )

    def test_complete_configuration_cannot_promote_persisted_account_with_matching_id(
        self,
    ) -> None:
        common = account(
            "colliding-common-id",
            "persisted-common-account@example.test",
        )
        self.write_fixture(common)

        common_login = self.login(common["email"], PUBLIC_PASSWORD)

        self.assert_regular_access(
            common_login["token"],
            self.profile(common_login["token"]),
        )

    def assert_incomplete_identity_configuration_does_not_bootstrap_admin(
        self,
    ) -> None:
        bootstrap_login = self.client.post(
            "/api/auth/login",
            json={
                "email": "bootstrap-owner@example.test",
                "password": BOOTSTRAP_PASSWORD,
            },
        )
        self.assertEqual(401, bootstrap_login.status_code, bootstrap_login.text)

        registration = self.client.post(
            "/api/auth/register",
            json=public_registration("ordinary-account@example.test"),
        )
        self.assertEqual(200, registration.status_code, registration.text)
        token = registration.json()["token"]
        self.assert_regular_access(token, self.profile(token))

    def test_complete_bootstrap_is_idempotent_and_creates_only_expected_admin(
        self,
    ) -> None:
        first_login = self.login(
            "bootstrap-owner@example.test",
            BOOTSTRAP_PASSWORD,
        )
        self.assert_owner_access(
            first_login["token"],
            self.profile(first_login["token"]),
        )

        second_login = self.login(
            "bootstrap-owner@example.test",
            BOOTSTRAP_PASSWORD,
        )
        self.assert_owner_access(
            second_login["token"],
            self.profile(second_login["token"]),
        )

        users_response = self.client.get(
            "/api/auth/admin/users",
            headers={"Authorization": f"Bearer {second_login['token']}"},
        )
        self.assertEqual(200, users_response.status_code, users_response.text)
        users = users_response.json()["users"]
        self.assertEqual(1, len(users))
        self.assertEqual("bootstrap-owner-id", users[0]["id"])
        self.assertEqual("bootstrap-owner@example.test", users[0]["email"])

        duplicate_registration = self.client.post(
            "/api/auth/register",
            json=public_registration("bootstrap-owner@example.test"),
        )
        self.assertEqual(409, duplicate_registration.status_code)

    def establish_persisted_owner_and_regular_account(self) -> None:
        owner_login = self.login(
            "original-owner@example.test",
            ORIGINAL_BOOTSTRAP_PASSWORD,
        )
        self.assert_owner_access(
            owner_login["token"],
            self.profile(owner_login["token"]),
        )

        registration = self.client.post(
            "/api/auth/register",
            json=public_registration("regular-account@example.test"),
        )
        self.assertEqual(200, registration.status_code, registration.text)
        self.assert_regular_access(
            registration.json()["token"],
            self.profile(registration.json()["token"]),
        )

    def assert_changed_configuration_preserves_persisted_owner(self) -> None:
        owner_login = self.login(
            "original-owner@example.test",
            ORIGINAL_BOOTSTRAP_PASSWORD,
        )
        self.assert_owner_access(
            owner_login["token"],
            self.profile(owner_login["token"]),
        )

        regular_login = self.login(
            "regular-account@example.test",
            PUBLIC_PASSWORD,
        )
        self.assert_regular_access(
            regular_login["token"],
            self.profile(regular_login["token"]),
        )

    def initialize_empty_store_with_incomplete_configuration(self) -> None:
        bootstrap_login = self.client.post(
            "/api/auth/login",
            json={
                "email": "late-bootstrap@example.test",
                "password": "late-bootstrap-password",
            },
        )

        self.assertEqual(401, bootstrap_login.status_code, bootstrap_login.text)

    def assert_completed_configuration_cannot_bootstrap_initialized_store(
        self,
    ) -> None:
        bootstrap_login = self.client.post(
            "/api/auth/login",
            json={
                "email": "late-bootstrap@example.test",
                "password": "late-bootstrap-password",
            },
        )
        self.assertEqual(401, bootstrap_login.status_code, bootstrap_login.text)

        registration = self.client.post(
            "/api/auth/register",
            json=public_registration("post-initialization-account@example.test"),
        )
        self.assertEqual(200, registration.status_code, registration.text)
        token = registration.json()["token"]
        self.assert_regular_access(token, self.profile(token))

    def test_legacy_admins_are_preserved_without_promoting_common_account(
        self,
    ) -> None:
        legacy_owner = account(
            "legacy-owner",
            "legacy-owner@example.test",
            system_admin=True,
        )
        legacy_assistant = account(
            "legacy-assistant",
            "legacy-assistant@example.test",
            system_admin=True,
        )
        common = account(
            "common-account",
            "common-account@example.test",
        )
        self.write_fixture(
            legacy_owner,
            legacy_assistant,
            common,
        )

        owner_login = self.login(legacy_owner["email"], PUBLIC_PASSWORD)
        owner_profile = self.profile(owner_login["token"])
        self.assert_owner_access(owner_login["token"], owner_profile)

        assistant_login = self.login(legacy_assistant["email"], PUBLIC_PASSWORD)
        assistant_profile = self.profile(assistant_login["token"])
        self.assertTrue(assistant_profile["user"]["systemAdmin"])
        self.assertEqual("assistant", assistant_profile["user"]["systemAdminRole"])
        self.assertEqual(["app", "admin"], assistant_profile["availableModes"])

        common_login = self.login(common["email"], PUBLIC_PASSWORD)
        self.assert_regular_access(
            common_login["token"],
            self.profile(common_login["token"]),
        )


if __name__ == "__main__":
    unittest.main()
