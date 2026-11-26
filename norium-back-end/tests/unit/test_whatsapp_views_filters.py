import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.modules.auth import router as auth
from app.modules.business import router as business, whatsapp_views as views, store
from app.modules.chat import router as chat
from app.modules.chat.conversation_projection import list_page
from app.modules.chat import list_filters
from app.modules.chat.history import binding_signature
from app.modules.whatsapp_team import access, repository, service
from tests.unit.test_whatsapp_team import Fixture


class ViewTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.actor = self.owner
        self.scope = repository.Scope("owner", "primary", "owner", binding_signature("synthetic-instance", 1))
        self.owner_access = access.Access(self.owner, self.owner, self.scope, self.roster)
        for mocked in (patch.object(chat, "read_user_store", AsyncMock(return_value={"users": list(self.roster)})),
                       patch.object(chat, "wapi_owned_binding", return_value=SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=1))):
            mocked.start(); self.addCleanup(mocked.stop)
        app = FastAPI(); app.include_router(views.router); app.include_router(business.router)
        app.dependency_overrides[auth.current_user] = lambda: self.actor
        self.client = TestClient(app); self.addCleanup(self.client.close)
        self.base = "/api/business/whatsapp-views"

    def create(self, *, team=False, shared=False, filters=None):
        return self.client.post(self.base, json={"name": "Synthetic view", "scope": "team" if shared else "personal",
            "filters": filters or {}, **({"inboxId": self.scope.inbox_id} if team else {})})

    def test_personal_views_reuse_existing_store_and_never_appear_in_clients(self):
        result = self.create()
        self.assertEqual(201, result.status_code, result.text)
        self.assertEqual(1, len(store.snapshot(self.owner, "saved_views")["items"]))
        self.assertEqual(1, len(self.client.get(self.base).json()["items"]))
        self.assertEqual([], self.client.get("/api/business/client-views").json()["items"])
        self.actor = self.alice
        self.assertEqual([], self.client.get(self.base).json()["items"])

    def test_clients_cannot_edit_whatsapp_view_even_with_known_id(self):
        identifier = self.create().json()["item"]["id"]
        response = self.client.put(f"/api/business/client-views/personal/{identifier}", json={"name": "Wrong kind", "filters": {}, "expectedVersion": 1})
        self.assertEqual(404, response.status_code, response.text)
        self.assertEqual(404, self.client.delete(f"/api/business/client-views/personal/{identifier}?expectedVersion=1").status_code)

    def test_updates_and_deletes_require_exact_version_and_context(self):
        identifier = self.create().json()["item"]["id"]
        path = f"{self.base}/personal/{identifier}"
        result = self.client.put(path, json={"name": "Updated", "filters": {"unread": True}, "expectedVersion": 1})
        self.assertEqual(200, result.status_code, result.text)
        self.assertEqual(2, result.json()["item"]["version"])
        self.assertEqual(409, self.client.delete(path + "?expectedVersion=1").status_code)
        self.assertEqual(200, self.client.delete(path + "?expectedVersion=2").status_code)

    def test_shared_views_require_enabled_box_and_manager(self):
        self.assertEqual(403, self.create(shared=True).status_code)
        self.assertEqual(404, self.create(team=True, shared=True).status_code)
        self.enable()
        result = self.create(team=True, shared=True)
        self.assertEqual(201, result.status_code, result.text)
        self.actor = self.alice
        self.assertEqual(403, self.create(team=True, shared=True).status_code)
        result = self.client.get(self.base + "?inboxId=" + self.scope.inbox_id)
        self.assertEqual(1, len(result.json()["items"]))
        self.assertFalse(result.json()["canShare"])
        self.assertFalse(result.json()["items"][0]["canEdit"])
        self.assertEqual([], self.client.get(self.base).json()["items"])

    def test_shared_view_author_cannot_be_edited_by_another_attendant(self):
        self.enable()
        row = self.create(team=True, shared=True).json()["item"]
        self.actor = self.alice
        payload = {"name": "Wrong", "scope": "team", "inboxId": self.scope.inbox_id, "filters": {}, "expectedVersion": 1}
        self.assertEqual(403, self.client.put(f"{self.base}/team/{row['id']}", json=payload).status_code)

    def test_filter_validation_rejects_invalid_dates_ranges_and_extra_fields(self):
        for filters in ({"fromDate": "2026-02-30"}, {"fromDate": "20261021"}, {"toDate": "2101-01-01"},
                        {"fromDate": "2026-10-22", "toDate": "2026-10-21"}, {"kind": "foreign"},
                        {"unread": "true"}, {"tagIds": ["x"] * 21}, {"ownerId": "another"}):
            self.assertEqual(422, self.create(filters=filters).status_code)
        self.assertEqual([], store.snapshot(self.owner, "saved_views")["items"])


class FilterTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_json_unknown_filters_and_personal_assignment_rejected(self):
        for encoded in ("{", '{"unknown":1}', '{"responsavel":"me"}', '{"estado":"resolved"}'):
            with self.assertRaises(Exception) as result:
                await list_filters.options({"id": "synthetic"}, encoded)
            self.assertEqual(422, result.exception.status_code)

    async def test_period_includes_entire_last_day_in_brazil_timezone(self):
        values, matching = await list_filters.options({"id": "synthetic"}, json.dumps({"fromDate": "2026-10-21", "toDate": "2026-10-21"}))
        self.assertIsNone(matching)
        self.assertEqual(86400, values["toTs"] - values["fromTs"])
        self.assertTrue(list_filters.matches("x", {"timestampUltimaMsg": values["toTs"] - 1}, values, None))
        self.assertFalse(list_filters.matches("x", {"timestampUltimaMsg": values["toTs"]}, values, None))

    async def test_labels_reuse_existing_business_projection(self):
        with patch.object(business, "tagged_conversations", AsyncMock(return_value={"ids": ["visible"]})) as query:
            values, allowed = await list_filters.options({"id": "synthetic"}, '{"tagIds":["vip"]}')
        self.assertEqual({"visible"}, allowed)
        self.assertEqual("vip", query.await_args.kwargs["tagIds"])
        self.assertFalse(list_filters.matches("other", {}, values, allowed))

    async def test_filters_happen_before_total_and_offset_not_on_first_page(self):
        rows = {f"individual-{number}": {"contato": str(number), "esGrupo": False, "naoLidasCount": 0} for number in range(300)}
        rows["group"] = {"contato": "Group", "esGrupo": True, "naoLidasCount": 4, "timestampUltimaMsg": 100}
        result = list_page(chat, rows, {}, offset=0, limit=1, filters={"kind": "group", "unread": True})
        self.assertEqual(1, result["total"])
        self.assertEqual("group", result["items"][0]["id"])
        self.assertIsNone(result["nextOffset"])
