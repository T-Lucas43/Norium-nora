from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.wapi_client import WapiClient, WapiConfig, WapiError
from app.services.wapi_connect import WapiConnectService, binding_plan


class InstancePlanTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {
            "NORIUM_DATA_DIR": temp_dir,
            "ENVIRONMENT": "", "APP_ENV": "",
            "WAPI_TEST_INSTANCE_ID": "", "WAPI_TEST_INSTANCE_TOKEN": "", "WAPI_TEST_TENANT_ID": "",
            "WAPI_INSTANCE_LITE": "",
            "RAILWAY_ENVIRONMENT": "", "RAILWAY_PROJECT_ID": "", "RAILWAY_SERVICE_ID": "",
            "VERCEL": "", "WEBSITE_INSTANCE_ID": "",
            "BACKEND_PUBLIC_URL": "", "API_PUBLIC_URL": "",
        }))
        self.client = WapiClient(WapiConfig(base_url="https://api.w-api.app", master_api_key="test-master", webhook_secret=""))

    def tearDown(self) -> None:
        self._stack.close()

    def _service(self, **client_overrides) -> WapiConnectService:
        for name, value in client_overrides.items():
            setattr(self.client, name, value)
        return WapiConnectService(client=self.client)

    async def test_lite_plan_reaches_create_instance(self) -> None:
        service = self._service(
            list_instances=AsyncMock(return_value=[]),
            create_instance=AsyncMock(return_value={"instanceId": "inst-lite", "token": "tok-lite"}),
        )
        binding = await service.ensure_instance("tenant-plan", plan="lite")
        self.assertEqual(binding.plan, "lite")
        self.assertEqual(binding.instance_name, "norium-tenant-plan")
        _, kwargs = self.client.create_instance.await_args
        self.assertTrue(kwargs["lite"])
        self.assertEqual(service.current_plan("tenant-plan"), "lite")

    async def test_pro_plan_uses_pro_suffix(self) -> None:
        service = self._service(
            list_instances=AsyncMock(return_value=[]),
            create_instance=AsyncMock(return_value={"instanceId": "inst-pro", "token": "tok-pro"}),
        )
        binding = await service.ensure_instance("tenant-plan", plan="pro")
        self.assertEqual(binding.plan, "pro")
        self.assertEqual(binding.instance_name, "norium-tenant-plan-pro")
        _, kwargs = self.client.create_instance.await_args
        self.assertFalse(kwargs["lite"])
        self.assertEqual(service.current_plan("tenant-plan"), "pro")

    async def test_invalid_plan_is_rejected_before_any_remote_call(self) -> None:
        service = self._service(
            list_instances=AsyncMock(return_value=[]),
            create_instance=AsyncMock(return_value={"instanceId": "inst-x", "token": "tok-x"}),
        )
        with self.assertRaises(WapiError) as error:
            await service.ensure_instance("tenant-plan", plan="ultra")
        self.assertEqual(error.exception.code, "invalid_plan")
        self.client.list_instances.assert_not_awaited()
        self.client.create_instance.assert_not_awaited()

    async def test_existing_binding_is_never_replaced_by_plan(self) -> None:
        service = self._service(
            list_instances=AsyncMock(return_value=[]),
            create_instance=AsyncMock(return_value={"instanceId": "inst-keep", "token": "tok-keep"}),
            status=AsyncMock(return_value={"connected": False}),
        )
        first = await service.ensure_instance("tenant-keep", plan="lite")
        second = await service.ensure_instance("tenant-keep", plan="pro")
        self.assertEqual(second.instance_id, first.instance_id)
        self.assertEqual(second.plan, "lite")
        self.assertEqual(service.current_plan("tenant-keep"), "lite")
        self.client.create_instance.assert_awaited_once()

    async def test_start_forwards_plan(self) -> None:
        service = self._service(
            list_instances=AsyncMock(return_value=[]),
            create_instance=AsyncMock(return_value={"instanceId": "inst-start", "token": "tok-start"}),
            status=AsyncMock(return_value={"connected": False}),
            qr_code=AsyncMock(return_value={"qrcode": "qr-code"}),
        )
        wb.record_consent("tenant-start", origin="test")
        await service.start("tenant-start", "pro")
        _, kwargs = self.client.create_instance.await_args
        self.assertFalse(kwargs["lite"])
        self.assertEqual(service.current_plan("tenant-start"), "pro")

    def test_binding_plan_derives_legacy_names(self) -> None:
        self.assertEqual(binding_plan(InstanceBinding(instance_id="i", token="t", instance_name="norium-x-pro")), "pro")
        self.assertEqual(binding_plan(InstanceBinding(instance_id="i", token="t", instance_name="norium-x")), "lite")
        self.assertIsNone(binding_plan(InstanceBinding(instance_id="i", token="t", instance_name="homologacao")))
        self.assertIsNone(binding_plan(InstanceBinding()))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
