from __future__ import annotations
import base64
import io
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from PIL import Image
from pypdf import PdfWriter
from app.core.request_context import reset_request_context, set_request_context
from app.modules.clients import files, router
from app.modules.clients.repository import list_clients


class ClientProfileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.temp.name, "ENVIRONMENT": "test", "APP_ENV": "test"})
        self.env.start()
        self.audit = patch.object(router, "record_audit", new=AsyncMock())
        self.audit.start()
        self.user = {"id": "client-owner", "role": "owner", "plan": "enterprise"}
        self.client = (await router.create_client(router.ClientCreate(name="Cliente de teste", email="contato@example.com"), self.user))["item"]
        stream = io.BytesIO(); pdf = PdfWriter(); pdf.add_blank_page(width=595, height=842); pdf.write(stream)
        self.pdf = stream.getvalue()

    async def asyncTearDown(self):
        self.audit.stop(); self.env.stop(); self.temp.cleanup()

    def upload(self, data=None, name="documento.pdf"):
        return router.ClientFileUpload(fileName=name, dataBase64=base64.b64encode(self.pdf if data is None else data).decode())

    async def test_document_upload_download_delete_and_lightweight_listing(self):
        file = (await router.upload_client_file(self.client["id"], self.upload(name="../contrato.pdf"), self.user))["item"]
        self.assertEqual("contrato.pdf", file["fileName"])
        response = await router.download_client_file(self.client["id"], file["id"], self.user)
        self.assertEqual(self.pdf, response.path.read_bytes())
        self.assertEqual("nosniff", response.headers["x-content-type-options"])
        listed = router.client_summary(list_clients(self.user["id"])[0])
        self.assertEqual(1, listed["attachmentCount"])
        self.assertNotIn("attachments", listed)
        await router.delete_client_file(self.client["id"], file["id"], self.user)
        self.assertFalse(response.path.exists())
        self.assertEqual([], (await router.list_client_files(self.client["id"], self.user))["items"])

    async def test_files_and_photos_are_scoped_to_owner_and_workspace(self):
        file = (await router.upload_client_file(self.client["id"], self.upload(), self.user))["item"]
        with self.assertRaises(HTTPException) as denied:
            await router.download_client_file(self.client["id"], file["id"], {**self.user, "id": "another-owner"})
        self.assertEqual(404, denied.exception.status_code)
        token = set_request_context("qa", "another-workspace")
        try:
            with self.assertRaises(HTTPException):
                await router.download_client_file(self.client["id"], file["id"], self.user)
        finally:
            reset_request_context(token)
        with self.assertRaises(HTTPException):
            files.file_path(self.user["id"], self.client["id"], "../secret")

    async def test_avatar_normalization_replacement_and_removal(self):
        stream = io.BytesIO(); Image.new("RGB", (720,480), "#21845b").save(stream, "PNG")
        uploaded = (await router.upload_client_avatar(self.client["id"], self.upload(stream.getvalue(), "foto.png"), self.user))["item"]
        first = files.file_path(self.user["id"], self.client["id"], uploaded["avatarId"])
        with Image.open(first) as image:
            self.assertEqual((320,320), image.size)
            self.assertEqual("WEBP", image.format)
        await router.upload_client_avatar(self.client["id"], self.upload(stream.getvalue(), "foto.png"), self.user)
        self.assertFalse(first.exists())
        await router.delete_client_avatar(self.client["id"], self.user)
        with self.assertRaises(HTTPException):
            await router.read_client_avatar(self.client["id"], self.user)

    async def test_invalid_uploads_are_rejected_before_storage(self):
        for data,name in [(b"<svg/>","foto.svg"),(b"not a pdf","fake.pdf"),(b"not an image","fake.png"),(b"not an office file","fake.docx")]:
            with self.subTest(name=name), self.assertRaises(HTTPException):
                await router.upload_client_file(self.client["id"], self.upload(data,name), self.user)
        with self.assertRaises(HTTPException):
            await router.upload_client_file(self.client["id"], router.ClientFileUpload(fileName="arquivo.pdf",dataBase64="????"),self.user)
        with self.assertRaises(HTTPException):
            await router.upload_client_avatar(self.client["id"], self.upload(), self.user)
        self.assertEqual([], (await router.list_client_files(self.client["id"],self.user))["items"])

    async def test_deleting_client_removes_private_files(self):
        document = (await router.upload_client_file(self.client["id"], self.upload(), self.user))["item"]
        stream = io.BytesIO()
        Image.new("RGB", (50, 50), "green").save(stream, "PNG")
        avatar = (await router.upload_client_avatar(self.client["id"], self.upload(stream.getvalue(), "photo.png"), self.user))["item"]
        paths = [files.file_path(self.user["id"], self.client["id"], file_id) for file_id in [document["id"], avatar["avatarId"]]]
        await router.delete_client(self.client["id"], self.user)
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertEqual([], list_clients(self.user["id"]))

    async def test_contract_links_preserve_original_parties(self):
        original = {"id":"primary-contract","title":"Contrato original","client":{"id":self.client["id"],"name":"Cliente de teste"},"status":"signed"}
        external = {"id":"linked-contract","title":"Contrato relacionado","client":{"id":"another-client","name":"Outra empresa"},"status":"active"}
        with patch("app.modules.commercial.service.list_commercial_data", new=AsyncMock(return_value={"contracts":[original,external]})):
            listed = (await router.list_client_contracts(self.client["id"],self.user))["items"]
            self.assertTrue(next(item for item in listed if item["id"]==original["id"])["primary"])
            await router.link_client_contract(self.client["id"],external["id"],self.user)
            self.assertIn(external["id"],list_clients(self.user["id"])[0]["contractIds"])
            self.assertEqual("another-client",external["client"]["id"])
            with self.assertRaises(HTTPException) as original_link:
                await router.unlink_client_contract(self.client["id"],original["id"],self.user)
            self.assertEqual(409,original_link.exception.status_code)
            await router.unlink_client_contract(self.client["id"],external["id"],self.user)
            self.assertEqual([],list_clients(self.user["id"])[0]["contractIds"])
            with self.assertRaises(HTTPException):
                await router.link_client_contract(self.client["id"],"missing",self.user)

    async def test_contracts_require_document_permissions(self):
        user={**self.user,"role":"member","permissions":{"central":True,"propostas":False}}
        with self.assertRaises(HTTPException) as denied:
            await router.list_client_contracts(self.client["id"],user)
        self.assertEqual(403,denied.exception.status_code)

    async def test_next_contact_can_be_cleared(self):
        await router.update_client(self.client["id"],router.ClientUpdate(nextActionAt="2026-09-10T14:00"),self.user)
        result=await router.update_client(self.client["id"],router.ClientUpdate(nextActionAt=None),self.user)
        self.assertIsNone(result["item"]["nextActionAt"])

    async def test_client_sharing_is_explicit_and_enforces_view_or_edit(self):
        member = {"id": "client-member", "role": "member", "plan": "enterprise", "status": "ativo"}
        visible = [
            {"id": self.user["id"], "nome": "Owner", "email": "owner@example.com", "status": "ativo"},
            {"id": member["id"], "nome": "Member", "email": "member@example.com", "status": "ativo"},
        ]
        with (
            patch("app.modules.team.router.visible_team_members", new=AsyncMock(return_value=visible)),
            patch("app.services.system_email.queue_notification", return_value=True) as queue_notification,
        ):
            private = await router.list_clients(q=None, status=None, stage=None, user=member)
            self.assertEqual([], private["items"])
            shared = await router.update_client_access(
                self.client["id"],
                router.ClientAccessUpdate(
                    teamPermission="none",
                    people=[{"userId": member["id"], "permission": "view"}],
                ),
                self.user,
            )
            self.assertEqual("owner", shared["item"]["accessRole"])
            queued_event = queue_notification.call_args.args[1]
            self.assertEqual("client_shared", queued_event["metadata"]["emailCategory"])
            self.assertEqual(member["id"], queued_event["metadata"]["userId"])
            listed = await router.list_clients(q=None, status=None, stage=None, user=member)
            self.assertEqual("view", listed["items"][0]["accessRole"])
            with self.assertRaises(HTTPException) as denied:
                await router.update_client(
                    self.client["id"],
                    router.ClientUpdate(notes="não permitido"),
                    member,
                )
            self.assertEqual(403, denied.exception.status_code)
            await router.update_client_access(
                self.client["id"],
                router.ClientAccessUpdate(teamPermission="edit", people=[]),
                self.user,
            )
            updated = await router.update_client(
                self.client["id"],
                router.ClientUpdate(notes="edição permitida"),
                member,
            )
            self.assertEqual("edição permitida", updated["item"]["notes"])
            with self.assertRaises(HTTPException) as owner_only:
                await router.delete_client(self.client["id"], member)
            self.assertEqual(403, owner_only.exception.status_code)
