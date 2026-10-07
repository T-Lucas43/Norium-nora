"""AUD-02: real account creation, login, HTTP and WebSocket authorization."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from starlette.requests import Request

from app.modules.auth import router as auth
from app.modules.team import router as team


class TeamMemberAccessAuditTests(unittest.TestCase):
    def setUp(self):
        if not os.getenv("NORIUM_DATA_DIR") or os.getenv("PYTHON_DOTENV_DISABLED") != "1":
            raise RuntimeError("Use the isolated backend audit runner.")
        self.temp = tempfile.TemporaryDirectory(prefix="aud02_")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.users_path = self.root / "users.json"
        self.password = "Synthetic-password-42!"
        self.owners = [self.account("owner-a"), self.account("owner-b")]
        self.write_store({"users": self.owners, "teams": [], "adminAudit": [], "systemOwnerId": None})
        for target, name, value in (
            (auth, "USERS_DB_PATH", self.users_path),
            (team, "UPLOAD_DIR", self.root / "uploads"),
            (team, "team_chat_path", lambda owner: str(self.root / f"{owner}-chat.json")),
            (team, "manager", team.PresenceManager()),
            (team, "_call_coordinator_instance", None),
            (team, "CALL_RECONCILE_INTERVAL_SECONDS", 0.2),
            (team, "record_team_event", AsyncMock()),
            (team, "read_profile_db", lambda *_: {}),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch("app.modules.auth.email_router.request_action", AsyncMock())
        patcher.start()
        self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(auth.router)
        app.include_router(team.router)
        self.client = self.enterContext(TestClient(app))
        self.owner_headers = self.login("owner-a")
        self.other_headers = self.login("owner-b")
        created = self.client.post("/api/auth/users", headers=self.owner_headers, json={
            "nome": "Synthetic member", "email": "member@example.test", "password": self.password,
            "permissions": {"chat": True, "equipe": True, "admin": True},
            "role": "owner", "plan": "enterprise", "teamOwnerId": "owner-b",
        })
        self.assertEqual(200, created.status_code, created.text)
        self.member = created.json()["user"]
        self.headers = self.login("member")

    def account(self, name):
        return {"id": name, "nome": name, "email": f"{name}@example.test",
                "passwordHash": auth.hash_password(self.password), "role": "owner", "plan": "equipe",
                "status": "ativo", "sessionVersion": 0, "teamOwnerId": None, "createdBy": None,
                "systemAdmin": False, "systemAdminRole": None,
                "permissions": auth.permissions_for_plan("equipe")}

    def write_store(self, store):
        self.users_path.write_text(json.dumps(store), encoding="utf-8")

    def mutate_user(self, user_id, **changes):
        store = json.loads(self.users_path.read_text(encoding="utf-8"))
        user = next(user for user in store["users"] if user["id"] == user_id)
        user.update(changes)
        self.write_store(store)

    def login(self, name):
        response = self.client.post("/api/auth/login", json={"email": f"{name}@example.test", "password": self.password})
        self.assertEqual(200, response.status_code, response.text)
        return {"Authorization": "Bearer " + response.json()["token"]}

    def socket(self, headers):
        response = self.client.post("/api/auth/websocket-ticket", headers=headers)
        self.assertEqual(200, response.status_code, response.text)
        return self.client.websocket_connect("/api/team-chat/ws?ticket=" + response.json()["ticket"])

    def receive_until(self, socket, event):
        for _ in range(20):
            payload = socket.receive_json()
            if payload.get("type") == event:
                return payload
        self.fail(f"Missing socket event {event}")

    def test_normal_member_can_chat_and_join_call_without_management_or_cross_team_access(self):
        self.assertEqual("member", self.member["role"])
        self.assertEqual("owner-a", self.member["teamOwnerId"])
        self.assertFalse(self.member["permissions"]["equipe"])
        self.assertFalse(self.member["permissions"]["admin"])
        listing = self.client.get("/api/team-chat/members", headers=self.headers)
        self.assertEqual(200, listing.status_code, listing.text)
        self.assertEqual({"owner-a", self.member["id"]}, {item["id"] for item in listing.json()["members"]})
        sent = self.client.post("/api/team-chat/messages", headers=self.headers, json={"text": "Synthetic team message"})
        self.assertEqual(200, sent.status_code, sent.text)
        outsider = self.client.post("/api/team-chat/messages", headers=self.headers, json={"text": "Blocked", "scope": "direct", "recipientId": "owner-b"})
        self.assertIn(outsider.status_code, (403, 404))
        for method, route, payload in (
            ("GET", "/api/auth/users", None), ("GET", "/api/auth/admin/overview", None),
            ("PATCH", "/api/auth/team-profile", {"name": "Escalation"}),
            ("POST", "/api/auth/users", {"nome": "Blocked", "email": "blocked@example.test", "password": self.password}),
            ("PATCH", "/api/auth/users/owner-b", {"status": "inativo", "systemAdmin": True}),
        ):
            response = self.client.request(method, route, headers=self.headers, json=payload)
            self.assertEqual(403, response.status_code, (route, response.text))
        with self.socket(self.owner_headers) as owner_socket:
            self.receive_until(owner_socket, "CALLS_STATE")
            with self.socket(self.headers) as member_socket:
                self.receive_until(member_socket, "CALLS_STATE")
                owner_socket.send_json({"type": "CALL_INVITE", "callId": "call_0123456789abcdef", "scope": "team", "clientId": "owner-tab"})
                self.receive_until(member_socket, "CALL_INVITE")
                member_socket.send_json({"type": "CALL_ACCEPT", "callId": "call_0123456789abcdef", "clientId": "member-tab"})
                self.receive_until(member_socket, "CALL_ACK")
                state = self.client.get("/api/team-chat/calls/active", headers=self.headers)
                self.assertEqual(200, state.status_code, state.text)
                self.assertIn(self.member["id"], state.json()["calls"][0]["joinedUserIds"])
                forbidden = self.client.get("/api/team-chat/calls/call_0123456789abcdef/messages?clientId=foreign-tab", headers=self.other_headers)
                self.assertIn(forbidden.status_code, (403, 404))

    def test_owner_revocation_denies_http_and_socket(self):
        original = json.loads(self.users_path.read_text(encoding="utf-8"))
        for changes in ({"status": "inativo"}, {"plan": "individual"}, {"plan": "free"}):
            with self.subTest(changes=changes):
                self.write_store(copy.deepcopy(original))
                self.mutate_user("owner-a", **changes)
                response = self.client.get("/api/team-chat/members", headers=self.headers)
                self.assertEqual(403, response.status_code, response.text)
                with self.assertRaises(WebSocketDisconnect):
                    with self.socket(self.headers) as socket:
                        socket.receive_json()

    def test_member_inactivation_removal_and_logout_revoke_existing_token(self):
        response = self.client.patch(f"/api/auth/users/{self.member['id']}", headers=self.owner_headers, json={"status": "inativo"})
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual(401, self.client.get("/api/team-chat/members", headers=self.headers).status_code)
        response = self.client.patch(f"/api/auth/users/{self.member['id']}", headers=self.owner_headers, json={"status": "ativo"})
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual(401, self.client.get("/api/team-chat/members", headers=self.headers).status_code)
        self.headers = self.login("member")
        live_store = json.loads(self.users_path.read_text(encoding="utf-8"))
        live_member = next(user for user in live_store["users"] if user["id"] == self.member["id"])
        parallel_headers = {"Authorization": f"Bearer {auth.create_token(live_member)}"}
        self.assertEqual(200, self.client.post("/api/auth/logout", headers=self.headers).status_code)
        self.assertEqual(401, self.client.get("/api/team-chat/members", headers=self.headers).status_code)
        self.assertEqual(200, self.client.get("/api/team-chat/members", headers=parallel_headers).status_code)
        self.headers = self.login("member")
        self.assertEqual(200, self.client.delete(f"/api/auth/users/{self.member['id']}", headers=self.owner_headers).status_code)
        self.assertEqual(401, self.client.get("/api/team-chat/members", headers=self.headers).status_code)

    def test_detached_member_is_not_reattached_by_legacy_migration(self):
        self.mutate_user(self.member["id"], teamOwnerId=None)
        response = self.client.get("/api/team-chat/members", headers=self.headers)
        self.assertEqual(403, response.status_code, response.text)
        store = json.loads(self.users_path.read_text(encoding="utf-8"))
        user = next(user for user in store["users"] if user["id"] == self.member["id"])
        self.assertIsNone(user["teamOwnerId"])

    def test_existing_socket_stops_after_owner_plan_member_status_or_session_revocation(self):
        original = json.loads(self.users_path.read_text(encoding="utf-8"))
        for user_id, changes in (("owner-a", {"plan": "free"}),
                                 (self.member["id"], {"status": "inativo"}),
                                 (self.member["id"], {"sessionVersion": 1}),
                                 (self.member["id"], {"teamOwnerId": "owner-b"})):
            with self.subTest(user_id=user_id, changes=changes):
                self.write_store(copy.deepcopy(original))
                with self.socket(self.headers) as socket:
                    self.receive_until(socket, "CALLS_STATE")
                    self.mutate_user(user_id, **changes)
                    socket.send_json({"type": "PING"})
                    with self.assertRaises(WebSocketDisconnect) as closed:
                        self.receive_until(socket, "ACK")
                    self.assertEqual(4403, closed.exception.code)

    def test_idempotency_guard_revalidates_owner_before_replay(self):
        from app.bootstrap import idempotency_identity
        request = Request({"type": "http", "method": "POST", "path": "/api/team-chat/messages", "headers": []})
        token = self.headers["Authorization"].removeprefix("Bearer ")
        self.assertEqual(self.member["id"], self.client.portal.call(idempotency_identity, request, token))
        self.mutate_user("owner-a", plan="free")
        self.assertIsNone(self.client.portal.call(idempotency_identity, request, token))
