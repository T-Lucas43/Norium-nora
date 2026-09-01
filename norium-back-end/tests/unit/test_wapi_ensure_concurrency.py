from __future__ import annotations

import asyncio
import multiprocessing
import os
import queue
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from app.services import wapi_binding as wb
from app.services.wapi_client import WapiConfig, WapiError
from app.services.wapi_connect import WapiConnectService


_TEST_CREDENTIAL_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


def _client_config() -> WapiConfig:
    return WapiConfig(
        base_url="https://api.w-api.app",
        master_api_key="test-master",
        webhook_secret="",
    )


def _multiprocess_claim_worker(data_dir, barrier, result_queue, lease_owner) -> None:
    os.environ.update(
        {
            "NORIUM_DATA_DIR": data_dir,
            "ENVIRONMENT": "test",
            "APP_ENV": "test",
            "WAPI_CREDENTIAL_ENCRYPTION_KEY": _TEST_CREDENTIAL_KEY,
        }
    )
    try:
        barrier.wait(timeout=10)
        claim = wb.claim_provisioning(
            "tenant-processes",
            "norium-tenant-processes",
            lease_owner,
            lease_seconds=30,
        )
        result_queue.put(
            ("ok", claim.role, claim.attempt_id, claim.idempotency_key)
        )
    except Exception as exc:  # pragma: no cover - somente diagnóstico do worker
        result_queue.put(("error", type(exc).__name__, "", ""))


class _ScriptedClient:
    def __init__(self, create_results, *, instances=None) -> None:
        self.config = _client_config()
        self.configured = True
        self.create_results = list(create_results)
        self.instances = list(instances or [])
        self.create_calls = 0
        self.list_calls = 0

    async def list_instances(self):
        self.list_calls += 1
        return {"instances": list(self.instances)}

    async def create_instance(self, instance_name: str, **_kwargs):
        self.create_calls += 1
        result = self.create_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return {**result, "instanceName": instance_name}

    async def status(self, _instance_id: str, _token: str):
        return {"connected": False}


class _AmbiguousCreateClient(_ScriptedClient):
    def __init__(self) -> None:
        super().__init__([])

    async def create_instance(self, instance_name: str, **_kwargs):
        self.create_calls += 1
        self.instances = [
            {
                "instanceName": instance_name,
                "instanceId": "INSTANCE-REMOTE",
                "token": "remote-secret-token",
            }
        ]
        raise WapiError("resultado remoto incerto", code="network")


class _BlockingLifecycleClient(_ScriptedClient):
    def __init__(self) -> None:
        super().__init__([])
        self.create_started = asyncio.Event()
        self.release_create = asyncio.Event()
        self.disconnect_started = asyncio.Event()
        self.release_disconnect = asyncio.Event()
        self.disconnect_calls = 0

    async def create_instance(self, instance_name: str, **_kwargs):
        self.create_calls += 1
        self.create_started.set()
        await self.release_create.wait()
        return {
            "instanceId": "INSTANCE-BLOCKED",
            "token": "blocked-secret-token",
            "instanceName": instance_name,
        }

    async def disconnect(self, _instance_id: str, _token: str):
        self.disconnect_calls += 1
        self.disconnect_started.set()
        await self.release_disconnect.wait()
        return {}


class _ConcurrentCreateClient:
    """Força ambas as chamadas a observarem a lista remota ainda vazia."""

    def __init__(self) -> None:
        self.config = _client_config()
        self.configured = True
        self.list_calls = 0
        self.create_calls = 0
        self._both_listed = asyncio.Event()

    async def list_instances(self):
        self.list_calls += 1
        if self.list_calls == 1:
            try:
                await asyncio.wait_for(self._both_listed.wait(), timeout=0.15)
            except TimeoutError:
                # Depois da correção só o dono do lease consulta a W-API.
                pass
        else:
            self._both_listed.set()
        return {"instances": []}

    async def create_instance(self, instance_name: str, **_kwargs):
        self.create_calls += 1
        await asyncio.sleep(0)
        sequence = self.create_calls
        return {
            "instanceId": f"INSTANCE-{sequence}",
            "token": f"token-{sequence}",
            "instanceName": instance_name,
        }

    async def status(self, _instance_id: str, _token: str):
        return {"connected": False}


class WapiEnsureConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        self.temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(
            patch.dict(
                os.environ,
                {
                    "NORIUM_DATA_DIR": self.temp_dir,
                    "ENVIRONMENT": "test",
                    "APP_ENV": "test",
                    "WAPI_TEST_INSTANCE_ID": "",
                    "WAPI_TEST_INSTANCE_TOKEN": "",
                    "WAPI_TEST_TENANT_ID": "",
                    "WAPI_INSTANCE_LITE": "true",
                    "WAPI_PROVISIONING_POLL_SECONDS": "0.01",
                    "WAPI_PROVISIONING_WAIT_SECONDS": "2",
                    "WAPI_CREDENTIAL_ENCRYPTION_KEY": _TEST_CREDENTIAL_KEY,
                    "BACKEND_PUBLIC_URL": "",
                    "API_PUBLIC_URL": "",
                },
            )
        )

    def tearDown(self) -> None:
        self._stack.close()

    async def test_simultaneous_ensure_creates_exactly_one_remote_instance(self) -> None:
        client = _ConcurrentCreateClient()
        services = (WapiConnectService(client=client), WapiConnectService(client=client))
        start = asyncio.Barrier(2)

        async def ensure(service: WapiConnectService):
            await start.wait()
            return await service.ensure_instance("tenant-racing")

        first, second = await asyncio.wait_for(
            asyncio.gather(*(ensure(service) for service in services)),
            timeout=5,
        )

        self.assertEqual(1, client.create_calls)
        self.assertEqual(first.instance_id, second.instance_id)
        self.assertEqual(first.instance_id, wb.get_binding("tenant-racing").instance_id)
        self.assertEqual("active", wb.get_provisioning("tenant-racing").state)

    async def test_failed_creation_is_retryable_without_leaving_a_binding(self) -> None:
        client = _ScriptedClient(
            [
                WapiError("requisição rejeitada", status=400, code="invalid_request"),
                {"instanceId": "INSTANCE-RETRY", "token": "retry-secret-token"},
            ]
        )
        service = WapiConnectService(client=client)

        with self.assertRaises(WapiError) as first_error:
            await service.ensure_instance("tenant-retry")

        self.assertEqual("invalid_request", first_error.exception.code)
        self.assertFalse(wb.get_binding("tenant-retry").exists)
        self.assertEqual("failed", wb.get_provisioning("tenant-retry").state)

        binding = await service.ensure_instance("tenant-retry")

        self.assertEqual("INSTANCE-RETRY", binding.instance_id)
        self.assertEqual(2, client.create_calls)
        self.assertEqual("active", wb.get_provisioning("tenant-retry").state)

    async def test_ambiguous_create_failure_reconciles_instead_of_recreating(self) -> None:
        client = _AmbiguousCreateClient()
        service = WapiConnectService(client=client)

        with self.assertRaises(WapiError):
            await service.ensure_instance("tenant-ambiguous")

        self.assertEqual("failed", wb.get_provisioning("tenant-ambiguous").state)
        binding = await WapiConnectService(client=client).ensure_instance(
            "tenant-ambiguous"
        )

        self.assertEqual("INSTANCE-REMOTE", binding.instance_id)
        self.assertEqual(1, client.create_calls)
        self.assertEqual("active", wb.get_provisioning("tenant-ambiguous").state)

    async def test_remote_success_then_local_write_failure_recovers_same_instance(self) -> None:
        token = "very-secret-recovery-token"
        client = _ScriptedClient(
            [{"instanceId": "INSTANCE-RECOVER", "token": token}]
        )
        service = WapiConnectService(client=client)
        original_write = wb.write_account_db
        failed = False

        def fail_final_binding(user_id, db_name, payload):
            nonlocal failed
            if (
                not failed
                and db_name == "wapi_instance"
                and isinstance(payload, dict)
                and payload.get("instance_id") == "INSTANCE-RECOVER"
            ):
                failed = True
                raise OSError("simulated binding write failure")
            return original_write(user_id, db_name, payload)

        with self.assertLogs("app.services.wapi_connect", level="INFO") as logs:
            with patch.object(wb, "write_account_db", side_effect=fail_final_binding):
                with self.assertRaises(WapiError) as error:
                    await service.ensure_instance("tenant-persistence")

        self.assertEqual("binding_persistence_failed", error.exception.code)
        self.assertNotIn(token, str(error.exception))
        self.assertNotIn(token, "\n".join(logs.output))
        self.assertEqual(1, client.create_calls)
        self.assertFalse(wb.get_binding("tenant-persistence").exists)
        self.assertEqual("failed", wb.get_provisioning("tenant-persistence").state)
        self.assertNotIn(token.encode(), wb._registry_path().read_bytes())

        recovered = await WapiConnectService(client=client).ensure_instance(
            "tenant-persistence"
        )

        self.assertEqual("INSTANCE-RECOVER", recovered.instance_id)
        self.assertEqual(1, client.create_calls)
        self.assertEqual(
            "tenant-persistence", wb.owner_of_instance("INSTANCE-RECOVER")
        )
        self.assertEqual("active", wb.get_provisioning("tenant-persistence").state)

    async def test_abandoned_provisioning_reconciles_remote_instance(self) -> None:
        tenant = "tenant-abandoned"
        instance_name = f"norium-{tenant}"
        old_time = time.time() - 30
        abandoned = wb.claim_provisioning(
            tenant,
            instance_name,
            "dead-worker",
            lease_seconds=1,
            now=old_time,
        )
        wb.mark_remote_started(
            tenant,
            abandoned,
            lease_seconds=1,
            now=old_time,
        )
        client = _ScriptedClient(
            [],
            instances=[
                {
                    "instanceName": instance_name,
                    "instanceId": "INSTANCE-ORPHAN",
                    "token": "orphan-secret-token",
                }
            ],
        )

        binding = await WapiConnectService(client=client).ensure_instance(tenant)

        self.assertEqual("INSTANCE-ORPHAN", binding.instance_id)
        self.assertEqual(0, client.create_calls)
        self.assertEqual("active", wb.get_provisioning(tenant).state)

    async def test_lifecycle_is_observable_during_create_and_disconnect(self) -> None:
        client = _BlockingLifecycleClient()
        service = WapiConnectService(client=client)
        create_task = asyncio.create_task(service.ensure_instance("tenant-lifecycle"))
        try:
            await asyncio.wait_for(client.create_started.wait(), timeout=2)
            provisioning = await asyncio.wait_for(
                asyncio.to_thread(wb.get_provisioning, "tenant-lifecycle"),
                timeout=1,
            )
            self.assertEqual("provisioning", provisioning.state)
        finally:
            client.release_create.set()
        binding = await asyncio.wait_for(create_task, timeout=2)
        self.assertEqual("active", wb.get_provisioning("tenant-lifecycle").state)

        disconnect_task = asyncio.create_task(service.disconnect("tenant-lifecycle"))
        try:
            await asyncio.wait_for(client.disconnect_started.wait(), timeout=2)
            disconnecting = await asyncio.wait_for(
                asyncio.to_thread(wb.get_provisioning, "tenant-lifecycle"),
                timeout=1,
            )
            self.assertEqual("disconnecting", disconnecting.state)
            concurrent = wb.get_binding("tenant-lifecycle")
            concurrent.state = "connected"
            wb.save_binding("tenant-lifecycle", concurrent)
            self.assertEqual(
                "disconnecting", wb.get_provisioning("tenant-lifecycle").state
            )
            self.assertFalse(
                await WapiConnectService(client=client).disconnect("tenant-lifecycle")
            )
            self.assertEqual(1, client.disconnect_calls)
        finally:
            client.release_disconnect.set()
        self.assertTrue(await asyncio.wait_for(disconnect_task, timeout=2))
        self.assertEqual("active", wb.get_provisioning("tenant-lifecycle").state)
        self.assertEqual("disconnected", wb.get_binding("tenant-lifecycle").state)
        self.assertEqual("INSTANCE-BLOCKED", binding.instance_id)


class WapiProvisioningMultiprocessTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary.cleanup)
        self._environment = patch.dict(
            os.environ,
            {
                "NORIUM_DATA_DIR": self._temporary.name,
                "ENVIRONMENT": "test",
                "APP_ENV": "test",
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": _TEST_CREDENTIAL_KEY,
            },
        )
        self._environment.start()
        self.addCleanup(self._environment.stop)

    def test_only_one_process_acquires_the_provisioning_lease(self) -> None:
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(3)
        result_queue = context.Queue()
        processes = [
            context.Process(
                target=_multiprocess_claim_worker,
                args=(self._temporary.name, barrier, result_queue, f"worker-{index}"),
            )
            for index in range(2)
        ]
        try:
            for process in processes:
                process.start()
            barrier.wait(timeout=10)
            try:
                results = [result_queue.get(timeout=10) for _ in processes]
            except queue.Empty as exc:
                self.fail(f"worker de provisionamento não respondeu: {exc}")
            for process in processes:
                process.join(timeout=10)

            self.assertTrue(all(result[0] == "ok" for result in results), results)
            self.assertCountEqual(["owner", "wait"], [result[1] for result in results])
            self.assertEqual(1, len({result[2] for result in results}))
            self.assertEqual(1, len({result[3] for result in results}))
            self.assertTrue(all(process.exitcode == 0 for process in processes))
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=2)
            result_queue.close()


if __name__ == "__main__":
    unittest.main()
