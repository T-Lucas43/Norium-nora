from __future__ import annotations

import multiprocessing
import os
import queue
import sqlite3
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

from app.services import wapi_binding as wb


def _pending_journal_count() -> int:
    connection = sqlite3.connect(str(wb._registry_path()))
    try:
        row = connection.execute(
            "SELECT COUNT(*) FROM wapi_binding_journal"
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        connection.close()


def _save_after_synchronized_index_read(
    data_dir: str,
    encryption_key: str,
    tenant_id: str,
    instance_id: str,
    start_barrier: multiprocessing.synchronize.Barrier,
    index_read_barrier: multiprocessing.synchronize.Barrier,
    results: multiprocessing.queues.Queue,
) -> None:
    os.environ.update(
        {
            "ENVIRONMENT": "test",
            "NORIUM_DATA_DIR": data_dir,
            "WAPI_CREDENTIAL_ENCRYPTION_KEY": encryption_key,
        }
    )
    original_read = wb.read_json_file
    synchronized = False

    def synchronized_read(path: str | Path, fallback: object) -> object:
        nonlocal synchronized
        value = original_read(path, fallback)
        if not synchronized and Path(path).resolve() == Path(wb._index_path()).resolve():
            synchronized = True
            index_read_barrier.wait(timeout=10)
        return value

    try:
        with patch.object(wb, "read_json_file", side_effect=synchronized_read):
            start_barrier.wait(timeout=10)
            wb.save_binding(
                tenant_id,
                wb.InstanceBinding(instance_id=instance_id, token=f"token-{tenant_id}"),
            )
    except BaseException as exc:
        results.put(f"{type(exc).__name__}: {exc}")
    else:
        results.put(None)


def _interrupt_after_binding_write(
    data_dir: str,
    encryption_key: str,
    reached_commit: multiprocessing.synchronize.Barrier,
) -> None:
    os.environ.update(
        {
            "ENVIRONMENT": "test",
            "NORIUM_DATA_DIR": data_dir,
            "WAPI_CREDENTIAL_ENCRYPTION_KEY": encryption_key,
        }
    )

    def interrupt_before_commit(*_args: object, **_kwargs: object) -> None:
        reached_commit.wait(timeout=10)
        os._exit(23)

    with patch.object(
        wb,
        "_complete_binding_transaction",
        side_effect=interrupt_before_commit,
    ):
        wb.save_binding(
            "tenant-a",
            wb.InstanceBinding(instance_id="instance-new", token="token-new"),
        )


class WapiBindingConcurrencyTests(unittest.TestCase):
    def test_two_processes_saving_distinct_instances_keep_both_associations(self) -> None:
        context = multiprocessing.get_context("spawn")
        with tempfile.TemporaryDirectory() as data_dir:
            encryption_key = Fernet.generate_key().decode("ascii")
            environment = {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": encryption_key,
            }
            start_barrier = context.Barrier(2)
            index_read_barrier = context.Barrier(2)
            results = context.Queue()
            processes = [
                context.Process(
                    target=_save_after_synchronized_index_read,
                    args=(
                        data_dir,
                        encryption_key,
                        tenant_id,
                        instance_id,
                        start_barrier,
                        index_read_barrier,
                        results,
                    ),
                )
                for tenant_id, instance_id in (
                    ("tenant-a", "instance-a"),
                    ("tenant-b", "instance-b"),
                )
            ]

            try:
                for process in processes:
                    process.start()
                for process in processes:
                    process.join(timeout=15)

                for process in processes:
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=5)
                    self.assertEqual(0, process.exitcode)

                worker_results = []
                for _ in processes:
                    try:
                        worker_results.append(results.get(timeout=2))
                    except queue.Empty:
                        self.fail("processo concorrente terminou sem publicar resultado")
                self.assertEqual([None, None], worker_results)

                with patch.dict(os.environ, environment, clear=False):
                    self.assertEqual("tenant-a", wb.owner_of_instance("instance-a"))
                    self.assertEqual("tenant-b", wb.owner_of_instance("instance-b"))
            finally:
                for process in processes:
                    if process.pid is None:
                        continue
                    if process.is_alive():
                        process.terminate()
                    process.join(timeout=5)
                    process.close()
                results.close()
                results.join_thread()

    def test_updating_same_tenant_replaces_reverse_association(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir, patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-a",
                wb.InstanceBinding(
                    instance_id="instance-old",
                    token="token-old",
                    state="connected",
                ),
            )
            wb.save_binding(
                "tenant-a",
                wb.InstanceBinding(
                    instance_id="instance-new",
                    token="token-new",
                    state="connected",
                ),
            )

            self.assertIsNone(wb.owner_of_instance("instance-old"))
            self.assertEqual("tenant-a", wb.owner_of_instance("instance-new"))
            binding = wb.get_binding("tenant-a")
            self.assertEqual("instance-new", binding.instance_id)
            self.assertEqual("token-new", binding.token)

    def test_instance_conflict_preserves_both_tenants_previous_state(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir, patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-a",
                wb.InstanceBinding(instance_id="instance-a", token="token-a"),
            )
            wb.save_binding(
                "tenant-b",
                wb.InstanceBinding(instance_id="instance-b", token="token-b"),
            )

            with self.assertRaises(wb.InstanceOwnershipError):
                wb.save_binding(
                    "tenant-b",
                    wb.InstanceBinding(instance_id="instance-a", token="token-new"),
                )

            self.assertEqual("tenant-a", wb.owner_of_instance("instance-a"))
            self.assertEqual("tenant-b", wb.owner_of_instance("instance-b"))
            binding = wb.get_binding("tenant-b")
            self.assertEqual("instance-b", binding.instance_id)
            self.assertEqual("token-b", binding.token)

    def test_binding_write_failure_rolls_back_to_previous_state(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir, patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-a",
                wb.InstanceBinding(instance_id="instance-old", token="token-old"),
            )
            original_write = wb.write_account_db
            failed = False

            def fail_once(
                user_id: str,
                db_name: str,
                payload: object,
            ) -> None:
                nonlocal failed
                if not failed:
                    failed = True
                    raise OSError("simulated binding write failure")
                original_write(user_id, db_name, payload)

            with (
                patch.object(wb, "write_account_db", side_effect=fail_once),
                self.assertRaises(wb.BindingPersistenceError),
            ):
                wb.save_binding(
                    "tenant-a",
                    wb.InstanceBinding(
                        instance_id="instance-new",
                        token="token-new",
                    ),
                )

            self.assertEqual("tenant-a", wb.owner_of_instance("instance-old"))
            self.assertIsNone(wb.owner_of_instance("instance-new"))
            binding = wb.get_binding("tenant-a")
            self.assertEqual("instance-old", binding.instance_id)
            self.assertEqual("token-old", binding.token)
            self.assertEqual(0, _pending_journal_count())

    def test_corrupt_or_incomplete_index_is_recovered_from_transactional_state(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir, patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-a",
                wb.InstanceBinding(instance_id="instance-a", token="token-a"),
            )
            wb.save_binding(
                "tenant-b",
                wb.InstanceBinding(instance_id="instance-b", token="token-b"),
            )
            index_path = Path(wb._index_path())

            index_path.write_text('{"instance-a":', encoding="utf-8")
            self.assertEqual("tenant-a", wb.owner_of_instance("instance-a"))
            self.assertEqual("tenant-b", wb.owner_of_instance("instance-b"))
            expected = {
                "instance-a": "tenant-a",
                "instance-b": "tenant-b",
            }
            self.assertEqual(expected, wb.read_json_file(index_path, {}))

            wb.write_json_file(index_path, {"instance-a": "tenant-a"})
            self.assertEqual("tenant-b", wb.owner_of_instance("instance-b"))
            self.assertEqual(expected, wb.read_json_file(index_path, {}))

    def test_legacy_binding_recovers_raw_tenant_id_from_user_store(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir, patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        ):
            tenant_id = "tenant@example.com"
            wb.write_json_file(
                wb.get_system_db_path("usuarios"),
                {"users": [{"id": tenant_id}]},
            )
            wb.write_account_db(
                tenant_id,
                "wapi_instance",
                asdict(
                    wb.InstanceBinding(
                        instance_id="instance-legacy",
                        token="token-legacy",
                    )
                ),
            )
            Path(wb._index_path()).write_text("{interrompido", encoding="utf-8")

            self.assertEqual(
                tenant_id,
                wb.owner_of_instance("instance-legacy"),
            )
            self.assertEqual(
                {"instance-legacy": tenant_id},
                wb.read_json_file(wb._index_path(), {}),
            )

    def test_interrupted_save_is_rolled_back_on_next_access(self) -> None:
        context = multiprocessing.get_context("spawn")
        with tempfile.TemporaryDirectory() as data_dir:
            encryption_key = Fernet.generate_key().decode("ascii")
            environment = {
                "ENVIRONMENT": "test",
                "NORIUM_DATA_DIR": data_dir,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": encryption_key,
            }
            with patch.dict(os.environ, environment, clear=False):
                wb.save_binding(
                    "tenant-a",
                    wb.InstanceBinding(
                        instance_id="instance-old",
                        token="token-old",
                    ),
                )

            reached_commit = context.Barrier(2)
            process = context.Process(
                target=_interrupt_after_binding_write,
                args=(data_dir, encryption_key, reached_commit),
            )
            try:
                process.start()
                reached_commit.wait(timeout=10)
                process.join(timeout=10)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
                self.assertEqual(23, process.exitcode)
            finally:
                if process.pid is not None:
                    if process.is_alive():
                        process.terminate()
                    process.join(timeout=5)
                    process.close()

            with patch.dict(os.environ, environment, clear=False):
                recovered = wb.get_binding("tenant-a")
                self.assertEqual("instance-old", recovered.instance_id)
                self.assertEqual("token-old", recovered.token)
                self.assertEqual(
                    "tenant-a",
                    wb.owner_of_instance("instance-old"),
                )
                self.assertIsNone(wb.owner_of_instance("instance-new"))
                self.assertEqual(0, _pending_journal_count())


if __name__ == "__main__":
    unittest.main()
