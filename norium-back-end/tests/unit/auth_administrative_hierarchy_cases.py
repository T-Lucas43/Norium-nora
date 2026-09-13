from __future__ import annotations

import os
import socket
import unittest
from unittest.mock import AsyncMock, patch


if os.environ.get("NORIUM_SECURITY_TEST_ISOLATED") != "1":
    raise RuntimeError(
        "Os cenarios AUTH-01 devem ser importados somente em um processo de teste isolado."
    )

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.auth import router as auth_router


ORIGINAL_ASSISTANT_PASSWORD = "senha-original-segura"
REPLACEMENT_ASSISTANT_PASSWORD = "senha-substituta-segura"


def synthetic_password_hash(password: str) -> str:
    return f"synthetic-password-hash:{password}"


def synthetic_password_verifier(password: str, stored_hash: str) -> bool:
    return stored_hash == synthetic_password_hash(password)


_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def local_socket_only(sock: socket.socket, address) -> None:
    if isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
        return _ORIGINAL_SOCKET_CONNECT(sock, address)
    raise AssertionError("A regressao AUTH-01 nao permite acesso a rede externa.")


def account(
    user_id: str,
    *,
    role: str = "member",
    team_owner_id: str | None = None,
    system_admin_role: str | None = None,
    password: str = "senha-padrao-segura",
) -> dict:
    is_system_admin = system_admin_role in {"owner", "assistant"}
    return {
        "id": user_id,
        "nome": user_id,
        "jobTitle": "Lider" if role == "owner" else "Membro",
        "email": f"{user_id}@example.test",
        "passwordHash": auth_router.hash_password(password),
        "role": role,
        "plan": "enterprise" if is_system_admin else "equipe",
        "status": "ativo",
        "systemAdmin": is_system_admin,
        "systemAdminRole": system_admin_role,
        "sessionVersion": 0,
        "teamOwnerId": team_owner_id,
        "createdBy": team_owner_id,
        "permissions": auth_router.permissions_for_plan(
            "enterprise" if is_system_admin else "equipe",
            is_owner=role == "owner",
        ),
        "requiresPlanSelection": False,
    }


class AdministrativeHierarchyTests(unittest.TestCase):
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

        self.system_owner = account(
            "system-owner",
            role="owner",
            system_admin_role="owner",
        )
        self.team_owner = account("team-owner", role="owner")
        self.linked_assistant = account(
            "linked-assistant",
            team_owner_id=self.team_owner["id"],
            system_admin_role="assistant",
            password=ORIGINAL_ASSISTANT_PASSWORD,
        )
        self.regular_member = account(
            "regular-member",
            team_owner_id=self.team_owner["id"],
        )
        self.other_team_owner = account("other-team-owner", role="owner")
        self.other_team_member = account(
            "other-team-member",
            team_owner_id=self.other_team_owner["id"],
        )
        self.store = {
            "users": [
                self.system_owner,
                self.team_owner,
                self.linked_assistant,
                self.regular_member,
                self.other_team_owner,
                self.other_team_member,
            ],
            "teams": [
                {
                    "id": self.system_owner["id"],
                    "ownerUserId": self.system_owner["id"],
                    "name": "Sistema",
                },
                {
                    "id": self.team_owner["id"],
                    "ownerUserId": self.team_owner["id"],
                    "name": "Equipe local",
                },
                {
                    "id": self.other_team_owner["id"],
                    "ownerUserId": self.other_team_owner["id"],
                    "name": "Outra equipe",
                },
            ],
            "systemOwnerId": self.system_owner["id"],
            "adminAudit": [],
        }

        self.read_store_patch = patch.object(
            auth_router,
            "read_user_store",
            AsyncMock(side_effect=lambda: self.store),
        )
        self.write_store = AsyncMock()
        self.write_store_patch = patch.object(
            auth_router,
            "write_user_store",
            self.write_store,
        )
        self.auth_secret_patch = patch.object(
            auth_router,
            "AUTH_SECRET",
            b"auth-01-synthetic-secret-never-used-outside-tests",
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

    def test_team_owner_cannot_replace_linked_assistant_password(self) -> None:
        response = self.client.patch(
            f"/api/auth/users/{self.linked_assistant['id']}",
            json={"password": REPLACEMENT_ASSISTANT_PASSWORD},
            headers=self.authorization_for(self.team_owner),
        )

        self.assertEqual(403, response.status_code)

        original_login = self.client.post(
            "/api/auth/login",
            json={
                "email": self.linked_assistant["email"],
                "password": ORIGINAL_ASSISTANT_PASSWORD,
            },
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={
                "email": self.linked_assistant["email"],
                "password": REPLACEMENT_ASSISTANT_PASSWORD,
            },
        )
        self.assertEqual(200, original_login.status_code)
        self.assertEqual(401, replacement_login.status_code)

    def test_team_owner_cannot_deactivate_linked_assistant(self) -> None:
        attempts = (
            ("PATCH", {"status": "inativo"}),
            ("DELETE", None),
        )
        for method, payload in attempts:
            with self.subTest(method=method):
                response = self.client.request(
                    method,
                    f"/api/auth/users/{self.linked_assistant['id']}",
                    json=payload,
                    headers=self.authorization_for(self.team_owner),
                )
                self.assertEqual(403, response.status_code)

        assistant_profile = self.client.get(
            "/api/auth/me",
            headers=self.authorization_for(self.linked_assistant),
        )
        self.assertEqual(200, assistant_profile.status_code)
        self.assertEqual("ativo", assistant_profile.json()["user"]["status"])

    def test_system_assistant_cannot_change_or_deactivate_system_owner(self) -> None:
        attempts = (
            ("PATCH", {"nome": "Proprietario alterado"}),
            ("DELETE", None),
        )
        for method, payload in attempts:
            with self.subTest(method=method):
                response = self.client.request(
                    method,
                    f"/api/auth/users/{self.system_owner['id']}",
                    json=payload,
                    headers=self.authorization_for(self.linked_assistant),
                )
                self.assertEqual(403, response.status_code)

        owner_profile = self.client.get(
            "/api/auth/me",
            headers=self.authorization_for(self.system_owner),
        )
        self.assertEqual(200, owner_profile.status_code)
        self.assertEqual("system-owner", owner_profile.json()["user"]["nome"])
        self.assertEqual("ativo", owner_profile.json()["user"]["status"])

    def test_system_owner_can_update_and_deactivate_linked_assistant(self) -> None:
        update_response = self.client.patch(
            f"/api/auth/users/{self.linked_assistant['id']}",
            json={
                "nome": "Auxiliar atualizado",
                "password": REPLACEMENT_ASSISTANT_PASSWORD,
            },
            headers=self.authorization_for(self.system_owner),
        )
        replacement_login = self.client.post(
            "/api/auth/login",
            json={
                "email": self.linked_assistant["email"],
                "password": REPLACEMENT_ASSISTANT_PASSWORD,
            },
        )
        original_login = self.client.post(
            "/api/auth/login",
            json={
                "email": self.linked_assistant["email"],
                "password": ORIGINAL_ASSISTANT_PASSWORD,
            },
        )
        deactivate_response = self.client.delete(
            f"/api/auth/users/{self.linked_assistant['id']}",
            headers=self.authorization_for(self.system_owner),
        )

        self.assertEqual(200, update_response.status_code)
        self.assertEqual("Auxiliar atualizado", update_response.json()["user"]["nome"])
        self.assertEqual(200, replacement_login.status_code)
        self.assertEqual(401, original_login.status_code)
        self.assertEqual(200, deactivate_response.status_code)
        self.assertEqual("inativo", deactivate_response.json()["user"]["status"])

    def test_team_owner_can_update_and_deactivate_own_regular_member(self) -> None:
        update_response = self.client.patch(
            f"/api/auth/users/{self.regular_member['id']}",
            json={"nome": "Membro atualizado"},
            headers=self.authorization_for(self.team_owner),
        )
        deactivate_response = self.client.delete(
            f"/api/auth/users/{self.regular_member['id']}",
            headers=self.authorization_for(self.team_owner),
        )

        self.assertEqual(200, update_response.status_code)
        self.assertEqual("Membro atualizado", update_response.json()["user"]["nome"])
        self.assertEqual(200, deactivate_response.status_code)
        self.assertEqual("inativo", deactivate_response.json()["user"]["status"])

    def test_team_owner_cannot_manage_member_from_another_team(self) -> None:
        attempts = (
            ("PATCH", {"nome": "Membro invadido"}),
            ("DELETE", None),
        )
        for method, payload in attempts:
            with self.subTest(method=method):
                response = self.client.request(
                    method,
                    f"/api/auth/users/{self.other_team_member['id']}",
                    json=payload,
                    headers=self.authorization_for(self.team_owner),
                )
                self.assertEqual(403, response.status_code)

        other_member_profile = self.client.get(
            "/api/auth/me",
            headers=self.authorization_for(self.other_team_member),
        )
        self.assertEqual(200, other_member_profile.status_code)
        self.assertEqual("other-team-member", other_member_profile.json()["user"]["nome"])
        self.assertEqual("ativo", other_member_profile.json()["user"]["status"])

    @staticmethod
    def authorization_for(actor: dict) -> dict[str, str]:
        return {"Authorization": f"Bearer {auth_router.create_token(actor)}"}
