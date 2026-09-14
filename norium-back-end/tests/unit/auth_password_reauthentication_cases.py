from __future__ import annotations

import copy
import os
import socket
import unittest
from unittest.mock import AsyncMock, patch


if os.environ.get("NORIUM_SECURITY_TEST_ISOLATED") != "1":
    raise RuntimeError(
        "Os cenarios AUTH-04 devem ser importados somente em um processo de teste isolado."
    )

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.auth import router as auth_router


ORIGINAL_PASSWORD = "senha-original-segura"
REPLACEMENT_PASSWORD = "senha-substituta-segura"


def synthetic_password_hash(password: str) -> str:
    return f"synthetic-password-hash:{password}"


def synthetic_password_verifier(password: str, stored_hash: str) -> bool:
    return stored_hash == synthetic_password_hash(password)


_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def local_socket_only(sock: socket.socket, address) -> None:
    if isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
        return _ORIGINAL_SOCKET_CONNECT(sock, address)
    raise AssertionError("A regressao AUTH-04 nao permite acesso a rede externa.")


def account(
    user_id: str,
    *,
    role: str = "owner",
    plan: str = "free",
    team_owner_id: str | None = None,
    system_admin_role: str | None = None,
    password: str = ORIGINAL_PASSWORD,
) -> dict:
    is_system_admin = system_admin_role in {"owner", "assistant"}
    return {
        "id": user_id,
        "nome": user_id,
        "jobTitle": "Lider" if role == "owner" else "Membro",
        "email": f"{user_id}@example.test",
        "passwordHash": auth_router.hash_password(password),
        "role": role,
        "plan": "enterprise" if is_system_admin else plan,
        "status": "ativo",
        "systemAdmin": is_system_admin,
        "systemAdminRole": system_admin_role,
        "sessionVersion": 0,
        "teamOwnerId": team_owner_id,
        "createdBy": team_owner_id,
        "permissions": auth_router.permissions_for_plan(
            "enterprise" if is_system_admin else plan,
            is_owner=role == "owner",
        ),
        "requiresPlanSelection": False,
    }


class PasswordReauthenticationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.network_patch = patch.object(
            socket.socket,
            "connect",
            local_socket_only,
        )
        self.password_hash_patch = patch.object(
            auth_router,
            "hash_password",
            side_effect=synthetic_password_hash,
        )
        self.password_verifier_patch = patch.object(
            auth_router,
            "verify_password",
            side_effect=synthetic_password_verifier,
        )
        self.network_patch.start()
        self.password_hash_patch.start()
        self.password_verifier_patch.start()
        self.addCleanup(self.network_patch.stop)
        self.addCleanup(self.password_hash_patch.stop)
        self.addCleanup(self.password_verifier_patch.stop)

        self.user = account("free-owner")
        self.persisted_store = {
            "users": [self.user],
            "teams": [],
            "adminAudit": [],
        }
        self.read_store_patch = patch.object(
            auth_router,
            "read_user_store",
            AsyncMock(side_effect=self.read_persisted_store),
        )
        self.write_store = AsyncMock(side_effect=self.persist_store)
        self.write_store_patch = patch.object(
            auth_router,
            "write_user_store",
            self.write_store,
        )
        self.auth_secret_patch = patch.object(
            auth_router,
            "AUTH_SECRET",
            b"auth-04-synthetic-secret-never-used-outside-tests",
        )
        self.read_store_patch.start()
        self.write_store_patch.start()
        self.auth_secret_patch.start()
        self.addCleanup(self.read_store_patch.stop)
        self.addCleanup(self.write_store_patch.stop)
        self.addCleanup(self.auth_secret_patch.stop)

        app = FastAPI()
        app.include_router(auth_router.router)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()

    def read_persisted_store(self) -> dict:
        return copy.deepcopy(self.persisted_store)

    def persist_store(self, store: dict) -> None:
        self.persisted_store = copy.deepcopy(store)

    def test_management_patch_cannot_change_own_password(self) -> None:
        original_token = auth_router.create_token(self.user)

        response = self.client.patch(
            f"/api/auth/users/{self.user['id']}",
            json={
                "nome": "Nome comprometido",
                "password": REPLACEMENT_PASSWORD,
            },
            headers={"Authorization": f"Bearer {original_token}"},
        )

        self.assertEqual(403, response.status_code)

        profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {original_token}"},
        )
        original_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": ORIGINAL_PASSWORD},
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": REPLACEMENT_PASSWORD},
        )

        self.assertEqual(200, profile.status_code)
        self.assertEqual("free-owner", profile.json()["user"]["nome"])
        self.assertEqual(200, original_login.status_code)
        self.assertEqual(401, replacement_login.status_code)

    def test_wrong_current_password_preserves_password_and_session(self) -> None:
        original_token = auth_router.create_token(self.user)

        response = self.client.post(
            "/api/auth/change-password",
            json={
                "currentPassword": "senha-atual-incorreta",
                "newPassword": REPLACEMENT_PASSWORD,
            },
            headers={"Authorization": f"Bearer {original_token}"},
        )

        self.assertEqual(401, response.status_code)

        profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {original_token}"},
        )
        original_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": ORIGINAL_PASSWORD},
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": REPLACEMENT_PASSWORD},
        )

        self.assertEqual(200, profile.status_code)
        self.assertEqual(200, original_login.status_code)
        self.assertEqual(401, replacement_login.status_code)

    def test_correct_current_password_rotates_password_and_session(self) -> None:
        original_token = auth_router.create_token(self.user)

        response = self.client.post(
            "/api/auth/change-password",
            json={
                "currentPassword": ORIGINAL_PASSWORD,
                "newPassword": REPLACEMENT_PASSWORD,
            },
            headers={"Authorization": f"Bearer {original_token}"},
        )

        self.assertEqual(200, response.status_code)
        replacement_token = response.json()["token"]

        revoked_profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {original_token}"},
        )
        replacement_profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {replacement_token}"},
        )
        original_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": ORIGINAL_PASSWORD},
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={"email": self.user["email"], "password": REPLACEMENT_PASSWORD},
        )

        self.assertEqual(401, revoked_profile.status_code)
        self.assertEqual(200, replacement_profile.status_code)
        self.assertEqual(401, original_login.status_code)
        self.assertEqual(200, replacement_login.status_code)

    def test_privileged_accounts_cannot_bypass_reauthentication(self) -> None:
        actors = (
            account("team-owner", plan="equipe"),
            account("system-owner", system_admin_role="owner"),
            account(
                "system-assistant",
                role="member",
                system_admin_role="assistant",
            ),
        )

        for actor in actors:
            with self.subTest(actor=actor["id"]):
                self.persisted_store["users"] = [actor]
                original_token = auth_router.create_token(actor)

                response = self.client.patch(
                    f"/api/auth/users/{actor['id']}",
                    json={"password": REPLACEMENT_PASSWORD},
                    headers={"Authorization": f"Bearer {original_token}"},
                )
                profile = self.client.get(
                    "/api/auth/me",
                    headers={"Authorization": f"Bearer {original_token}"},
                )
                replacement_login = self.client.post(
                    "/api/auth/login",
                    json={
                        "email": actor["email"],
                        "password": REPLACEMENT_PASSWORD,
                    },
                )

                self.assertEqual(403, response.status_code)
                self.assertEqual(200, profile.status_code)
                self.assertEqual(401, replacement_login.status_code)

    def test_authorized_admin_reset_revokes_only_target_session(self) -> None:
        team_owner = account("team-owner", plan="equipe")
        regular_member = account(
            "regular-member",
            role="member",
            plan="equipe",
            team_owner_id=team_owner["id"],
        )
        self.persisted_store["users"] = [team_owner, regular_member]
        self.persisted_store["teams"] = [
            {
                "id": team_owner["id"],
                "ownerUserId": team_owner["id"],
                "name": "Equipe local",
            }
        ]
        owner_token = auth_router.create_token(team_owner)
        member_token = auth_router.create_token(regular_member)

        response = self.client.patch(
            f"/api/auth/users/{regular_member['id']}",
            json={"password": REPLACEMENT_PASSWORD},
            headers={"Authorization": f"Bearer {owner_token}"},
        )

        self.assertEqual(200, response.status_code)

        owner_profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {owner_token}"},
        )
        revoked_member_profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {member_token}"},
        )
        original_login = self.client.post(
            "/api/auth/login",
            json={"email": regular_member["email"], "password": ORIGINAL_PASSWORD},
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={
                "email": regular_member["email"],
                "password": REPLACEMENT_PASSWORD,
            },
        )

        self.assertEqual(200, owner_profile.status_code)
        self.assertEqual(401, revoked_member_profile.status_code)
        self.assertEqual(401, original_login.status_code)
        self.assertEqual(200, replacement_login.status_code)

    def test_self_profile_update_without_password_remains_allowed(self) -> None:
        original_token = auth_router.create_token(self.user)

        response = self.client.patch(
            f"/api/auth/users/{self.user['id']}",
            json={"nome": "Nome atualizado"},
            headers={"Authorization": f"Bearer {original_token}"},
        )
        profile = self.client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {original_token}"},
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual("Nome atualizado", response.json()["user"]["nome"])
        self.assertEqual(200, profile.status_code)
        self.assertEqual("Nome atualizado", profile.json()["user"]["nome"])


if __name__ == "__main__":
    unittest.main()
