from __future__ import annotations

import copy
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.core.request_context import reset_request_context, set_request_context
from app.modules.auth import router as auth
from app.modules.whatsapp_team import access, privacy, repository, schema, service


def member(identifier, *, manager=False, attend=True, team="owner"):
    permissions = {**auth.DEFAULT_MEMBER_PERMISSIONS, "chat": True, "integracao_whatsapp": True,
                   "whatsapp.atender": attend, "whatsapp.ver_todas": manager}
    return {"id": identifier, "nome": identifier.title(), "role": "member", "plan": "equipe",
            "teamOwnerId": team, "status": "ativo", "permissions": permissions}


class Fixture:
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        environment = patch.dict(os.environ, {"NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0",
                                             "NORIUM_DATA_DIR": temporary.name, "APP_ENV": "test", "ENVIRONMENT": "test"})
        environment.start(); self.addCleanup(environment.stop)
        tokens = set_request_context("synthetic", "primary")
        self.addCleanup(reset_request_context, tokens)
        self.owner = {"id": "owner", "nome": "Owner", "role": "owner", "plan": "equipe", "status": "ativo",
                      "permissions": dict(auth.OWNER_PERMISSIONS)}
        self.alice, self.bob, self.manager = member("alice"), member("bob"), member("manager", manager=True)
        self.scope = repository.Scope("owner", "primary", "owner", "synthetic-binding")
        self.roster = (self.owner, self.alice, self.bob, self.manager)
        self.grant = lambda actor: access.Access(actor, self.owner, self.scope, self.roster)
        self.owner_access, self.alice_access = self.grant(self.owner), self.grant(self.alice)

    def enable(self):
        return service.sharing(self.owner_access, enabled=True, expected_revision=0)


class TeamMetadataTests(Fixture, unittest.TestCase):
    def test_default_is_private_and_read_does_not_create_store(self):
        self.assertFalse(repository.snapshot(self.scope)["inbox"]["enabled"])
        self.assertFalse(self.scope.file_path().exists())
        with self.assertRaises(HTTPException) as result:
            service.create_note(self.alice_access, "chat", body="Synthetic note", mentions=[])
        self.assertEqual(404, result.exception.status_code)
        self.assertFalse(self.scope.file_path().exists())

    def test_only_owner_can_opt_in_and_revision_conflicts_do_not_write(self):
        with self.assertRaises(HTTPException) as denied:
            service.sharing(self.grant(self.manager), enabled=True, expected_revision=0)
        self.assertEqual(403, denied.exception.status_code)
        self.enable()
        with self.assertRaises(HTTPException):
            service.sharing(self.owner_access, enabled=False, expected_revision=0)
        self.assertTrue(repository.snapshot(self.scope)["inbox"]["enabled"])

    def test_assignment_permissions_and_status_transitions(self):
        self.enable()
        row = service.update_assignment(self.alice_access, "chat", expected_version=0, changes={"assigneeUserId": "alice"})
        self.assertEqual("user", row["assigneeKind"])
        with self.assertRaises(HTTPException) as denied:
            access.assert_conversation(self.grant(self.bob), repository.snapshot(self.scope), "chat")
        self.assertEqual(404, denied.exception.status_code)
        row = service.update_assignment(self.alice_access, "chat", expected_version=1, changes={"status": "waiting_customer"})
        row = service.update_assignment(self.grant(self.manager), "chat", expected_version=2,
                                        changes={"assigneeUserId": "bob", "status": "resolved"})
        self.assertEqual(("bob", "resolved", 3), (row["assigneeUserId"], row["status"], row["generation"]))
        events = service.page(repository.snapshot(self.scope), "chat", "events")
        self.assertEqual(4, len(events["items"]))
        self.assertTrue(all("body" not in event["payload"] for event in events["items"]))

    def test_member_cannot_assign_other_member_or_unknown_person(self):
        self.enable()
        for changes in ({"assigneeUserId": "bob"}, {"assigneeUserId": "outsider"}, {"assigneeKind": "nora"}):
            with self.assertRaises(HTTPException):
                service.update_assignment(self.alice_access, "chat", expected_version=0, changes=changes)
        self.assertEqual({}, repository.snapshot(self.scope)["assignments"])

    def test_concurrent_claim_has_only_one_winner(self):
        self.enable()
        def claim(identifier):
            try:
                service.update_assignment(self.grant(member(identifier)), "chat", expected_version=0,
                                          changes={"assigneeUserId": identifier})
                return True
            except HTTPException:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(claim, ["alice", "bob"]))
        self.assertEqual(1, sum(results))
        self.assertEqual(1, repository.snapshot(self.scope)["assignments"]["chat"]["version"])

    def test_note_is_internal_and_edit_delete_preserve_audit(self):
        self.enable()
        from app.modules.chat import router as chat
        with patch.object(chat.whatsapp_integration, "send", AsyncMock(side_effect=AssertionError("External send forbidden"))) as send:
            note = service.create_note(self.alice_access, "chat", body="Synthetic internal only", mentions=["bob"])
            changed = service.change_note(self.alice_access, "chat", note["id"], expected_version=1, body="Updated synthetic")
            self.assertEqual(2, changed["version"])
            deleted = service.change_note(self.owner_access, "chat", note["id"], expected_version=2, body=None)
            self.assertEqual("", deleted["body"])
            self.assertIsNotNone(deleted["deletedAt"])
            send.assert_not_called()
        value = repository.snapshot(self.scope)
        self.assertEqual([], service.page(value, "chat", "notes")["items"])
        self.assertEqual(3, len(service.page(value, "chat", "events")["items"]))

    def test_note_author_manager_and_mention_acl(self):
        self.enable()
        note = service.create_note(self.alice_access, "chat", body="Synthetic", mentions=[])
        with self.assertRaises(HTTPException) as denied:
            service.change_note(self.grant(self.bob), "chat", note["id"], expected_version=1, body="Forbidden")
        self.assertEqual(403, denied.exception.status_code)
        service.update_assignment(self.alice_access, "chat", expected_version=0, changes={"assigneeUserId": "alice"})
        with self.assertRaises(HTTPException):
            service.create_note(self.alice_access, "chat", body="Synthetic", mentions=["bob"])
        note2 = service.create_note(self.alice_access, "chat", body="Synthetic", mentions=["manager"])
        self.assertEqual(["manager"], note2["mentions"])

    def test_binding_tenant_and_workspace_isolation(self):
        self.enable()
        for scope in (repository.Scope("other", "primary", "other", "synthetic-binding"),
                      repository.Scope("owner", "primary", "owner", "rotated-binding")):
            self.assertFalse(repository.snapshot(scope)["inbox"]["enabled"])
        tokens = set_request_context("synthetic", "secondary")
        try:
            scope = repository.Scope("owner", "secondary", "owner", "synthetic-binding")
            self.assertFalse(repository.snapshot(scope)["inbox"]["enabled"])
            with self.assertRaises(ValueError):
                repository.snapshot(self.scope)
        finally:
            reset_request_context(tokens)

    def test_opt_out_immediately_blocks_notes_and_assigned_conversation(self):
        self.enable()
        service.sharing(self.owner_access, enabled=False, expected_revision=1)
        with self.assertRaises(HTTPException):
            service.update_assignment(self.alice_access, "chat", expected_version=0, changes={"status": "resolved"})
        self.assertEqual({}, repository.snapshot(self.scope)["events"])

    def test_failed_mutation_is_atomic_and_postgres_error_never_falls_back(self):
        self.enable()
        def fail(value):
            value["notes"]["partial"] = {"body": "must not persist"}
            raise RuntimeError("synthetic failure")
        with self.assertRaises(RuntimeError):
            repository.mutate(self.scope, fail)
        self.assertEqual({}, repository.snapshot(self.scope)["notes"])
        with patch.object(schema, "postgres_enabled", return_value=True), patch.object(repository.postgres_store, "initialize", side_effect=RuntimeError("Unavailable")):
            with self.assertRaises(RuntimeError):
                repository.snapshot(self.scope)

    def test_privacy_export_and_erasure_preserve_others_and_release_assignment(self):
        self.enable()
        first = service.create_note(self.alice_access, "chat", body="Alice private contribution", mentions=["bob"])
        second = service.create_note(self.grant(self.bob), "chat", body="Bob contribution", mentions=["alice"])
        service.update_assignment(self.alice_access, "chat", expected_version=0, changes={"assigneeUserId": "alice"})
        exported = privacy.personal_contributions("alice")
        authored = [row for row in exported if "body" in row["record"]]
        self.assertEqual(["Alice private contribution"], [row["record"]["body"] for row in authored])
        self.assertNotIn("Bob contribution", str(exported))
        privacy.personal_contributions("alice", purge=True)
        value = repository.snapshot(self.scope)
        self.assertEqual("", value["notes"][first["id"]]["body"])
        self.assertEqual("deleted", value["notes"][first["id"]]["authorUserId"])
        self.assertEqual("Bob contribution", value["notes"][second["id"]]["body"])
        self.assertEqual([], value["notes"][second["id"]]["mentions"])
        self.assertIsNone(value["assignments"]["chat"]["assigneeUserId"])
        self.assertEqual("none", value["assignments"]["chat"]["assigneeKind"])
        self.assertEqual([], privacy.personal_contributions("alice"))

    def test_relational_tables_have_explicit_owner_privacy_scope(self):
        from app.modules.privacy.storage_catalog import ROW_SCOPES
        for table in privacy.TABLES.values():
            self.assertEqual("tenant_id", ROW_SCOPES[table])

    def test_manual_confirmed_send_claims_only_when_configured(self):
        self.enable()
        result = service.record_outgoing(self.alice_access, "chat")
        self.assertEqual("alice", result["assigneeUserId"])
        self.assertEqual("open", result["status"])
        service.sharing(self.owner_access, enabled=True, expected_revision=1, auto_assign_on_send=False)
        other = service.record_outgoing(self.grant(self.bob), "other-chat")
        self.assertEqual("none", other["assigneeKind"])
        self.assertEqual([self.scope], repository.enabled_scopes("owner", "synthetic-binding"))
        self.assertEqual([], repository.enabled_scopes("owner", "rotated-binding"))

    def test_customer_reply_reopens_preserves_owner_and_deduplicates(self):
        import time
        self.enable()
        service.update_assignment(self.alice_access, "chat", expected_version=0,
                                  changes={"assigneeUserId": "alice", "status": "waiting_customer"})
        stamp = int(time.time()) + 1
        reopened = service.received(self.scope, "chat", message_id="new-message", timestamp=stamp)
        self.assertEqual(("open", "alice"), (reopened["status"], reopened["assigneeUserId"]))
        self.assertIsNone(service.received(self.scope, "chat", message_id="new-message", timestamp=stamp))
        service.update_assignment(self.alice_access, "chat", expected_version=reopened["version"], changes={"status": "resolved"})
        self.assertIsNone(service.received(self.scope, "chat", message_id="old-history", timestamp=stamp - 100))
        self.assertEqual("resolved", repository.snapshot(self.scope)["assignments"]["chat"]["status"])


class TeamAccessTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def test_nonprimary_workspace_is_rechecked_against_fresh_team_owner(self):
        runtime = SimpleNamespace(read_user_store=AsyncMock(return_value={"users": list(self.roster)}),
                                  wapi_owned_binding=lambda _: SimpleNamespace(exists=True, instance_id="instance", created_at=1))
        tokens = set_request_context("synthetic", "secondary")
        try:
            with patch.object(auth, "read_account_db", side_effect=lambda owner, *_: {"workspaces": [{"id": "secondary", "active": True}]} if owner == "owner" else {}) as platform:
                self.assertEqual("secondary", (await access.resolve(runtime, self.alice)).scope.workspace_id)
                self.assertEqual("owner", platform.call_args.args[0])
                runtime.read_user_store.return_value = {"users": [{**self.owner, "id": "other-owner"}, member("alice", team="other-owner")]}
                with self.assertRaises(HTTPException) as error:
                    await access.resolve(runtime, self.alice)
                self.assertEqual(403, error.exception.status_code)
                self.assertEqual("other-owner", platform.call_args.args[0])
        finally:
            reset_request_context(tokens)

    async def test_fresh_directory_revokes_stale_membership_and_permissions(self):
        runtime = SimpleNamespace(read_user_store=AsyncMock(return_value={"users": list(self.roster)}),
                                  wapi_owned_binding=lambda _: SimpleNamespace(exists=True, instance_id="instance", created_at=1))
        grant = await access.resolve(runtime, self.alice)
        self.assertEqual("owner", grant.scope.owner_id)
        for replacement in (member("alice", attend=False), member("alice", team="other"), {**self.alice, "status": "inativo"}):
            runtime.read_user_store.return_value = {"users": [self.owner, replacement]}
            with self.assertRaises(HTTPException):
                await access.resolve(runtime, self.alice)

    async def test_binding_id_owner_and_plan_gates(self):
        runtime = SimpleNamespace(read_user_store=AsyncMock(return_value={"users": list(self.roster)}),
                                  wapi_owned_binding=lambda _: SimpleNamespace(exists=True, instance_id="instance", created_at=1))
        grant = await access.resolve(runtime, self.owner, owner_only=True)
        with self.assertRaises(HTTPException):
            await access.resolve(runtime, self.alice, owner_only=True)
        with self.assertRaises(HTTPException):
            await access.resolve(runtime, self.alice, "foreign-inbox")
        runtime.wapi_owned_binding = lambda _: SimpleNamespace(exists=True, instance_id="instance", created_at=2)
        with self.assertRaises(HTTPException):
            await access.resolve(runtime, self.alice, grant.scope.inbox_id)
        runtime.read_user_store.return_value = {"users": [{**self.owner, "plan": "individual"}, self.alice]}
        with self.assertRaises(HTTPException):
            await access.resolve(runtime, self.alice)


if __name__ == "__main__":
    unittest.main()
