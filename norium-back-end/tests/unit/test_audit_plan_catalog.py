import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.auth import router as auth
from app.modules.admin_finance.repository import default_plans
from app.shared.plan_catalog import public_plan_catalog, seat_limit


class PlanCatalogTests(unittest.TestCase):
    def test_auth_and_finance_are_derived_from_same_catalog(self):
        public = {item["code"]: item for item in public_plan_catalog()}
        finance = {item["code"]: item for item in default_plans()}
        self.assertEqual(set(public), set(finance))
        for code, item in public.items():
            self.assertEqual(finance[code]["monthlyPriceCents"], item["monthlyPrice"] * 100)
            self.assertEqual(finance[code]["limits"]["users"], item["teamSeats"])

    def test_active_seat_limit_is_enforced_atomically(self):
        with tempfile.TemporaryDirectory(prefix="aud14-") as directory:
            users_path = Path(directory) / "users.json"
            password = "Synthetic-password-42!"
            owner = {
                "id": "owner", "nome": "Owner", "email": "owner@example.test",
                "passwordHash": auth.hash_password(password), "role": "owner", "plan": "equipe",
                "status": "ativo", "sessionVersion": 0, "teamOwnerId": None,
                "systemAdmin": False, "systemAdminRole": None,
                "permissions": auth.permissions_for_plan("equipe"),
            }
            users = [owner] + [
                {
                    "id": f"member-{index}", "nome": f"Member {index}", "email": f"member-{index}@example.test",
                    "passwordHash": auth.hash_password(password), "role": "member", "plan": "individual",
                    "status": "ativo", "sessionVersion": 0, "teamOwnerId": "owner",
                    "systemAdmin": False, "systemAdminRole": None, "permissions": {},
                }
                for index in range(seat_limit("equipe") - 1)
            ]
            users_path.write_text(json.dumps({"users": users, "teams": [], "adminAudit": []}), encoding="utf-8")
            with patch.object(auth, "USERS_DB_PATH", users_path), patch.dict(os.environ, {"ENVIRONMENT": "test"}):
                app = FastAPI()
                app.include_router(auth.router)
                with TestClient(app) as client:
                    login = client.post("/api/auth/login", json={"email": owner["email"], "password": password})
                    headers = {"Authorization": "Bearer " + login.json()["token"]}
                    response = client.post("/api/auth/users", headers=headers, json={
                        "nome": "Overflow", "email": "overflow@example.test", "password": password,
                    })
            self.assertEqual(409, response.status_code)
            persisted = json.loads(users_path.read_text(encoding="utf-8"))
            self.assertEqual(seat_limit("equipe"), len(persisted["users"]))


if __name__ == "__main__":
    unittest.main()
