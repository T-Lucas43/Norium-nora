import base64
import io
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from reportlab.pdfgen import canvas

from app.modules.nora.conversations import SavedMessage
from app.services.nora_files import deterministic_file_command, list_library_files, owned_file, save_upload, set_library_status
from app.core.request_context import set_request_context, reset_request_context


def sample_pdf(text: str = "Documento Norium") -> bytes:
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    pdf.drawString(72, 760, text)
    pdf.save()
    return output.getvalue()


class NoraFilesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test"})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def upload(self, user_id: str = "user-a"):
        content = sample_pdf()
        return save_upload(user_id, "entrada.pdf", "application/pdf", base64.b64encode(content).decode("ascii"))

    def test_upload_is_private_and_previewable(self):
        artifact = self.upload()
        record, path = owned_file("user-a", artifact["id"])
        self.assertEqual(record["name"], "entrada.pdf")
        self.assertTrue(path.read_bytes().startswith(b"%PDF-"))
        self.assertIn("/api/nora/files/", artifact["previewUrl"])
        self.assertTrue(artifact["inLibrary"])
        self.assertEqual([artifact["id"]], [item["id"] for item in list_library_files("user-a")])
        with self.assertRaises(HTTPException) as error:
            owned_file("user-b", artifact["id"])
        self.assertEqual(error.exception.status_code, 404)

    def test_file_can_be_added_to_and_removed_from_library(self):
        artifact = self.upload()
        saved = set_library_status("user-a", artifact["id"], True)
        self.assertTrue(saved["inLibrary"])
        self.assertEqual([artifact["id"]], [item["id"] for item in list_library_files("user-a")])

        removed = set_library_status("user-a", artifact["id"], False)
        self.assertFalse(removed["inLibrary"])
        self.assertEqual([], list_library_files("user-a"))

    def test_library_and_file_ids_cannot_cross_users_or_workspaces(self):
        context = set_request_context("isolation-test", "workspace-a")
        try:
            artifact = self.upload("user-a")
            set_library_status("user-a", artifact["id"], True)
            self.assertEqual([], list_library_files("user-b"))
            with self.assertRaises(HTTPException) as denied:
                set_library_status("user-b", artifact["id"], True)
            self.assertEqual(denied.exception.status_code, 404)
        finally:
            reset_request_context(context)
        context = set_request_context("isolation-test", "workspace-b")
        try:
            self.assertEqual([], list_library_files("user-a"))
            with self.assertRaises(HTTPException) as denied:
                owned_file("user-a", artifact["id"])
            self.assertEqual(denied.exception.status_code, 404)
        finally:
            reset_request_context(context)

    def test_pdf_operation_runs_locally_and_reports_zero_tokens(self):
        artifact = self.upload()
        result = deterministic_file_command("user-a", "extraia o texto deste pdf", [artifact["id"]])
        self.assertIsNotNone(result)
        self.assertEqual(result["tokenUsage"], 0)
        self.assertEqual(result["status"], "arquivo_pronto")
        output_record, output_path = owned_file("user-a", result["files"][0]["id"])
        self.assertEqual(output_record["mimeType"], "text/plain")
        self.assertIn("Documento Norium", output_path.read_text(encoding="utf-8"))

    def test_report_is_generated_without_a_model(self):
        result = deterministic_file_command("user-a", "gere meu relatorio financeiro em pdf", [])
        self.assertEqual(result["tokenUsage"], 0)
        self.assertEqual(result["files"][0]["mimeType"], "application/pdf")
        self.assertTrue(result["files"][0]["inLibrary"])
        _, path = owned_file("user-a", result["files"][0]["id"])
        self.assertTrue(path.read_bytes().startswith(b"%PDF-"))

    def test_conversation_snapshot_keeps_file_cards(self):
        artifact = self.upload()
        message = SavedMessage(role="ai", text="Arquivo pronto", files=[artifact])
        self.assertEqual(message.files[0]["id"], artifact["id"])


if __name__ == "__main__":
    unittest.main()
