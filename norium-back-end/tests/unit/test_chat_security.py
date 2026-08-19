from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router


class ChatSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_media_proxy_rejects_untrusted_host_before_network_access(self) -> None:
        owner = {"id": "owner"}
        with patch.object(chat_router, "WHATSAPP_OWNER_USER_ID", "owner"):
            with self.assertRaises(HTTPException) as error:
                await chat_router.media_proxy("https://example.invalid/private", owner)
        self.assertEqual(400, error.exception.status_code)

    async def test_whatsapp_webhook_cannot_choose_another_user(self) -> None:
        with (
            patch.object(chat_router, "WHATSAPP_OWNER_USER_ID", "owner"),
            patch.object(chat_router, "WHATSAPP_WEBHOOK_SECRET", ""),
            patch.object(chat_router.whatsapp_service, "instance_id", ""),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(
                    {"phone": "5511999999999", "userId": "outro-usuario"},
                    None,
                    None,
                )
        self.assertEqual(403, error.exception.status_code)

    async def test_local_chat_upload_is_scoped_to_authenticated_user(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            owner_dir = root / "owner"
            owner_dir.mkdir(parents=True)
            (owner_dir / "arquivo.txt").write_text("privado", encoding="utf-8")

            with patch.object(chat_router, "UPLOAD_DIR", root):
                with self.assertRaises(HTTPException) as error:
                    await chat_router.obter_upload_local("arquivo.txt", {"id": "intruso"})
        self.assertEqual(404, error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
