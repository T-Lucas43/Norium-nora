"""Envio do rascunho revisado na tela: exige permissões de WhatsApp e conexão desta conta."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.nora import router as nora_router
from app.modules.nora.router import AgentExecutePayload


def user(**permissions) -> dict:
    return {
        "id": "tenant-send",
        "nome": "Operador",
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"nora": True, "chat": False, "integracao_whatsapp": False, **permissions},
    }


CONNECTED = SimpleNamespace(exists=True, state="connected", instance_id="inst-1")


class AgentSendRouteTests(unittest.IsolatedAsyncioTestCase):
    async def send(self, account: dict, **payload) -> dict:
        body = AgentExecutePayload(conversa_id="5511999999999@c.us", texto="Olá!", autorizado=True, **payload)
        return await nora_router.enviar_rascunho_agente_mensagens(body, account)

    async def test_without_whatsapp_permission_nothing_is_sent(self) -> None:
        execute = AsyncMock(return_value={"status": "enviado", "sent": True})
        with patch.object(nora_router.agent_manager, "execute_message", execute), patch.object(nora_router, "owned_wapi_binding", return_value=CONNECTED):
            with self.assertRaises(HTTPException) as caught:
                await self.send(user(chat=True))
        self.assertEqual(403, caught.exception.status_code)
        execute.assert_not_awaited()

    async def test_disconnected_whatsapp_blocks_send(self) -> None:
        execute = AsyncMock()
        disconnected = SimpleNamespace(exists=False, state="disconnected", instance_id="")
        with patch.object(nora_router.agent_manager, "execute_message", execute), patch.object(nora_router, "owned_wapi_binding", return_value=disconnected):
            with self.assertRaises(HTTPException) as caught:
                await self.send(user(chat=True, integracao_whatsapp=True))
        self.assertEqual(409, caught.exception.status_code)
        execute.assert_not_awaited()

    async def test_missing_confirmation_blocks_send(self) -> None:
        execute = AsyncMock()
        with patch.object(nora_router.agent_manager, "execute_message", execute), patch.object(nora_router, "owned_wapi_binding", return_value=CONNECTED):
            with self.assertRaises(HTTPException) as caught:
                await nora_router.enviar_rascunho_agente_mensagens(
                    AgentExecutePayload(conversa_id="5511999999999@c.us", texto="Olá!"),
                    user(chat=True, integracao_whatsapp=True),
                )
        self.assertEqual(403, caught.exception.status_code)
        execute.assert_not_awaited()

    async def test_reviewed_draft_is_sent_with_permissions(self) -> None:
        execute = AsyncMock(return_value={"status": "enviado", "sent": True})
        with patch.object(nora_router.agent_manager, "execute_message", execute), patch.object(nora_router, "owned_wapi_binding", return_value=CONNECTED):
            result = await self.send(user(chat=True, integracao_whatsapp=True))
        self.assertEqual("enviado", result["status"])
        execute.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
