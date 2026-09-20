import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.core.tenant import write_json_file
from app.modules.admin_finance import repository as storage, router as finance
from app.modules.auth import router as auth


OWNER = {
    "id": "owner",
    "email": "owner@example.invalid",
    "role": "owner",
    "systemAdmin": True,
    "systemAdminRole": "owner",
    "status": "ativo",
}


class FinanceReferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aud07-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "finance.json"
        self.repo = storage.AdminFinanceRepository()
        for patcher in (patch.object(storage, "DB_PATH", str(self.path)), patch.object(finance, "repository", self.repo)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(finance.router)
        self.app.dependency_overrides[auth.current_user] = lambda: copy.deepcopy(OWNER)

    async def post(self, payload):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://audit.local") as client:
            return await client.post("/api/admin/finance/payments", json=payload)

    async def test_nonexistent_references_are_rejected_without_mutation(self):
        store = storage.default_store()
        write_json_file(self.path, store)
        before = self.path.read_bytes()
        response = await self.post({
            "customerId": "missing-customer",
            "customerName": "Synthetic",
            "subscriptionId": "missing-subscription",
            "planId": "missing-plan",
            "grossCents": 100,
            "dueAt": "2026-09-01",
        })
        self.assertEqual(422, response.status_code)
        self.assertEqual(before, self.path.read_bytes())

    async def test_subscription_customer_and_plan_must_match(self):
        store = storage.default_store()
        store["subscriptions"] = [{
            "id": "subscription-ok",
            "customerId": "customer-ok",
            "customerName": "Synthetic",
            "planId": "plan_equipe",
        }]
        write_json_file(self.path, store)
        base = {
            "customerName": "Synthetic",
            "subscriptionId": "subscription-ok",
            "grossCents": 100,
            "dueAt": "2026-09-01",
        }
        self.assertEqual(422, (await self.post({**base, "customerId": "other"})).status_code)
        self.assertEqual(422, (await self.post({**base, "customerId": "customer-ok", "planId": "plan_free"})).status_code)
        response = await self.post({**base, "customerId": "customer-ok"})
        self.assertEqual(201, response.status_code)
        self.assertEqual("plan_equipe", response.json()["item"]["planId"])


if __name__ == "__main__":
    unittest.main()
