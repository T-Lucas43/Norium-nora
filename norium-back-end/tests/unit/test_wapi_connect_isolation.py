from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.core.tenant import get_system_db_path, read_json_file, write_account_db
from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.wapi_client import WapiClient, WapiConfig, WapiError
from app.services.wapi_connect import (
    WapiConnectService,
    validate_wapi_test_configuration,
)
from app.services.wapi_messaging import MessagingUnavailable, WapiMessagingService


_HOMOLOG_ENV = {
    "ENVIRONMENT": "test",
    "WAPI_TEST_INSTANCE_ID": "TEST-INSTANCE",
    "WAPI_TEST_INSTANCE_TOKEN": "secret-test-token",
    "WAPI_TEST_TENANT_ID": "tenant-authorized",
    "BACKEND_PUBLIC_URL": "",
    "API_PUBLIC_URL": "",
}


class WapiHomologationIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}))
        self.client = WapiClient(
            WapiConfig(
                base_url="https://api.w-api.app",
                master_api_key="test-master",
                webhook_secret="",
            )
        )
        self.client.disconnect = AsyncMock(return_value={})

    def tearDown(self) -> None:
        self._stack.close()

    def _environment(self, **overrides: str):
        values = {
            "ENVIRONMENT": "",
            "APP_ENV": "",
            "WAPI_TEST_INSTANCE_ID": "",
            "WAPI_TEST_INSTANCE_TOKEN": "",
            "WAPI_TEST_TENANT_ID": "",
            "RAILWAY_ENVIRONMENT": "",
            "RAILWAY_PROJECT_ID": "",
            "RAILWAY_SERVICE_ID": "",
            "VERCEL": "",
            "WEBSITE_INSTANCE_ID": "",
            "BACKEND_PUBLIC_URL": "",
            "API_PUBLIC_URL": "",
        }
        values.update(overrides)
        return patch.dict(os.environ, values)

    async def test_only_explicit_homologation_tenant_can_use_test_instance(self) -> None:
        with self._environment(**_HOMOLOG_ENV):
            service = WapiConnectService(client=self.client)
            authorized = await service.ensure_instance("tenant-authorized")

            with self.assertRaises(WapiError) as error:
                await service.ensure_instance("tenant-not-authorized")

        self.assertEqual("TEST-INSTANCE", authorized.instance_id)
        self.assertEqual("homologation_tenant_mismatch", error.exception.code)
        self.assertFalse(wb.get_binding("tenant-not-authorized").exists)
        self.assertEqual("tenant-authorized", wb.owner_of_instance("TEST-INSTANCE"))
        self.assertNotIn(
            _HOMOLOG_ENV["WAPI_TEST_INSTANCE_TOKEN"],
            str(error.exception),
        )
        self.client.disconnect.assert_not_awaited()

    async def test_second_tenant_cannot_claim_homologation_instance(self) -> None:
        with self._environment(**_HOMOLOG_ENV):
            service = WapiConnectService(client=self.client)
            first = await service.ensure_instance("tenant-authorized")

            with self.assertRaises(WapiError) as error:
                await service.ensure_instance("tenant-b")

        self.assertEqual("TEST-INSTANCE", first.instance_id)
        self.assertEqual("homologation_tenant_mismatch", error.exception.code)
        self.assertTrue(wb.get_binding("tenant-authorized").exists)
        self.assertFalse(wb.get_binding("tenant-b").exists)
        self.assertEqual("tenant-authorized", wb.owner_of_instance("TEST-INSTANCE"))
        self.client.disconnect.assert_not_awaited()

    async def test_existing_owner_is_never_overwritten(self) -> None:
        wb.save_binding(
            "tenant-existing-owner",
            InstanceBinding(
                instance_id="TEST-INSTANCE",
                token="existing-owner-token",
                instance_name="existing",
                state="connected",
            ),
        )

        with self._environment(**_HOMOLOG_ENV):
            service = WapiConnectService(client=self.client)
            with self.assertRaises(WapiError) as error:
                await service.ensure_instance("tenant-authorized")

        self.assertEqual("instance_owned_by_another_tenant", error.exception.code)
        self.assertEqual("tenant-existing-owner", wb.owner_of_instance("TEST-INSTANCE"))
        self.assertFalse(wb.get_binding("tenant-authorized").exists)
        self.assertEqual(
            "existing-owner-token",
            wb.get_binding("tenant-existing-owner").token,
        )
        self.client.disconnect.assert_not_awaited()

    def test_test_credentials_are_rejected_in_shared_environments(self) -> None:
        for environment in ("production", "prod", "railway", "staging"):
            with self.subTest(environment=environment):
                with self._environment(**{**_HOMOLOG_ENV, "ENVIRONMENT": environment}):
                    with self.assertRaises(RuntimeError) as error:
                        validate_wapi_test_configuration()
                self.assertNotIn(_HOMOLOG_ENV["WAPI_TEST_INSTANCE_TOKEN"], str(error.exception))

    def test_shared_runtime_marker_overrides_test_environment(self) -> None:
        with self._environment(**_HOMOLOG_ENV, RAILWAY_PROJECT_ID="shared-project"):
            with self.assertRaises(RuntimeError):
                WapiConnectService(client=self.client)

    def test_homologation_tenant_is_required(self) -> None:
        with self._environment(
            ENVIRONMENT="test",
            WAPI_TEST_INSTANCE_ID="TEST-INSTANCE",
            WAPI_TEST_INSTANCE_TOKEN="secret-test-token",
        ):
            with self.assertRaises(RuntimeError) as error:
                WapiConnectService(client=self.client)
        self.assertNotIn("secret-test-token", str(error.exception))

    async def test_absent_test_variables_leave_homologation_disabled(self) -> None:
        with self._environment(ENVIRONMENT="production"):
            service = WapiConnectService(client=self.client)
            with self.assertRaises(WapiError) as error:
                await service.ensure_instance("tenant-a", allow_create=False)

        self.assertEqual("no_instance", error.exception.code)
        self.assertFalse(wb.get_binding("tenant-a").exists)

    def test_binding_store_rejects_owner_overwrite(self) -> None:
        wb.save_binding(
            "tenant-a",
            InstanceBinding(instance_id="INSTANCE-A", token="token-a"),
        )

        with self.assertRaises(wb.InstanceOwnershipError):
            wb.save_binding(
                "tenant-b",
                InstanceBinding(instance_id="INSTANCE-A", token="token-b"),
            )

        self.assertEqual("tenant-a", wb.owner_of_instance("INSTANCE-A"))
        self.assertFalse(wb.get_binding("tenant-b").exists)

    def test_orphaned_owner_index_requires_explicit_reconciliation(self) -> None:
        wb.save_binding(
            "tenant-a",
            InstanceBinding(instance_id="INSTANCE-A", token="token-a"),
        )
        write_account_db("tenant-a", "wapi_instance", asdict(InstanceBinding()))

        with self.assertRaises(wb.InstanceOwnershipError):
            wb.save_binding(
                "tenant-b",
                InstanceBinding(instance_id="INSTANCE-A", token="token-b"),
            )

        index = read_json_file(get_system_db_path("wapi_instance_index"), {})
        self.assertEqual("tenant-a", index.get("INSTANCE-A"))
        self.assertFalse(wb.get_binding("tenant-b").exists)

    async def test_legacy_duplicate_binding_cannot_use_wapi_credentials(self) -> None:
        wb.save_binding(
            "tenant-owner",
            InstanceBinding(
                instance_id="LEGACY-DUPLICATE",
                token="owner-token",
                state="connected",
            ),
        )
        wb.record_consent("tenant-legacy", origin="test")
        duplicate = wb.get_binding("tenant-legacy")
        duplicate.instance_id = "LEGACY-DUPLICATE"
        duplicate.token = "legacy-token"
        duplicate.state = "connected"
        write_account_db("tenant-legacy", "wapi_instance", asdict(duplicate))

        self.client.status = AsyncMock(return_value={"connected": True})
        self.client.qr_code = AsyncMock(return_value={"qrcode": "must-not-be-used"})
        self.client.send_text = AsyncMock(return_value={"messageId": "must-not-be-used"})

        with self._environment(ENVIRONMENT="test"):
            service = WapiConnectService(client=self.client)
            with self.assertRaises(WapiError) as ensure_error:
                await service.ensure_instance("tenant-legacy")
            with self.assertRaises(WapiError):
                await service.status("tenant-legacy")
            with self.assertRaises(WapiError):
                await service.qr("tenant-legacy")
            messaging = WapiMessagingService(client=self.client)
            with self.assertRaises(MessagingUnavailable):
                await messaging.send_text("tenant-legacy", "5511999999999", "teste")
            from app.modules.chat import router as chat_router

            self.assertIsNone(chat_router.wapi_creds("tenant-legacy"))

        self.assertEqual("instance_owned_by_another_tenant", ensure_error.exception.code)
        self.assertTrue(wb.get_binding("tenant-legacy").exists)
        self.assertEqual("tenant-owner", wb.owner_of_instance("LEGACY-DUPLICATE"))
        self.client.status.assert_not_awaited()
        self.client.qr_code.assert_not_awaited()
        self.client.send_text.assert_not_awaited()
        self.client.disconnect.assert_not_awaited()

    async def test_legacy_transferred_homologation_owner_cannot_receive_webhook(self) -> None:
        with self._environment(ENVIRONMENT="test"):
            wb.save_binding(
                "tenant-not-authorized",
                InstanceBinding(
                    instance_id="TEST-INSTANCE",
                    token="legacy-transferred-token",
                    state="connected",
                ),
            )

        self.client.send_text = AsyncMock(return_value={"messageId": "must-not-be-used"})
        with self._environment(**_HOMOLOG_ENV):
            self.assertIsNone(wb.owner_of_instance("TEST-INSTANCE"))
            messaging = WapiMessagingService(client=self.client)
            with self.assertRaises(MessagingUnavailable):
                await messaging.send_text(
                    "tenant-not-authorized",
                    "5511999999999",
                    "teste",
                )

            from app.modules.chat import router as chat_router

            request = SimpleNamespace(query_params={}, headers={})
            with patch.object(chat_router, "WAPI_WEBHOOK_SECRET", ""):
                with self.assertRaises(HTTPException) as webhook_error:
                    await chat_router.webhook_whatsapp(
                        {"instanceId": "TEST-INSTANCE"},
                        request=request,
                    )

        self.assertEqual(404, webhook_error.exception.status_code)
        self.assertTrue(wb.get_binding("tenant-not-authorized").exists)
        with self._environment(ENVIRONMENT="test"):
            self.assertEqual(
                "tenant-not-authorized",
                wb.owner_of_instance("TEST-INSTANCE"),
            )
        self.client.send_text.assert_not_awaited()
        self.client.disconnect.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
