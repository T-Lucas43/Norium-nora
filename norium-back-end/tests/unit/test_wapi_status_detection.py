from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.wapi_client import WapiConfig


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


class WapiStatusDetectionTests(unittest.IsolatedAsyncioTestCase):
    """Vínculo confirmado pelo webhook deve vencer um status-instance atrasado.

    Reproduz o bug de produção: aparelho vinculado (segue em "Aparelhos
    conectados"), mas ``status-instance`` da W-API ainda responde
    ``connected:false`` logo após o pareamento. O ``status()`` precisa confirmar
    o vínculo pelo ``/instance/device`` em vez de voltar a exibir o QR.
    """

    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(
            patch.dict(
                os.environ,
                {
                    "NORIUM_DATA_DIR": temp_dir,
                    "WAPI_TEST_INSTANCE_ID": "TEST-INSTANCE",
                    "WAPI_TEST_INSTANCE_TOKEN": "test-token",
                },
            )
        )
        client = chat_router.wapi_connect._client
        self._stack.enter_context(
            patch.object(
                client, "_config",
                WapiConfig(base_url="https://api.w-api.app", master_api_key="test-master", webhook_secret=""),
            )
        )
        # status-instance MENTE: reporta desconectado mesmo com o aparelho vinculado.
        self._stack.enter_context(
            patch.object(client, "status", AsyncMock(return_value={"connected": False, "instanceId": "TEST-INSTANCE"}))
        )
        self._stack.enter_context(
            patch.object(
                client, "qr_code",
                AsyncMock(return_value={"error": False, "qrcode": "data:image/png;base64,AAAA"}),
            )
        )
        # Limpa o cache de QR entre testes (o service é singleton do módulo).
        chat_router.wapi_connect._qr_cache.clear()

    def tearDown(self) -> None:
        self._stack.close()

    async def _bind_with_prior_connection(self, user_id: str) -> None:
        """Vincula a instância de homologação e marca connected_at (como o webhook)."""
        wb.record_consent(user_id, origin="test")
        await chat_router.wapi_connect.ensure_instance(user_id)
        binding = wb.get_binding(user_id)
        binding.state = "connected"
        binding.connected_at = 1_700_000_000.0
        wb.save_binding(user_id, binding)

    async def test_device_confirms_connection_when_status_lags(self) -> None:
        user = chat_user("user-a")
        await self._bind_with_prior_connection(user["id"])
        client = chat_router.wapi_connect._client
        with patch.object(
            client, "device",
            AsyncMock(return_value={"connectedPhone": "5511999999999", "name": "Nando"}),
        ):
            result = await chat_router.wapi_connect.status(user["id"])
        self.assertEqual("conectado", result["status"])
        self.assertEqual("connected", result["state"])
        self.assertEqual("5511999999999", result["numero"])

    async def test_falls_back_to_qr_when_device_also_disconnected(self) -> None:
        from app.services.wapi_client import WapiError

        user = chat_user("user-b")
        await self._bind_with_prior_connection(user["id"])
        client = chat_router.wapi_connect._client
        with patch.object(client, "device", AsyncMock(side_effect=WapiError("Whatsapp não conectado", status=401))):
            result = await chat_router.wapi_connect.status(user["id"])
        self.assertEqual("aguardando_qrcode", result["status"])
        self.assertTrue(result["qrcode"])
        self.assertIsNone(wb.get_binding(user["id"]).connected_at)

    async def test_connected_webhook_wins_against_stale_status_response(self) -> None:
        user = chat_user("user-race-status")
        wb.record_consent(user["id"], origin="test")
        await chat_router.wapi_connect.ensure_instance(user["id"])

        async def stale_status(*_args, **_kwargs):
            binding = wb.get_binding(user["id"])
            binding.state = "connected"
            binding.connected_at = time.time()
            wb.save_binding(user["id"], binding)
            return {"connected": False}

        client = chat_router.wapi_connect._client
        with (
            patch.object(client, "status", AsyncMock(side_effect=stale_status)),
            patch.object(client, "device", AsyncMock(return_value={"connectedPhone": "5511999999999"})),
        ):
            result = await chat_router.wapi_connect.status(user["id"])

        self.assertEqual("conectado", result["status"])
        self.assertEqual("connected", wb.get_binding(user["id"]).state)

    async def test_connected_webhook_wins_while_qr_is_being_fetched(self) -> None:
        user = chat_user("user-race-qr")
        wb.record_consent(user["id"], origin="test")
        await chat_router.wapi_connect.ensure_instance(user["id"])
        client = chat_router.wapi_connect._client

        async def qr_after_connected(*_args, **_kwargs):
            binding = wb.get_binding(user["id"])
            binding.state = "connected"
            binding.connected_at = time.time()
            wb.save_binding(user["id"], binding)
            return {"qrcode": "QR-OBSOLETO"}

        with patch.object(client, "qr_code", AsyncMock(side_effect=qr_after_connected)):
            result = await chat_router.wapi_connect.status(user["id"])

        self.assertEqual("conectado", result["status"])
        self.assertIsNone(result["qrcode"])
        self.assertEqual("connected", wb.get_binding(user["id"]).state)

    async def test_concurrent_forced_qr_requests_share_one_generation(self) -> None:
        client = chat_router.wapi_connect._client
        release = asyncio.Event()
        started = asyncio.Event()

        async def delayed_qr(*_args, **_kwargs):
            started.set()
            await release.wait()
            return {"qrcode": "QR-ESTAVEL"}

        qr_mock = AsyncMock(side_effect=delayed_qr)
        with patch.object(client, "qr_code", qr_mock):
            first = asyncio.create_task(chat_router.wapi_connect._stable_qr("INST-RACE", "tok", force=True))
            await started.wait()
            second = asyncio.create_task(chat_router.wapi_connect._stable_qr("INST-RACE", "tok", force=True))
            await asyncio.sleep(0)
            release.set()
            results = await asyncio.gather(first, second)

        self.assertEqual(["QR-ESTAVEL", "QR-ESTAVEL"], results)
        self.assertEqual(1, qr_mock.await_count)

    async def test_no_device_probe_without_prior_connection(self) -> None:
        # Sem sinal do webhook (connected_at None, state != connected) não deve
        # sondar device — segue direto para o QR.
        user = chat_user("user-c")
        wb.record_consent(user["id"], origin="test")
        await chat_router.wapi_connect.ensure_instance(user["id"])
        client = chat_router.wapi_connect._client
        device_mock = AsyncMock(return_value={"connectedPhone": "5511000000000"})
        with patch.object(client, "device", device_mock):
            result = await chat_router.wapi_connect.status(user["id"])
        device_mock.assert_not_called()
        self.assertEqual("aguardando_qrcode", result["status"])


if __name__ == "__main__":
    unittest.main()
