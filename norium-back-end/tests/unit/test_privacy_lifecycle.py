from __future__ import annotations

import json
import os
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.core.security import hash_password
from app.modules.privacy import router as privacy


class PrivacyLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="privacy-lifecycle-")
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temporary.name, "ENVIRONMENT": "test"})
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_export_redacts_secrets_and_has_hash_manifest(self) -> None:
        directory = privacy._user_directory("person-1")
        directory.mkdir(parents=True)
        (directory / "perfil_db.json").write_text(json.dumps({"name": "Ana", "accessToken": "synthetic-secret"}), encoding="utf-8")
        (directory / "document.pdf").write_bytes(b"synthetic-document")
        user = {"id": "person-1", "nome": "Ana", "email": "ana@example.invalid", "passwordHash": "synthetic-hash", "role": "member", "plan": "free", "status": "ativo", "permissions": {}}

        with zipfile.ZipFile(BytesIO(privacy._build_export(user))) as archive:
            names = set(archive.namelist())
            self.assertIn("dados/perfil_db.json", names)
            self.assertIn("dados/document.pdf", names)
            self.assertNotIn("synthetic-secret", archive.read("dados/perfil_db.json").decode("utf-8"))
            manifest = json.loads(archive.read("manifesto.json"))
            self.assertEqual(3, len(manifest["files"]))
            self.assertTrue(all(len(item["sha256"]) == 64 for item in manifest["files"]))

    async def test_verified_deletion_revokes_anonymizes_and_purges(self) -> None:
        password = "correct horse battery staple"
        user = {
            "id": "person-2", "nome": "Titular", "email": "titular@example.invalid",
            "passwordHash": hash_password(password), "role": "member", "plan": "free",
            "status": "ativo", "systemAdmin": False, "systemAdminRole": None,
            "sessionVersion": 4, "teamOwnerId": "owner-1", "permissions": {},
        }
        store = {"users": [user], "teams": [], "plans": [], "adminAudit": [{"actorId": "person-2", "actorName": "Titular", "targetId": "", "targetName": ""}], "systemOwnerId": None}
        directory = privacy._user_directory("person-2")
        directory.mkdir(parents=True)
        (directory / "private.txt").write_text("personal", encoding="utf-8")
        writes: list[dict] = []

        async def read_store():
            return store

        async def write_store(value):
            writes.append(json.loads(json.dumps(value)))

        with patch.object(privacy.auth, "read_user_store", side_effect=read_store), patch.object(privacy.auth, "write_user_store", side_effect=write_store):
            response = await privacy.delete_own_account(
                privacy.DeleteAccountPayload(currentPassword=password, confirmation="EXCLUIR MINHA CONTA"),
                user,
            )

        self.assertTrue(response["deleted"])
        self.assertFalse(directory.exists())
        self.assertEqual("inativo", user["status"])
        self.assertEqual("Conta excluida", user["nome"])
        self.assertNotIn("titular@example.invalid", json.dumps(store))
        self.assertEqual("Conta excluida", store["adminAudit"][0]["actorName"])
        self.assertEqual(2, len(writes))

    def test_due_workspace_is_physically_purged_and_anonymized(self) -> None:
        account = Path(self.temporary.name) / "user_owner"
        workspace = account / "workspace_secondary"
        workspace.mkdir(parents=True)
        (workspace / "private.json").write_text('{"private": true}', encoding="utf-8")
        due = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        store_path = account / "plataforma_db.json"
        store_path.write_text(json.dumps({"workspaces": [{"id": "secondary", "name": "Cliente privado", "active": False, "deletionDueAt": due}]}), encoding="utf-8")

        self.assertEqual(1, privacy._purge_due_workspace_directories())
        self.assertFalse(workspace.exists())
        saved = json.loads(store_path.read_text(encoding="utf-8"))
        self.assertEqual("Workspace excluido", saved["workspaces"][0]["name"])
        self.assertTrue(saved["workspaces"][0]["purgedAt"])


if __name__ == "__main__":
    unittest.main()
