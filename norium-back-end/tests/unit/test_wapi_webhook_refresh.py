from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.wapi_client import WapiConfig, WapiError
from app.services.wapi_connect import WapiConnectService


class WapiWebhookRefreshTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        data_dir = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": data_dir}, clear=False))

    def tearDown(self) -> None:
        self.stack.close()

    async def test_existing_instance_receives_all_official_webhook_updates(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="hook-secret",
        )
        client.status.return_value = {"connected": True}
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-hooks",
            InstanceBinding(instance_id="INST-HOOKS", token="token-hooks", state="connected"),
        )

        with patch.dict(
            os.environ,
            {"BACKEND_PUBLIC_URL": "https://api.norium.example", "API_PUBLIC_URL": ""},
            clear=False,
        ):
            await service.ensure_instance("user-hooks")

        configured_events = [call.args[2] for call in client.set_webhook.await_args_list]
        self.assertEqual(
            [
                "connected",
                "disconnected",
                "delivery",
                "received",
                "message-status",
                "chat-presence",
            ],
            configured_events,
        )
        for call in client.set_webhook.await_args_list:
            self.assertEqual("https://api.norium.example/api/whatsapp/webhook", call.args[3])

    async def test_loopback_url_is_never_registered(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.status.return_value = {"connected": True}
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-local",
            InstanceBinding(instance_id="INST-LOCAL", token="token-local", state="connected"),
        )

        with patch.dict(
            os.environ,
            {"BACKEND_PUBLIC_URL": "http://127.0.0.1:8000", "API_PUBLIC_URL": ""},
            clear=False,
        ):
            await service.ensure_instance("user-local")

        client.set_webhook.assert_not_awaited()

    async def test_public_http_url_is_not_registered_because_wapi_requires_https(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.status.return_value = {"connected": True}
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-http",
            InstanceBinding(instance_id="INST-HTTP", token="token-http", state="connected"),
        )

        with patch.dict(
            os.environ,
            {"BACKEND_PUBLIC_URL": "http://api.norium.example", "API_PUBLIC_URL": ""},
            clear=False,
        ):
            await service.ensure_instance("user-http")

        client.set_webhook.assert_not_awaited()

    async def test_private_https_ip_is_not_registered(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.status.return_value = {"connected": True}
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-private",
            InstanceBinding(instance_id="INST-PRIVATE", token="token-private", state="connected"),
        )

        with patch.dict(os.environ, {"BACKEND_PUBLIC_URL": "https://10.0.0.8"}, clear=False):
            await service.ensure_instance("user-private")

        client.set_webhook.assert_not_awaited()

    async def test_one_rejected_webhook_does_not_break_existing_binding(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.status.return_value = {"connected": True}
        attempts: dict[str, int] = {}

        async def set_webhook(_instance: str, _token: str, event: str, _url: str) -> None:
            attempts[event] = attempts.get(event, 0) + 1
            if event == "connected" and attempts[event] == 1:
                raise WapiError("temporario", status=503)

        client.set_webhook.side_effect = set_webhook
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-retry",
            InstanceBinding(instance_id="INST-RETRY", token="token-retry", state="connected"),
        )

        with patch.dict(os.environ, {"BACKEND_PUBLIC_URL": "https://api.norium.example"}, clear=False):
            binding = await service.ensure_instance("user-retry")

        self.assertEqual("INST-RETRY", binding.instance_id)
        self.assertEqual(7, client.set_webhook.await_count)
        self.assertEqual(2, attempts["connected"])

    async def test_transient_status_error_preserves_binding(self) -> None:
        client = AsyncMock()
        client.config = WapiConfig(
            base_url="https://api.w-api.app",
            master_api_key="master",
            webhook_secret="",
        )
        client.status.side_effect = WapiError("temporario", status=503)
        service = WapiConnectService(client=client)
        wb.save_binding(
            "user-transient",
            InstanceBinding(instance_id="INST-STABLE", token="token-stable", state="connected"),
        )

        with self.assertRaises(WapiError):
            await service.ensure_instance("user-transient")

        self.assertEqual("INST-STABLE", wb.get_binding("user-transient").instance_id)
        client.create_instance.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
