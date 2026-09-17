"""AUD-03: exercise every administrative-finance HTTP operation with synthetic data."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.core.tenant import write_json_file
from app.modules.admin_finance import repository as storage, router as finance
from app.modules.admin_finance.schemas import AdminPermissionPatch
from app.modules.auth import router as auth


FLAGS = tuple(AdminPermissionPatch.model_fields)
DENIED = dict.fromkeys(FLAGS, False)
OWNER = {"id": "audit-owner", "email": "owner@example.invalid", "nome": "Owner",
         "role": "owner", "systemAdmin": True, "systemAdminRole": "owner", "status": "ativo"}
ASSISTANT = {**OWNER, "id": "audit-assistant", "email": "assistant@example.invalid",
             "systemAdminRole": "assistant"}
PAYMENT = {"customerId": "synthetic-customer", "customerName": "Synthetic",
           "grossCents": 100, "dueAt": "2026-09-01"}
EXPENSE = {"title": "Synthetic expense", "amountCents": 100,
           "categoryId": "cat_infra", "dueAt": "2026-09-01"}
SUBSCRIPTION = {"customerId": "synthetic-customer", "customerName": "Synthetic",
                "planId": "plan_equipe", "startedAt": "2026-09-01",
                "currentPeriodStart": "2026-09-01", "currentPeriodEnd": "2026-09-30"}
GOAL = {"name": "Synthetic goal", "metric": "revenue", "targetCents": 100,
        "startAt": "2026-09-01", "endAt": "2026-09-30"}
BUDGET = {"name": "Synthetic budget", "limitCents": 100, "startAt": "2026-09-01"}


def cases():
    """Independent acceptance matrix: method, path, payload, required flags."""
    rows = []
    for path in ("/dashboard", "/cash-flow", "/plans", "/subscriptions", "/payments",
                 "/expenses", "/goals", "/budgets", "/settings", "/audit", "/jorro/status"):
        rows.append(("GET", path, None, ("view",)))
    for collection, flag, payload, record_id in (
        ("plans", "managePlans", {"code": "synthetic", "name": "Synthetic"}, "plan_free"),
        ("subscriptions", "manageSubscriptions", SUBSCRIPTION, "subscription-synthetic"),
        ("payments", "managePayments", PAYMENT, "payment-synthetic"),
        ("expenses", "manageExpenses", EXPENSE, "expense-synthetic"),
        ("goals", "manageSettings", GOAL, "goal-synthetic"),
        ("budgets", "manageSettings", BUDGET, "budget-synthetic"),
    ):
        rows.extend((("POST", f"/{collection}", payload, (flag,)),
                     ("PATCH", f"/{collection}/{record_id}", {}, (flag,)),
                     ("DELETE", f"/{collection}/{record_id}", None, (flag,))))
    for kind, record_id in (("categories", "cat_infra"), ("suppliers", "supplier-synthetic"),
                            ("cost-centers", "cc_admin"), ("providers", "provider_jorro")):
        rows.extend((("GET", f"/references/{kind}", None, ("view",)),
                     ("POST", f"/references/{kind}", {"name": "Synthetic"}, ("manageSettings",)),
                     ("PATCH", f"/references/{kind}/{record_id}", {}, ("manageSettings",)),
                     ("DELETE", f"/references/{kind}/{record_id}", None, ("manageSettings",))))
    rows.extend((
        ("POST", "/plans/plan_free/duplicate", None, ("managePlans",)),
        ("POST", "/expenses/expense-synthetic/duplicate", None, ("manageExpenses",)),
        ("POST", "/expenses/bulk-status", {"ids": ["expense-synthetic"], "status": "paid"}, ("manageExpenses",)),
        ("PUT", "/settings", {}, ("manageSettings",)),
        ("GET", "/permissions/audit-assistant", None, ("owner",)),
        ("PUT", "/permissions/audit-assistant", DENIED, ("owner",)),
        ("POST", "/import/preview?fileName=synthetic.csv", b"title;amount\nSynthetic;1", ("importData",)),
        ("POST", "/jorro/sync", None, ("importData", "manageExpenses", "manageSettings")),
    ))
    for kind, flag in (("payments", "managePayments"), ("expenses", "manageExpenses"), ("jorro", "manageExpenses")):
        rows.append(("POST", "/import/commit", {"kind": kind, "rows": [], "mapping": []}, ("importData", flag)))
    for suffix in ("csv", "xlsx", "pdf"):
        rows.append(("GET", f"/export/{suffix}", None, ("exportData",)))
    return rows


class AdminFinanceAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aud03-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "finance.json"
        self.repo = storage.AdminFinanceRepository()
        for patcher in (patch.object(storage, "DB_PATH", str(self.path)), patch.object(finance, "repository", self.repo)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(finance.router)
        self.actor = copy.deepcopy(ASSISTANT)
        self.app.dependency_overrides[auth.current_user] = lambda: self.actor

    def reset_store(self, permissions=None):
        store = storage.default_store()
        store["adminPermissions"] = {ASSISTANT["id"]: dict(permissions if permissions is not None else DENIED)}
        for collection, model, payload, identifier in (
            ("payments", finance.PaymentInput, PAYMENT, "payment-synthetic"),
            ("expenses", finance.ExpenseInput, EXPENSE, "expense-synthetic"),
            ("subscriptions", finance.SubscriptionInput, SUBSCRIPTION, "subscription-synthetic"),
            ("goals", finance.GoalInput, GOAL, "goal-synthetic"),
            ("budgets", finance.BudgetInput, BUDGET, "budget-synthetic"),
            ("suppliers", finance.ReferenceInput, {"name": "Synthetic"}, "supplier-synthetic"),
        ):
            store[collection] = [{"id": identifier, **model(**payload).model_dump(mode="json")}]
        write_json_file(self.path, store)

    async def request(self, method, path, payload):
        kwargs = {"content": payload} if isinstance(payload, bytes) else {"json": payload} if payload is not None else {}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://audit.local") as client:
            return await client.request(method, "/api/admin/finance" + path, **kwargs)

    def test_matrix_covers_every_registered_route_and_method(self):
        covered = set()
        for method, path, _, _ in cases():
            scope = {"type": "http", "method": method, "path": "/api/admin/finance" + path.split("?")[0]}
            matches = [route for route in finance.router.routes if route.matches(scope)[0].name == "FULL"]
            self.assertTrue(matches, (method, path))
            covered.add((method, matches[0].path))
        expected = {(method, route.path) for route in finance.router.routes for method in route.methods}
        self.assertEqual(covered, expected)

    async def test_all_false_denies_every_operation_without_any_file_mutation(self):
        for method, path, payload, _ in cases():
            with self.subTest(method=method, path=path):
                self.reset_store()
                before = self.path.read_bytes()
                response = await self.request(method, path, payload)
                self.assertEqual(response.status_code, 403, response.text[:200])
                self.assertEqual(self.path.read_bytes(), before)

    async def test_each_individual_flag_grants_only_its_operation(self):
        for flag in FLAGS:
            for method, path, payload, required in cases():
                with self.subTest(flag=flag, method=method, path=path):
                    self.reset_store({**DENIED, flag: True})
                    before = self.path.read_bytes()
                    response = await self.request(method, path, payload)
                    if required == (flag,):
                        self.assertIn(response.status_code, (200, 201), response.text[:200])
                    else:
                        self.assertEqual(response.status_code, 403, response.text[:200])
                        self.assertEqual(self.path.read_bytes(), before)

    async def test_owner_bypasses_financial_flags_on_every_operation(self):
        self.actor = copy.deepcopy(OWNER)
        for method, path, payload, _ in cases():
            with self.subTest(method=method, path=path):
                self.reset_store()
                response = await self.request(method, path, payload)
                self.assertIn(response.status_code, (200, 201), response.text[:200])

    async def test_import_requires_import_flag_and_the_selected_collection(self):
        for kind, allowed, denied in (("expenses", "manageExpenses", "managePayments"),
                                      ("payments", "managePayments", "manageExpenses"),
                                      ("jorro", "manageExpenses", "managePayments")):
            for flag in (allowed, denied):
                with self.subTest(kind=kind, flag=flag):
                    self.reset_store({**DENIED, "importData": True, flag: True})
                    before = self.path.read_bytes()
                    payload = {"kind": kind, "rows": [], "mapping": []}
                    response = await self.request("POST", "/import/commit", payload)
                    self.assertEqual(response.status_code, 200 if flag == allowed else 403)
                    if flag == denied:
                        self.assertEqual(self.path.read_bytes(), before)

    async def test_authorized_import_creates_rows_and_cannot_switch_collection(self):
        self.reset_store({**DENIED, "importData": True, "manageExpenses": True})
        payload = {"kind": "expenses", "rows": [{"title": "Imported synthetic", "value": "3.50"}],
                   "mapping": [{"sourceColumn": "title", "targetField": "title"},
                               {"sourceColumn": "value", "targetField": "amountCents"}]}
        response = await self.request("POST", "/import/commit", payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["created"], 1)
        self.assertEqual(len((await self.repo.read())["expenses"]), 2)
        before = self.path.read_bytes()
        payload["kind"] = "payments"
        self.assertEqual((await self.request("POST", "/import/commit", payload)).status_code, 403)
        self.assertEqual(self.path.read_bytes(), before)

    async def test_sync_requires_all_three_permissions_even_when_disabled(self):
        flags = {**DENIED, "importData": True, "manageExpenses": True, "manageSettings": True}
        for removed in (None, "importData", "manageExpenses", "manageSettings"):
            with self.subTest(removed=removed):
                self.reset_store({**flags, **({removed: False} if removed else {})})
                response = await self.request("POST", "/jorro/sync", None)
                self.assertEqual(response.status_code, 403 if removed else 200)

    async def test_denial_never_initializes_or_migrates_a_store(self):
        self.assertFalse(self.path.exists())
        self.assertEqual((await self.request("GET", "/payments", None)).status_code, 403)
        self.assertFalse(self.path.exists())
        self.reset_store()
        store = storage.default_store()
        store["payments"] = [{"id": "demo_legacy", **PAYMENT}]
        write_json_file(self.path, store)
        before = self.path.read_bytes()
        self.assertEqual((await self.request("GET", "/payments", None)).status_code, 403)
        self.assertEqual(self.path.read_bytes(), before)

    async def test_owner_grant_and_revocation_take_effect_on_the_next_request(self):
        self.reset_store()
        self.actor = copy.deepcopy(OWNER)
        response = await self.request("PUT", "/permissions/audit-assistant", {"managePayments": True})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["permissions"]["view"])
        self.actor = copy.deepcopy(ASSISTANT)
        self.assertEqual((await self.request("POST", "/payments", PAYMENT)).status_code, 201)
        self.assertEqual((await self.request("GET", "/payments", None)).status_code, 403)
        self.actor = copy.deepcopy(OWNER)
        self.assertEqual((await self.request("PUT", "/permissions/audit-assistant", DENIED)).status_code, 200)
        self.actor = copy.deepcopy(ASSISTANT)
        before = self.path.read_bytes()
        self.assertEqual((await self.request("POST", "/payments", PAYMENT)).status_code, 403)
        self.assertEqual(self.path.read_bytes(), before)

    async def test_missing_permissions_fail_closed_and_non_admin_never_bypasses(self):
        for actor, flags in ((ASSISTANT, {}), ({**ASSISTANT, "systemAdmin": False, "systemAdminRole": "", "role": "owner"}, dict.fromkeys(FLAGS, True))):
            self.actor = actor
            self.reset_store(flags)
            self.assertEqual((await self.request("GET", "/payments", None)).status_code, 403)

    async def test_assistant_cannot_elevate_self_another_id_or_owner_via_permissions_route(self):
        self.reset_store(dict.fromkeys(FLAGS, True))
        before = self.path.read_bytes()
        for identifier in (ASSISTANT["id"], OWNER["id"], "another-assistant"):
            for method in ("GET", "PUT"):
                response = await self.request(method, "/permissions/" + identifier, dict.fromkeys(FLAGS, True) if method == "PUT" else None)
                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.path.read_bytes(), before)

    async def test_payload_or_record_id_cannot_select_another_actors_permissions(self):
        self.reset_store({**DENIED, "managePayments": True})
        before = self.path.read_bytes()
        for injected in ({"systemAdminRole": "owner"}, {"adminPermissions": dict.fromkeys(FLAGS, True)}, {"userId": OWNER["id"]}):
            response = await self.request("POST", "/payments", {**PAYMENT, **injected})
            self.assertEqual(response.status_code, 422)
        for identifier in (OWNER["id"], "payment-synthetic"):
            response = await self.request("DELETE", "/expenses/" + identifier, None)
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.path.read_bytes(), before)

    async def test_real_session_uses_persisted_actor_not_query_or_headers(self):
        self.app.dependency_overrides.clear()
        self.reset_store()
        token = auth.create_token(ASSISTANT)
        users = {"users": [OWNER, ASSISTANT]}
        with patch.object(auth, "read_user_store", AsyncMock(return_value=users)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://audit.local") as client:
                response = await client.post("/api/admin/finance/payments?userId=audit-owner", json=PAYMENT,
                                            headers={"Authorization": "Bearer " + token, "X-User-Id": "audit-owner"})
                self.assertEqual(response.status_code, 403)
                anonymous = await client.get("/api/admin/finance/payments")
                self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(len((await self.repo.read())["payments"]), 1)


class AdminFinancePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aud01-admin-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "finance.json"
        patcher = patch.object(storage, "DB_PATH", str(self.path))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = storage.AdminFinanceRepository()

    def test_invalid_shapes_and_null_never_become_defaults_or_overwrite(self):
        for content in (b"null", b"[]", b"{broken", b'{"payments": {}}', b'{"settings": []}',
                        b'{"adminPermissions": []}', b'{"payments": [null]}', b'{"schemaVersion": 999}',
                        b'{"adminPermissions": {"audit-assistant": {"view": "false"}}}'):
            with self.subTest(content=content):
                self.path.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    self.repo._read_sync()
                self.assertEqual(self.path.read_bytes(), content)

    def test_proven_missing_initializes_but_valid_empty_collections_stay_empty(self):
        self.assertFalse(self.path.exists())
        self.assertEqual(self.repo._read_sync()["payments"], [])
        self.assertTrue(self.path.exists())
        content = b'{"schemaVersion": 1, "payments": [], "plans": []}'
        self.path.write_bytes(content)
        self.assertEqual(self.repo._read_sync()["plans"], [])
        self.assertEqual(self.path.read_bytes(), content)

    def test_io_failure_does_not_write_and_restoring_good_copy_recovers(self):
        store = storage.default_store()
        write_json_file(self.path, store)
        original = self.path.read_bytes()
        with patch.object(storage, "read_json_file", side_effect=RuntimeError("controlled IO failure")), patch.object(storage, "write_json_file") as writer:
            with self.assertRaises(RuntimeError):
                self.repo._read_sync()
            writer.assert_not_called()
        self.assertEqual(self.path.read_bytes(), original)
        self.path.write_bytes(b"null")
        with self.assertRaises(RuntimeError):
            self.repo._read_sync()
        self.path.write_bytes(original)
        self.assertEqual(self.repo._read_sync(), store)
