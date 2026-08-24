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


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class ChatSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_chat_details_uses_contact_catalog_and_persists_conversation(self) -> None:
        conversation_id = "5511999999999@c.us"
        catalog = {
            "contacts": [{
                "id": conversation_id,
                "phone": "5511999999999",
                "pushname": "Joao da Silva",
                "profilePictureUrl": "https://example.test/avatar.jpg",
            }]
        }
        save = AsyncMock()

        with (
            patch.object(chat_router, "load_conversations", AsyncMock(return_value={})),
            patch.object(chat_router, "load_whatsapp_catalog_cache", AsyncMock(return_value=catalog)),
            patch.object(chat_router, "save_conversations", save),
            patch.object(chat_router, "wapi_creds", return_value=None),
        ):
            result = await chat_router.obter_detalhes_conversa(conversation_id, chat_user("owner"))

        self.assertEqual("Joao da Silva", result["contato"])
        self.assertEqual("https://example.test/avatar.jpg", result["photoUrl"])
        self.assertEqual("5511999999999", result["metadados"]["numeroCompleto"])
        save.assert_awaited_once()

    async def test_media_proxy_rejects_untrusted_host_before_network_access(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.media_proxy("https://example.invalid/private", chat_user("owner"))
        self.assertEqual(400, error.exception.status_code)

    async def test_whatsapp_webhook_rejects_unknown_instance(self) -> None:
        # Modelo W-API: o dono e resolvido pelo instanceId (mapa seguro). Uma
        # instancia desconhecida nao pode entregar eventos e nao revela existencia.
        with patch.object(chat_router, "WAPI_WEBHOOK_SECRET", ""):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp(
                    {
                        "event": "webhookReceived",
                        "instanceId": "INSTANCIA-DESCONHECIDA",
                        "phone": "5511999999999@c.us",
                    },
                )
        self.assertEqual(404, error.exception.status_code)

    async def test_two_authenticated_users_receive_only_their_own_catalog(self) -> None:
        from app.services import wapi_binding as wb
        from app.services.wapi_binding import InstanceBinding

        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}):
            # Cada conta vinculada a sua propria instancia W-API.
            wb.save_binding("user-a", InstanceBinding(instance_id="inst-a", token="t-a", state="connected"))
            wb.save_binding("user-b", InstanceBinding(instance_id="inst-b", token="t-b", state="connected"))

            # Simula lixo persistido por uma versão antiga; a leitura deve limpar.
            stores: dict[str, dict] = {
                "user-a": {"status@broadcast": {"id": "status@broadcast"}},
                "user-b": {"status@broadcast": {"id": "status@broadcast"}},
            }

            async def load(user_id: str) -> dict:
                return stores.setdefault(user_id, {})

            async def save(payload: dict, user_id: str) -> None:
                stores[user_id] = payload

            async def fetch_chats(instance_id: str, token: str, **_kwargs):
                # O catalogo depende da instancia (isolada por conta), nao do userId.
                return {"chats": [
                    {
                        "id": f"chat-{instance_id}@c.us",
                        "phone": f"chat-{instance_id}@c.us",
                        "name": f"Contato {instance_id}",
                        "timestamp": 1_787_000_000,
                        "messages": [{
                            "id": f"message-{instance_id}",
                            "timestamp": 1_787_000_000,
                            "content": "oi",
                            "type": "chat",
                            "fromMe": False,
                        }],
                    },
                    {
                        "id": "status@broadcast",
                        "phone": "status@broadcast",
                        "name": "Status",
                        "timestamp": 1_787_000_001,
                    },
                ]}

            async def fetch_contacts(instance_id: str, token: str, **_kwargs):
                return {"contacts": []}

            with (
                patch.object(chat_router.wapi_connect, "status", AsyncMock(return_value={"status": "conectado"})),
                patch.object(chat_router.wapi_client, "fetch_chats", side_effect=fetch_chats),
                patch.object(chat_router.wapi_client, "fetch_contacts", side_effect=fetch_contacts),
                patch.object(chat_router, "load_conversations", side_effect=load),
                patch.object(chat_router, "save_conversations", side_effect=save),
                patch.object(chat_router, "should_try_profile_picture", return_value=False),
            ):
                # A listagem interativa agora e cache-first e nunca espera a
                # W-API. Executa os dois workers, como ocorreria em background,
                # antes de validar que cada conta recebeu apenas seu catalogo.
                await chat_router._run_contact_sync("user-a")
                await chat_router._run_contact_sync("user-b")
                catalog_a = await chat_router.obter_conversas(since=None, limit=100, user=chat_user("user-a"))
                catalog_b = await chat_router.obter_conversas(since=None, limit=100, user=chat_user("user-b"))

        self.assertEqual({"chat-inst-a@c.us"}, {item["id"] for item in catalog_a})
        self.assertEqual({"chat-inst-b@c.us"}, {item["id"] for item in catalog_b})
        self.assertNotIn("chat-inst-b@c.us", stores["user-a"])
        self.assertNotIn("chat-inst-a@c.us", stores["user-b"])
        self.assertNotIn("status@broadcast", stores["user-a"])
        self.assertNotIn("status@broadcast", stores["user-b"])

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
