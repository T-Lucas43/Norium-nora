import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException

from app.core.request_context import reset_request_context, set_request_context
from app.core.tenant import write_user_db
from app.modules.commercial.repository import DEFAULT_STORE
from app.modules.commercial.service import public_signature_data, signature_links
from app.modules.platform import router as platform_router
from app.modules.platform.service import create_collection_item, create_workspace, delete_workspace


class WorkspaceLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="aud18-19-")
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test"})
        self.environment.start()
        self.user = {"id": "owner", "role": "owner", "plan": "enterprise"}

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_deleted_workspace_revokes_public_form_immediately(self):
        workspace = asyncio.run(create_workspace(self.user, {"name": "Secondary"}))
        context = set_request_context("create-form", workspace["id"])
        try:
            asyncio.run(create_collection_item(
                self.user,
                "forms",
                "form",
                {"name": "Synthetic", "active": True, "publicToken": "synthetic-public-token"},
            ))
        finally:
            reset_request_context(context)
        self.assertEqual("Synthetic", asyncio.run(platform_router.public_form("synthetic-public-token"))["form"]["name"])
        self.assertTrue(asyncio.run(delete_workspace(self.user, workspace["id"])))
        with self.assertRaises(HTTPException) as error:
            asyncio.run(platform_router.public_form("synthetic-public-token"))
        self.assertEqual(404, error.exception.status_code)

    def test_signature_token_resolves_secondary_workspace_without_request_header(self):
        workspace_id = "workspace-secondary"
        expiration = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
        contract = {
            "id": "contract-secondary",
            "title": "Secondary contract",
            "status": "awaiting_signatures",
            "signers": [{
                "id": "signer-a", "name": "Signer", "email": "signer@example.invalid",
                "role": "client", "order": 1, "status": "invited", "invitationExpiresAt": expiration,
            }],
        }
        context = set_request_context("write-contract", workspace_id)
        try:
            write_user_db("owner", "comercial", {**DEFAULT_STORE, "contracts": [contract]})
            url = signature_links("owner", contract, "https://example.invalid")[0]["url"]
        finally:
            reset_request_context(context)
        token = url.rsplit("/", 1)[-1]
        result = public_signature_data(token)
        self.assertEqual("contract-secondary", result["contract"]["id"])
        self.assertEqual("signer-a", result["signer"]["id"])


if __name__ == "__main__":
    unittest.main()
