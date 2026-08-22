from __future__ import annotations

import hashlib
import hmac
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services.whatsapp import WhatsAppService


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class ChatSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_media_proxy_rejects_untrusted_host_before_network_access(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.media_proxy("https://example.invalid/private", chat_user("owner"))
        self.assertEqual(400, error.exception.status_code)

    async def test_whatsapp_webhook_rejects_mismatched_user_session(self) -> None:
        with (
            patch.object(chat_router, "WHATSAPP_WEBHOOK_SECRET", ""),
            patch.object(chat_router, "WHATSAPP_WEBHOOK_HMAC_SECRET", ""),
            patch.object(chat_router.whatsapp_service, "session_id_for", return_value="wa-user-a"),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(
                    {
                        "event": "message",
                        "userId": "user-a",
                        "sessionId": "wa-user-b",
                        "data": {"phone": "5511999999999@c.us"},
                    },
                )
        self.assertEqual(403, error.exception.status_code)

    def test_internal_headers_are_unique_and_signed_for_each_user(self) -> None:
        api_key = "k" * 40
        with patch.dict(
            os.environ,
            {
                "WHATSAPP_API_URL": "https://whatsapp.example",
                "WHATSAPP_API_KEY": api_key,
                "WHATSAPP_LEGACY_OWNER_USER_ID": "legacy-owner",
            },
        ):
            service = WhatsAppService()
        headers_a = service.headers_for("user-a")
        headers_b = service.headers_for("user-b")

        self.assertNotEqual(headers_a["X-Norium-Session-Id"], headers_b["X-Norium-Session-Id"])
        self.assertNotEqual(headers_a["X-Norium-Session-Signature"], headers_b["X-Norium-Session-Signature"])
        expected = hmac.new(
            api_key.encode("utf-8"),
            f'user-a\n{headers_a["X-Norium-Session-Id"]}'.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(expected, headers_a["X-Norium-Session-Signature"])
        self.assertEqual("norium", service.session_id_for("legacy-owner"))

    async def test_two_authenticated_users_receive_only_their_own_catalog(self) -> None:
        stores: dict[str, dict] = {"user-a": {}, "user-b": {}}

        async def load(user_id: str) -> dict:
            return stores[user_id]

        async def save(payload: dict, user_id: str) -> None:
            stores[user_id] = payload

        async def api_get(user_id: str, endpoint: str, **_kwargs):
            if endpoint == "/contacts":
                return []
            return [{
                "id": f"chat-{user_id}@c.us",
                "phone": f"chat-{user_id}@c.us",
                "name": f"Contato {user_id}",
                "photoUrl": "https://cdn.example/avatar.jpg",
                "timestamp": 1_787_000_000,
                "messages": [{
                    "id": f"message-{user_id}",
                    "timestamp": 1_787_000_000,
                    "content": f"Mensagem {user_id}",
                    "type": "chat",
                    "fromMe": False,
                }],
            }]

        with (
            patch.object(chat_router.whatsapp_service, "consultar_instancia", AsyncMock(return_value={"status": "conectado"})),
            patch.object(chat_router.whatsapp_service, "get", side_effect=api_get),
            patch.object(chat_router, "load_conversations", side_effect=load),
            patch.object(chat_router, "save_conversations", side_effect=save),
        ):
            catalog_a = await chat_router.obter_conversas(since=None, limit=100, user=chat_user("user-a"))
            catalog_b = await chat_router.obter_conversas(since=None, limit=100, user=chat_user("user-b"))

        self.assertEqual({"chat-user-a@c.us"}, {item["id"] for item in catalog_a})
        self.assertEqual({"chat-user-b@c.us"}, {item["id"] for item in catalog_b})
        self.assertNotIn("chat-user-b@c.us", stores["user-a"])
        self.assertNotIn("chat-user-a@c.us", stores["user-b"])

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
