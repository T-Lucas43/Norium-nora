from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services.wapi_client import WapiClient, WapiConfig
from app.services.wapi_connect import WapiConnectService


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class WapiConsentGateTests(unittest.IsolatedAsyncioTestCase):
    """Valida a etapa obrigatória de aceite antes do QR e o isolamento por conta."""

    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(
            patch.dict(
                os.environ,
                {
                    "NORIUM_DATA_DIR": temp_dir,
                    "ENVIRONMENT": "test",
                    "WAPI_TEST_INSTANCE_ID": "TEST-INSTANCE",
                    "WAPI_TEST_INSTANCE_TOKEN": "test-token",
                    "WAPI_TEST_TENANT_ID": "user-a",
                    "BACKEND_PUBLIC_URL": "",
                    "API_PUBLIC_URL": "",
                },
            )
        )
        # Garante configuração válida em CI (sem .env) para não cair no atalho
        # "indisponivel" antes do consent gate.
        service = WapiConnectService(
            client=WapiClient(
                WapiConfig(
                    base_url="https://api.w-api.app",
                    master_api_key="test-master",
                    webhook_secret="",
                )
            )
        )
        self._stack.enter_context(patch.object(chat_router, "wapi_connect", service))
        client = service._client
        # Mocka a rede da W-API: instância desconectada com QR disponível.
        self._stack.enter_context(
            patch.object(client, "status", AsyncMock(return_value={"connected": False, "instanceId": "TEST-INSTANCE"}))
        )
        self._stack.enter_context(
            patch.object(
                client, "qr_code",
                AsyncMock(return_value={"error": False, "qrcode": "data:image/png;base64,AAAA"}),
            )
        )

    def tearDown(self) -> None:
        self._stack.close()

    async def test_qr_is_blocked_without_consent(self) -> None:
        payload = chat_router.InicializarLoginPayload(canal="whatsapp")
        with self.assertRaises(HTTPException) as error:
            await chat_router.inicializar_login(payload, chat_user("user-a"))
        self.assertEqual(403, error.exception.status_code)
        detail = error.exception.detail
        self.assertIsInstance(detail, dict)
        self.assertEqual("consent_required", detail.get("code"))

    async def test_consent_requires_explicit_acceptance(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.registrar_consentimento(
                chat_router.ConsentimentoPayload(aceito=False), chat_user("user-a")
            )
        self.assertEqual(400, error.exception.status_code)

    async def test_qr_flows_after_consent(self) -> None:
        user = chat_user("user-a")
        accepted = await chat_router.registrar_consentimento(
            chat_router.ConsentimentoPayload(aceito=True), user
        )
        self.assertTrue(accepted["accepted"])

        payload = chat_router.InicializarLoginPayload(canal="whatsapp")
        result = await chat_router.inicializar_login(payload, user)
        self.assertEqual("aguardando_qrcode", result["status"])
        self.assertTrue(result["qrcode"])

    async def test_consent_does_not_leak_across_accounts(self) -> None:
        # Usuário A aceita; usuário B continua sem aceite e sem QR.
        await chat_router.registrar_consentimento(
            chat_router.ConsentimentoPayload(aceito=True), chat_user("user-a")
        )
        status_b = await chat_router.obter_status_canais(user=chat_user("user-b"))
        whatsapp_b = status_b["whatsapp"]
        self.assertEqual("aguardando_aceite", whatsapp_b["status"])
        self.assertTrue(whatsapp_b["consentRequired"])

        with self.assertRaises(HTTPException) as error:
            await chat_router.inicializar_login(
                chat_router.InicializarLoginPayload(canal="whatsapp"), chat_user("user-b")
            )
        self.assertEqual(403, error.exception.status_code)

    async def test_stale_term_version_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await chat_router.registrar_consentimento(
                chat_router.ConsentimentoPayload(aceito=True, versao="1900-01-01"), chat_user("user-a")
            )
        self.assertEqual(409, error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
