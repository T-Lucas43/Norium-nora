from __future__ import annotations

import io
import json
import logging
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException
from app.modules.privacy import router as privacy
from app.modules.privacy import storage_catalog as catalog
from app.modules.privacy.retention import maintain_retention, retention_days
from app.modules.privacy.deletion_ledger import record_deletion, read_ledger
from app.modules.privacy.google_revocation import revoke_google_for_account
from app.core.log_masking import PersonalDataLogFilter, mask_metadata
from app.services.system_logs import record_system_log, personal_logs


class Phase7Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"ENVIRONMENT": "test", "APP_ENV": "test", "NORIUM_DATA_DIR": self.temp.name,
                                           "NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0", "NORIUM_RETENTION_ENABLED": "0"})
        self.env.start()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_all_personal_sqlite_stores_export_and_delete_are_isolated(self):
        fixtures = {"ai_costs.sqlite3": ("usage", "user_id"), "automation_events.sqlite3": ("jobs", "user_id"),
                    "outbound_receipts.sqlite3": ("norium_outbound_receipts", "user_id"), "nora_brain.sqlite3": ("nora_jobs", "tenant")}
        for name, (table, owner) in fixtures.items():
            with closing(sqlite3.connect(self.root / name)) as db:
                db.execute(f"CREATE TABLE {table}(id TEXT, {owner} TEXT, actor TEXT, workspace TEXT)")
                db.executemany(f"INSERT INTO {table} VALUES (?,?,?,?)", [("mine", "alice", "alice", "primary"), ("other", "bob", "bob", "primary")])
                db.commit()
        rows = catalog.sqlite_personal_data("alice")
        self.assertEqual(set(fixtures), {key.split("/", 1)[0] for key in rows})
        self.assertTrue(all([row["id"] for row in items] == ["mine"] for items in rows.values()))
        catalog.sqlite_personal_data("alice", purge=True)
        self.assertEqual({}, catalog.sqlite_personal_data("alice"))
        self.assertEqual(4, len(catalog.sqlite_personal_data("bob")))

    def test_speech_ledger_export_and_purge_preserve_other_users_and_workspaces(self):
        with closing(sqlite3.connect(self.root / "ai_costs.sqlite3")) as db:
            db.execute("CREATE TABLE speech_usage(id TEXT, user_id TEXT, workspace TEXT, units INTEGER)")
            db.execute("CREATE TABLE speech_budget_locks(user_id TEXT PRIMARY KEY)")
            db.executemany("INSERT INTO speech_budget_locks VALUES (?)", [("alice",), ("bob",)])
            db.executemany("INSERT INTO speech_usage VALUES (?,?,?,?)", [
                ("own-primary", "alice", "primary", 10),
                ("own-secondary", "alice", "secondary", 20),
                ("other-primary", "bob", "primary", 30),
            ])
            db.commit()
        rows = catalog.sqlite_personal_data("alice", workspace_id="primary")
        self.assertEqual(["own-primary"], [row["id"] for row in rows["ai_costs.sqlite3/speech_usage"]])
        catalog.sqlite_personal_data("alice", purge=True, workspace_id="primary")
        self.assertEqual({}, catalog.sqlite_personal_data("alice", workspace_id="primary"))
        self.assertEqual("own-secondary", catalog.sqlite_personal_data("alice")["ai_costs.sqlite3/speech_usage"][0]["id"])
        self.assertEqual("other-primary", catalog.sqlite_personal_data("bob")["ai_costs.sqlite3/speech_usage"][0]["id"])
        self.assertEqual("alice", catalog.sqlite_personal_data("alice")["ai_costs.sqlite3/speech_budget_locks"][0]["user_id"])
        catalog.sqlite_personal_data("alice", purge=True)
        self.assertEqual({}, catalog.sqlite_personal_data("alice"))
        self.assertEqual("bob", catalog.sqlite_personal_data("bob")["ai_costs.sqlite3/speech_budget_locks"][0]["user_id"])

    def test_unknown_personal_table_fails_coverage_instead_of_silent_export(self):
        with closing(sqlite3.connect(self.root / "ai_costs.sqlite3")) as db:
            db.execute("CREATE TABLE unexpected(user_id TEXT)")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, "without privacy coverage"):
            catalog.sqlite_personal_data("alice")

    def test_legacy_anexos_and_whatsapp_uploads_export_delete_and_neighbor_survives(self):
        directory = self.root / "user_alice"
        directory.mkdir()
        references = []
        for store in catalog.UPLOAD_STORES:
            path = self.root / store
            path.mkdir()
            (path / "mine.bin").write_bytes(b"mine")
            (path / "neighbor.bin").write_bytes(b"neighbor")
            references.append({"storedName": "mine.bin"})
        (directory / "anexos_db.json").write_text(json.dumps(references))
        uploads = self.root / "uploads" / "alice"
        uploads.mkdir(parents=True)
        (uploads / "media.bin").write_bytes(b"media")
        user = {"id": "alice", "nome": "Synthetic", "email": "a@example.invalid", "status": "ativo", "permissions": {}}
        with patch("app.infrastructure.auth_sessions.export_personal_sessions", return_value={"sessions": [], "events": []}):
            with zipfile.ZipFile(io.BytesIO(privacy._build_export(user))) as archive:
                names = archive.namelist()
                self.assertTrue(all(any(store in name for name in names) for store in catalog.UPLOAD_STORES))
                self.assertIn("dados/uploads/alice/media.bin", names)
                self.assertTrue(all("neighbor" not in name for name in names))
        privacy._purge_personal_files("alice")
        self.assertFalse(directory.exists())
        self.assertFalse(uploads.exists())
        for store in catalog.UPLOAD_STORES:
            self.assertFalse((self.root / store / "mine.bin").exists())
            self.assertTrue((self.root / store / "neighbor.bin").exists())

    def test_log_minimization_cpf_phone_email_secret_and_access_formatter(self):
        record = logging.LogRecord("app.test", logging.ERROR, "", 0, "CPF %s e-mail %s tel %s", ("123.456.789-00", "a@example.invalid", "(11) 98765-4321"), None)
        PersonalDataLogFilter().filter(record)
        value = record.getMessage()
        for secret in ("123.456.789-00", "a@example.invalid", "98765-4321"):
            self.assertNotIn(secret, value)
        access = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1", "GET", "/api/a?token=sensitive", "1.1", 200), None)
        PersonalDataLogFilter().filter(access)
        self.assertEqual(5, len(access.args))
        self.assertNotIn("sensitive", access.getMessage())
        entry = record_system_log("event", user_id="alice", message="a@example.invalid", metadata={"path": "/api/a?token=bad", "body": "customer text", "email": "a@example.invalid"})
        self.assertEqual("/api/a", entry["metadata"]["path"])
        self.assertNotIn("customer text", str(entry))
        self.assertNotIn("a@example.invalid", str(entry))
        self.assertEqual(1, len(personal_logs("alice", purge=True)))
        self.assertEqual([], personal_logs("alice"))

    def test_google_revocation_uses_post_body_and_failed_revoke_keeps_token(self):
        from app.services.oauth_credentials import protect
        from app.core.tenant import write_account_db, read_account_db
        token = {"refresh_token": "synthetic-refresh"}
        write_account_db("alice", "gmail_integration", {"gmailToken": protect("alice", "gmailToken", token)})
        response = type("Response", (), {"status_code": 200})()
        with patch("app.modules.privacy.google_revocation.httpx.post", return_value=response) as send:
            self.assertEqual(1, revoke_google_for_account("alice"))
            self.assertEqual("https://oauth2.googleapis.com/revoke", send.call_args.args[0])
            self.assertEqual({"token": "synthetic-refresh"}, send.call_args.kwargs["data"])
        self.assertNotIn("gmailToken", read_account_db("alice", "gmail_integration", {}))
        write_account_db("alice", "gmail_integration", {"gmailToken": protect("alice", "gmailToken", token)})
        response.status_code = 503
        with patch("app.modules.privacy.google_revocation.httpx.post", return_value=response):
            with self.assertRaises(RuntimeError):
                revoke_google_for_account("alice")
        self.assertIn("gmailToken", read_account_db("alice", "gmail_integration", {}))

    def test_retention_disabled_and_zero_preserves_and_enabled_purges(self):
        now = datetime.now(timezone.utc)
        folder = self.root / "user_alice"
        folder.mkdir()
        old = (now - timedelta(days=400)).isoformat()
        (folder / "nora_conversations_db.json").write_text(json.dumps({"conversations": [{"id": "abcdefgh", "updatedAt": old}]}))
        (folder / "nora_chat_abcdefgh_db.json").write_text('{"text":"synthetic"}')
        (folder / "nora_ctx_abcdefgh_db.json").write_text('{}')
        self.assertEqual(0, maintain_retention(now)["retainedConversationsRemoved"])
        with patch.dict(os.environ, {"NORIUM_RETENTION_ENABLED": "1", "NORIUM_RETENTION_NORA_DAYS": "0"}):
            self.assertEqual(0, retention_days("NORA"))
            self.assertEqual(0, maintain_retention(now)["retainedConversationsRemoved"])
        with patch.dict(os.environ, {"NORIUM_RETENTION_ENABLED": "1"}):
            self.assertEqual(1, maintain_retention(now)["retainedConversationsRemoved"])
        self.assertFalse((folder / "nora_chat_abcdefgh_db.json").exists())

    def test_deletion_ledger_idempotent_minimal_and_tampering_rejected(self):
        record_deletion("alice")
        record_deletion("alice")
        record_deletion("alice", "secondary")
        rows = read_ledger()
        self.assertEqual(2, len(rows))
        self.assertTrue(all(set(row) == {"id", "version", "userId", "workspaceId", "requestedAt"} for row in rows))

    def test_shared_deletion_requires_current_external_ledger(self):
        from app.modules.privacy.deletion_ledger import ledger_path
        with patch.dict(os.environ, {"ENVIRONMENT": "homologacao", "APP_ENV": "homologacao", "NORIUM_DELETION_LEDGER_PATH": ""}):
            with self.assertRaisesRegex(RuntimeError, "configuration_required"):
                ledger_path()
        with patch.dict(os.environ, {"NORIUM_DELETION_LEDGER_PATH": str(self.root / "old-ledger.jsonl")}):
            with self.assertRaisesRegex(RuntimeError, "outside_data_backups"):
                ledger_path()

    def test_owned_and_legacy_storage_quota_and_workspace_isolation(self):
        from app.infrastructure.storage_limits import workspace_usage
        from app.infrastructure.persistence import files
        folder = self.root / "user_alice"
        (folder / "workspace_secondary").mkdir(parents=True)
        document = json.dumps({"storedName": "primary.bin"}).encode()
        (folder / "team_chat_db.json").write_bytes(document)
        (folder / "workspace_secondary" / "task.bin").write_bytes(b"z" * 50)
        (self.root / "team_chat_uploads").mkdir()
        (self.root / "team_chat_uploads" / "primary.bin").write_bytes(b"p" * 20)
        (self.root / "team_chat_uploads" / "neighbor.bin").write_bytes(b"n" * 100)
        usage = workspace_usage("alice")
        self.assertEqual(len(document) + 20, usage["usedBytes"])
        self.assertEqual(50, workspace_usage("alice", "secondary")["usedBytes"])
        with patch.dict(os.environ, {"NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES": str(len(document) + 22)}):
            with self.assertRaises(HTTPException):
                files.write(folder / "new.bin", b"123")
        self.assertFalse((folder / "new.bin").exists())

    def test_declared_relational_personal_stores_have_catalog_coverage(self):
        import re
        backend = Path(__file__).resolve().parents[2]
        uncovered = set()
        for path in list((backend / "app").rglob("*.py")) + list((backend / "app" / "modules" / "scheduling" / "migrations").glob("*.sql")):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"CREATE TABLE(?: IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)\s*\(([^)]*)", text, re.I):
                table, body = match.groups()
                if re.search(r"\b(?:user_id|tenant_id|tenant|actor|account)\s", body):
                    if table not in catalog.ROW_SCOPES and table not in catalog.SPECIAL_COVERAGE and table not in catalog.NON_PERSONAL_TABLES:
                        uncovered.add(table)
        self.assertEqual(set(), uncovered)

    def test_document_and_response_cache_forget_only_deleted_account(self):
        from app.infrastructure.persistence import document_cache
        from app.services import nora
        document_cache.clear()
        with patch.dict(os.environ, {"NORIUM_DOCUMENT_CACHE": "1"}):
            document_cache.put("user_alice/workspace_secondary/data.json", True, {"private": True})
            document_cache.put("user_bob/data.json", True, {"private": True})
            nora._response_cache[("alice", "primary")] = (999999999999, "synthetic")
            nora._response_cache[("bob", "primary")] = (999999999999, "synthetic")
            catalog.clear_personal_cache("alice")
            self.assertFalse(document_cache.get("user_alice/workspace_secondary/data.json")[0])
            self.assertTrue(document_cache.get("user_bob/data.json")[0])
            self.assertNotIn(("alice", "primary"), nora._response_cache)
            self.assertIn(("bob", "primary"), nora._response_cache)
        nora._response_cache.clear()
        document_cache.clear()

    def test_postgres_retention_does_not_use_local_fallback(self):
        from app.modules.privacy import retention
        from app.modules.whatsapp_team import retention as team_retention
        fake = self.root / "uploads" / "alice" / "old.bin"
        original_stat = Path.stat
        def guarded_stat(path, *args, **kwargs):
            if path == self.root:
                return original_stat(path, *args, **kwargs)
            raise AssertionError("local fallback forbidden")
        with patch.dict(os.environ, {"NORIUM_RETENTION_ENABLED": "1"}), patch.object(retention, "get_data_root", return_value=self.root), patch.object(retention.postgres_store, "configured", return_value=True), patch.object(retention.postgres_store, "list_document_keys", return_value=[]), patch.object(retention.files, "list_paths", return_value=[fake]), patch.object(retention.files, "info", return_value=None), patch.object(retention.files, "delete") as delete, patch("app.services.system_logs.purge_logs_before", return_value=0), patch.object(team_retention, "_postgres", return_value=0) as metadata, patch.object(Path, "stat", new=guarded_stat):
            result = maintain_retention()
        self.assertEqual(0, result["retainedFilesRemoved"])
        delete.assert_not_called()
        metadata.assert_called_once()


class AuditPhase7Tests(unittest.IsolatedAsyncioTestCase):
    async def test_client_cannot_forge_audit(self):
        from app.modules.operations.router import create_audit
        from app.modules.operations.schemas import AuditCreate
        payload = AuditCreate(action="forged", source="test", description="forged")
        with self.assertRaises(HTTPException) as error:
            await create_audit(payload, {"id": "alice"})
        self.assertEqual(403, error.exception.status_code)

    async def test_audit_pagination_scope_and_next_offset(self):
        import importlib
        operations = importlib.import_module("app.modules.operations.router")
        from unittest.mock import AsyncMock
        items = [{"id": str(index)} for index in range(5)]
        with patch.object(operations, "list_items", AsyncMock(return_value=items)) as read:
            page = await operations.get_audit(limit=2, offset=2, user={"id": "alice"})
        self.assertEqual([{"id": "2"}, {"id": "3"}], page["items"])
        self.assertEqual(4, page["nextOffset"])
        self.assertEqual("alice", read.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
