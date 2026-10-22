from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.request_context import set_request_context, reset_request_context
from app.modules.auth import router as auth
from app.modules.business import router as business, store
from app.modules.business.whatsapp_tag_batch import change
from app.modules.chat import bulk, router as chat
from app.modules.chat.history import binding_signature
from app.modules.whatsapp_team import access, repository, service
from app.services import conversation_store
from tests.unit.test_whatsapp_team import Fixture


class BulkTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.scope = repository.Scope("owner", "primary", "owner", binding_signature("synthetic-instance", 1))
        self.owner_access = access.Access(self.owner, self.owner, self.scope, self.roster)
        self.actor = self.owner
        self.directory = {"users": list(self.roster)}
        self.database = {key: {"id": key, "contato": key, "mensagens": [], "lida": False, "naoLidasCount": 3} for key in ("a", "b")}
        self.index = {key: frozenset({key}) for key in self.database}
        for mock in (
            patch.object(chat, "read_user_store", AsyncMock(side_effect=lambda: copy.deepcopy(self.directory))),
            patch.object(chat, "wapi_owned_binding", return_value=SimpleNamespace(exists=True, instance_id="synthetic-instance", created_at=1)),
            patch.object(chat, "load_conversations", AsyncMock(side_effect=lambda _: copy.deepcopy(self.database))),
            patch.object(business, "owned_conversations", AsyncMock(side_effect=lambda user, _: copy.deepcopy(self.database) if user["id"] == "owner" else {})),
            patch.object(business, "conversation_binding_key", AsyncMock(side_effect=lambda user: "binding-" + user["id"])),
            patch.object(bulk, "contact_alias_index", AsyncMock(side_effect=lambda user: copy.deepcopy(self.index) if user["id"] == "owner" else {})),
            patch.object(bulk, "announce", AsyncMock()),
        ):
            mock.start(); self.addCleanup(mock.stop)
        app = FastAPI(); app.include_router(bulk.router)
        app.dependency_overrides[auth.current_user] = lambda: self.actor
        self.client = TestClient(app); self.addCleanup(self.client.close)
        self.path = "/api/chat/conversas/lote"
        store.mutate(self.owner, "tags", lambda data: data["items"].extend([
            {"id": "vip", "scope": "contact", "name": "VIP", "color": "#123456", "active": True},
            {"id": "sales", "scope": "conversation", "name": "Sales", "color": "#654321", "active": True},
            {"id": "archived", "scope": "contact", "name": "Old", "active": False},
            {"id": "client-only", "scope": "client", "name": "Client only", "active": True},
        ]))

    def send(self, action="etiquetar", ids=None, parameters=None, team=False):
        payload = {"ids": ids or ["a", "b"], "acao": action,
                   "parametros": parameters if parameters is not None else {"changes": [{"tagId": "vip", "apply": True}]}}
        if team: payload["inboxId"] = self.scope.inbox_id
        return self.client.post(self.path, json=payload)

    def labels(self):
        return store.snapshot(self.owner, "tag_links")["items"]

    def test_one_registry_and_idempotent_contact_labels(self):
        for _ in range(2):
            result = self.send()
            self.assertEqual(200, result.status_code, result.text)
        self.assertEqual(2, len(self.labels()))
        self.assertEqual({"a", "b"}, {row["conversationId"] for row in self.labels()})
        self.assertEqual({"binding-owner"}, {row["bindingKey"] for row in self.labels()})
        self.assertEqual(4, len(store.snapshot(self.owner, "tags")["items"]))

    def test_invalid_item_rolls_back_whole_tag_batch(self):
        self.assertEqual(404, self.send(ids=["a", "foreign"]).status_code)
        self.assertEqual([], self.labels())

    def test_invalid_or_archived_tag_rolls_back_all_changes(self):
        for identifier in ("archived", "client-only", "missing"):
            result = self.send(parameters={"changes": [{"tagId": "vip", "apply": True}, {"tagId": identifier, "apply": True}]})
            self.assertEqual(404, result.status_code)
            self.assertEqual([], self.labels())

    def test_multiple_changes_and_remove_use_one_atomic_document(self):
        self.send()
        result = self.send(parameters={"changes": [{"tagId": "vip", "apply": False}, {"tagId": "sales", "apply": True}]})
        self.assertEqual(200, result.status_code, result.text)
        self.assertEqual({"sales"}, {row["tagId"] for row in self.labels()})

    def test_explicit_aliases_deduplicate_and_project_mixed_counts(self):
        aliases = frozenset({"a", "alias-a"})
        self.index.update({"a": aliases, "alias-a": aliases})
        self.assertEqual(200, self.send(ids=["a", "alias-a"]).status_code)
        self.assertEqual(1, len(self.labels()))
        result = self.client.post(self.path + "/etiquetas", json={"ids": ["a", "alias-a", "b"]})
        self.assertEqual(200, result.status_code, result.text)
        self.assertEqual(2, result.json()["totalContacts"])
        self.assertEqual(1, next(row for row in result.json()["items"] if row["id"] == "vip")["selectedCount"])

    def test_rotation_and_workspace_never_reuse_old_links(self):
        self.send()
        with patch.object(business, "conversation_binding_key", AsyncMock(return_value="new-generation")):
            result = self.client.post(self.path + "/etiquetas", json={"ids": ["a"]})
            self.assertTrue(all(row["selectedCount"] == 0 for row in result.json()["items"]))
        tokens = set_request_context("synthetic", "another-workspace")
        try:
            self.assertEqual([], store.snapshot(self.owner, "tag_links")["items"])
        finally:
            reset_request_context(tokens)

    def test_unknown_fields_duplicate_tags_and_unbounded_batches_rejected(self):
        for payload in (
            {"ids": ["a"] * 201, "acao": "lida", "parametros": {}},
            {"ids": ["a"], "acao": "enviar", "parametros": {"texto": "Forbidden"}},
            {"ids": ["a"], "acao": "lida", "parametros": {"valor": "true"}},
            {"ids": ["a"], "acao": "lida", "parametros": {}, "ownerId": "other"},
            {"ids": ["a"], "acao": "etiquetar", "parametros": {"changes": [{"tagId": "vip", "apply": True}] * 2}},
        ):
            self.assertEqual(422, self.client.post(self.path, json=payload).status_code)
        self.assertEqual([], self.labels())

    def test_other_account_cannot_use_owner_contacts(self):
        self.actor = self.alice
        self.assertEqual(404, self.send().status_code)
        self.assertEqual([], self.labels())

    def test_team_sharing_required_and_per_item_acl(self):
        self.assertEqual(404, self.send(team=True).status_code)
        self.enable()
        service.update_assignment(self.owner_access, "b", expected_version=0, changes={"assigneeUserId": "bob"})
        self.actor = self.alice
        self.assertEqual(404, self.send(team=True).status_code)
        self.assertEqual([], self.labels())
        result = self.send(ids=["a"], team=True)
        self.assertEqual(200, result.status_code, result.text)
        self.assertEqual("alice", self.labels()[0]["createdBy"])
        self.assertEqual("owner", self.labels()[0]["conversationOwnerId"])

    def test_assignment_stale_item_rolls_back_all_events_and_rows(self):
        self.enable()
        service.update_assignment(self.owner_access, "b", expected_version=0, changes={"assigneeUserId": "bob"})
        before = repository.snapshot(self.scope)
        result = self.send("atribuir", team=True, parameters={"versions": {"a": 0, "b": 0}, "assigneeUserId": "alice"})
        self.assertEqual(409, result.status_code, result.text)
        self.assertEqual(before, repository.snapshot(self.scope))

    def test_assignment_success_and_resolution_preserve_responsible(self):
        self.enable()
        result = self.send("atribuir", team=True, parameters={"versions": {"a": 0, "b": 0}, "assigneeUserId": "alice"})
        self.assertEqual(200, result.status_code, result.text)
        self.actor = self.alice
        result = self.send("resolver", team=True, parameters={"versions": {"a": 1, "b": 1}})
        self.assertEqual(200, result.status_code, result.text)
        rows = repository.snapshot(self.scope)["assignments"].values()
        self.assertTrue(all(row["status"] == "resolved" and row["assigneeUserId"] == "alice" for row in rows))

    def test_member_cannot_batch_reassign_to_another_person(self):
        self.enable(); self.actor = self.alice
        result = self.send("atribuir", team=True, parameters={"versions": {"a": 0, "b": 0}, "assigneeUserId": "bob"})
        self.assertEqual(403, result.status_code)
        self.assertEqual({}, repository.snapshot(self.scope)["assignments"])

    def test_all_assignment_versions_required_and_personal_has_no_fake_resolver(self):
        self.assertEqual(422, self.send("resolver", parameters={"versions": {"a": 0, "b": 0}}).status_code)
        self.enable()
        for versions in ({"a": 0}, {"a": 0, "b": True}, {"a": 0, "b": -1}):
            self.assertEqual(422, self.send("resolver", team=True, parameters={"versions": versions}).status_code)

    def test_local_read_archive_do_not_send_receipts_or_messages(self):
        conversation_store._write_json_sync(self.database, "owner")
        with patch.object(chat.wapi_messaging, "mark_read", AsyncMock()) as receipts:
            self.assertEqual(200, self.send("lida", parameters={}).status_code)
            self.assertEqual(200, self.send("arquivar", parameters={}).status_code)
            receipts.assert_not_awaited()
        saved = conversation_store._read_json_sync("owner")
        self.assertTrue(all(row["lida"] and row["naoLidasCount"] == 0 and row["arquivada"] for row in saved.values()))

    def test_local_document_failure_before_write_leaves_every_item_unchanged(self):
        conversation_store._write_json_sync({"a": self.database["a"]}, "owner")
        result = self.send("arquivar", parameters={})
        self.assertEqual(404, result.status_code)
        self.assertNotIn("arquivada", conversation_store._read_json_sync("owner")["a"])

    def test_locked_tag_validation_and_capacity_failure_have_no_partial_write(self):
        with patch("app.modules.business.whatsapp_tag_batch.require_room", side_effect=[None, HTTPException(409, "Synthetic capacity")]):
            self.assertEqual(409, self.send().status_code)
        self.assertEqual([], self.labels())

    def test_filter_counts_only_authorized_conversations(self):
        self.send(); self.enable()
        service.update_assignment(self.owner_access, "b", expected_version=0, changes={"assigneeUserId": "bob"})
        self.actor = self.alice
        with patch.object(business, "tagged_conversations", AsyncMock(return_value={"ids": ["a", "b"]})):
            result = self.client.get(f"/api/chat/caixas/{self.scope.inbox_id}/tagged-conversations?tagIds=vip")
        self.assertEqual(200, result.status_code, result.text)
        self.assertEqual({"ids": ["a"], "total": 1, "nextOffset": None}, result.json())
        self.assertEqual("no-store", result.headers["cache-control"])
