from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import tempfile
import unittest
from contextlib import ExitStack
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

from app.core.credentials import (
    CredentialConfigurationError,
    CredentialRecoveryError,
    FernetCredentialStore,
)
from app.core.tenant import get_account_db_path, write_account_db, write_json_file
from app.services import wapi_binding as wb
from app.services.wapi_credentials import wapi_credential_store


class WapiBindingCredentialPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.data_dir = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(
            patch.dict(
                os.environ,
                {
                    "ENVIRONMENT": "test",
                    "NORIUM_DATA_DIR": self.data_dir,
                    "WAPI_CREDENTIAL_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
                },
                clear=False,
            )
        )

    def tearDown(self) -> None:
        self.stack.close()

    def _binding_path(self, user_id: str) -> Path:
        return Path(get_account_db_path(user_id, "wapi_instance"))

    def _stored_payload(self, user_id: str) -> dict[str, object]:
        return json.loads(self._binding_path(user_id).read_text(encoding="utf-8"))

    def test_persisted_binding_never_contains_plaintext_token(self) -> None:
        token = "wapi-token-plaintext-regression"

        wb.save_binding(
            "tenant-security",
            wb.InstanceBinding(
                instance_id="INSTANCE-SECURITY",
                token=token,
                state="connected",
            ),
        )

        stored = self._binding_path("tenant-security").read_text(encoding="utf-8")
        self.assertNotIn(token, stored)

    def test_encryption_round_trip_preserves_non_credential_binding_data(self) -> None:
        token = "wapi-roundtrip-secret"
        binding = wb.InstanceBinding(
            instance_id="INSTANCE-ROUNDTRIP",
            token=token,
            instance_name="Atendimento",
            state="connected",
            created_at=123.0,
            connected_at=456.0,
            consent={"term_version": "v-test", "accepted_at": 12.0, "origin": "test"},
        )

        wb.save_binding("tenant-roundtrip", binding)
        recovered = wb.get_binding("tenant-roundtrip")
        persisted = self._stored_payload("tenant-roundtrip")

        self.assertEqual(token, recovered.token)
        self.assertEqual(binding.instance_id, recovered.instance_id)
        self.assertEqual(binding.instance_name, recovered.instance_name)
        self.assertEqual(binding.state, recovered.state)
        self.assertEqual(binding.created_at, recovered.created_at)
        self.assertEqual(binding.connected_at, recovered.connected_at)
        self.assertEqual(binding.consent, recovered.consent)
        self.assertNotIn("token", persisted)
        self.assertIsInstance(persisted.get("credential"), dict)

    def test_authenticated_encryption_detects_tampered_content(self) -> None:
        token = "wapi-tamper-secret"
        wb.save_binding(
            "tenant-tamper",
            wb.InstanceBinding(instance_id="INSTANCE-TAMPER", token=token),
        )
        persisted = self._stored_payload("tenant-tamper")
        credential = dict(persisted["credential"])
        ciphertext = str(credential["ciphertext"])
        position = len(ciphertext) // 2
        replacement = "A" if ciphertext[position] != "A" else "B"
        credential["ciphertext"] = ciphertext[:position] + replacement + ciphertext[position + 1 :]
        persisted["credential"] = credential
        self._binding_path("tenant-tamper").write_text(json.dumps(persisted), encoding="utf-8")

        with self.assertRaises(CredentialRecoveryError) as error:
            wb.get_binding("tenant-tamper")

        self.assertNotIn(token, str(error.exception))
        self.assertIsNone(error.exception.__cause__)
        self.assertIsNone(error.exception.__context__)

    def test_legacy_plaintext_record_is_read_once_and_rewritten_encrypted(self) -> None:
        token = "wapi-legacy-migration-secret"
        legacy = asdict(
            wb.InstanceBinding(
                instance_id="INSTANCE-LEGACY",
                token=token,
                instance_name="Legado",
                state="connected",
                created_at=111.0,
            )
        )
        legacy["future_field"] = {"must": "survive"}
        write_account_db("tenant-legacy", "wapi_instance", legacy)

        recovered = wb.get_binding("tenant-legacy")
        migrated_text = self._binding_path("tenant-legacy").read_text(encoding="utf-8")
        migrated = json.loads(migrated_text)

        self.assertEqual(token, recovered.token)
        self.assertEqual("Legado", recovered.instance_name)
        self.assertNotIn(token, migrated_text)
        self.assertNotIn("token", migrated)
        self.assertEqual({"must": "survive"}, migrated["future_field"])
        self.assertIsInstance(migrated.get("credential"), dict)

    def test_wrong_key_fails_without_credential_in_exception_or_logs(self) -> None:
        token = "wapi-wrong-key-secret"
        original_key = Fernet.generate_key().decode("ascii")
        wrong_key = Fernet.generate_key().decode("ascii")
        with patch.dict(
            os.environ,
            {
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": original_key,
                "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS": "",
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-wrong-key",
                wb.InstanceBinding(instance_id="INSTANCE-WRONG-KEY", token=token),
            )
        ciphertext = str(self._stored_payload("tenant-wrong-key")["credential"])

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "WAPI_CREDENTIAL_ENCRYPTION_KEY": wrong_key,
                        "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS": "",
                    },
                    clear=False,
                ),
                self.assertRaises(CredentialRecoveryError) as error,
            ):
                wb.get_binding("tenant-wrong-key")
        finally:
            root_logger.removeHandler(handler)

        exposed = f"{error.exception}\n{stream.getvalue()}"
        for sensitive in (
            token,
            token[:10],
            original_key,
            original_key[:10],
            wrong_key,
            wrong_key[:10],
            ciphertext,
        ):
            self.assertNotIn(sensitive, exposed)
        self.assertIsNone(error.exception.__cause__)
        self.assertIsNone(error.exception.__context__)

    def test_persistence_failures_do_not_chain_or_expose_credential(self) -> None:
        token = "wapi-persistence-failure-secret"

        def fail_with_sensitive_error(_payload: dict[str, object]) -> None:
            raise RuntimeError(token)

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        try:
            with self.assertRaises(wb.BindingPersistenceError) as migration_error:
                wb._binding_from_raw(
                    {"instance_id": "INSTANCE-FAIL", "token": token},
                    rewrite=fail_with_sensitive_error,
                )
            with (
                patch.object(
                    wb,
                    "write_account_db",
                    side_effect=RuntimeError(token),
                ),
                self.assertRaises(wb.BindingPersistenceError) as save_error,
            ):
                wb.save_binding(
                    "tenant-persistence-failure",
                    wb.InstanceBinding(
                        instance_id="INSTANCE-PERSISTENCE-FAIL",
                        token=token,
                    ),
                )
        finally:
            root_logger.removeHandler(handler)

        exposed = (
            f"{migration_error.exception}\n"
            f"{save_error.exception}\n"
            f"{stream.getvalue()}"
        )
        self.assertNotIn(token, exposed)
        self.assertNotIn(token[:10], exposed)
        for error in (migration_error.exception, save_error.exception):
            self.assertIsNone(error.__cause__)
            self.assertIsNone(error.__context__)

    def test_missing_or_invalid_key_fails_clearly_outside_tests(self) -> None:
        for environment in ("development", "production"):
            with (
                self.subTest(environment=environment),
                self.assertRaises(CredentialConfigurationError) as missing,
            ):
                wapi_credential_store({"ENVIRONMENT": environment})
            with (
                self.subTest(environment=environment),
                self.assertRaises(CredentialConfigurationError) as invalid,
            ):
                wapi_credential_store(
                    {
                        "ENVIRONMENT": environment,
                        "WAPI_CREDENTIAL_ENCRYPTION_KEY": "not-a-fernet-key",
                    }
                )

            self.assertEqual(
                "Configuração da criptografia de credenciais W-API ausente; "
                "defina WAPI_CREDENTIAL_ENCRYPTION_KEY.",
                str(missing.exception),
            )
            self.assertEqual(
                "Configuração da criptografia de credenciais W-API inválida; verifique "
                "WAPI_CREDENTIAL_ENCRYPTION_KEY e "
                "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS.",
                str(invalid.exception),
            )

    def test_application_startup_fails_without_key_outside_tests(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "WAPI_TEST_INSTANCE_ID": "",
                "WAPI_TEST_INSTANCE_TOKEN": "",
                "WAPI_TEST_TENANT_ID": "",
            },
            clear=True,
        ):
            from app import bootstrap

            with self.assertRaises(CredentialConfigurationError) as error:
                bootstrap.create_app()

        self.assertEqual(
            "Configuração da criptografia de credenciais W-API ausente; "
            "defina WAPI_CREDENTIAL_ENCRYPTION_KEY.",
            str(error.exception),
        )

    def test_previous_key_is_rewritten_with_active_key_during_rotation(self) -> None:
        token = "wapi-rotation-secret"
        old_key = Fernet.generate_key().decode("ascii")
        new_key = Fernet.generate_key().decode("ascii")
        with patch.dict(
            os.environ,
            {
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": old_key,
                "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS": "",
            },
            clear=False,
        ):
            wb.save_binding(
                "tenant-rotation",
                wb.InstanceBinding(instance_id="INSTANCE-ROTATION", token=token),
            )
        old_credential = self._stored_payload("tenant-rotation")["credential"]

        with patch.dict(
            os.environ,
            {
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": new_key,
                "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS": old_key,
            },
            clear=False,
        ):
            self.assertEqual(token, wb.get_binding("tenant-rotation").token)
        new_credential = self._stored_payload("tenant-rotation")["credential"]

        self.assertNotEqual(old_credential, new_credential)
        with patch.dict(
            os.environ,
            {
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": new_key,
                "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS": "",
            },
            clear=False,
        ):
            self.assertEqual(token, wb.get_binding("tenant-rotation").token)

    def test_credential_objects_do_not_expose_plaintext_in_repr(self) -> None:
        token = "wapi-repr-secret"
        binding = wb.InstanceBinding(instance_id="INSTANCE-REPR", token=token)
        store = FernetCredentialStore(Fernet.generate_key().decode("ascii"))
        recovered = store.retrieve(store.store(token))

        self.assertNotIn(token, repr(binding))
        self.assertNotIn(token, repr(recovered))

    def test_backup_migrates_legacy_binding_before_copying_snapshot(self) -> None:
        from app.modules.workhub.service import create_backup_snapshot

        token = "wapi-backup-legacy-secret"
        write_account_db(
            "tenant-backup",
            "wapi_instance",
            asdict(
                wb.InstanceBinding(
                    instance_id="INSTANCE-BACKUP",
                    token=token,
                    state="connected",
                )
            ),
        )

        backup = asyncio.run(create_backup_snapshot({"id": "tenant-backup"}))
        active_path = self._binding_path("tenant-backup")
        snapshot_path = active_path.parent / "backups" / str(backup["id"]) / active_path.name

        self.assertNotIn(token, active_path.read_text(encoding="utf-8"))
        self.assertNotIn(token, snapshot_path.read_text(encoding="utf-8"))

    def test_restore_migrates_legacy_snapshot_before_copying_to_active_store(self) -> None:
        from app.modules.workhub.service import (
            create_backup_snapshot,
            restore_backup_snapshot,
        )

        user_id = "tenant-restore"
        restored_token = "wapi-restored-legacy-secret"
        wb.save_binding(
            user_id,
            wb.InstanceBinding(
                instance_id="INSTANCE-RESTORE",
                token="initial-encrypted-token",
                state="connected",
            ),
        )
        backup = asyncio.run(create_backup_snapshot({"id": user_id}))
        active_path = self._binding_path(user_id)
        snapshot_path = active_path.parent / "backups" / str(backup["id"]) / active_path.name
        write_json_file(
            snapshot_path,
            asdict(
                wb.InstanceBinding(
                    instance_id="INSTANCE-RESTORED",
                    token=restored_token,
                    state="connected",
                )
            ),
        )

        restored = asyncio.run(
            restore_backup_snapshot({"id": user_id}, str(backup["id"]))
        )

        self.assertIsNotNone(restored)
        self.assertNotIn(restored_token, snapshot_path.read_text(encoding="utf-8"))
        self.assertNotIn(restored_token, active_path.read_text(encoding="utf-8"))
        binding = wb.get_binding(user_id)
        self.assertEqual(restored_token, binding.token)
        self.assertEqual("INSTANCE-RESTORED", binding.instance_id)
        self.assertIsNone(wb.owner_of_instance("INSTANCE-RESTORE"))
        self.assertEqual(user_id, wb.owner_of_instance("INSTANCE-RESTORED"))

    def test_migration_sweep_covers_active_bindings_and_historical_snapshots(self) -> None:
        token = "wapi-sweep-legacy-secret"
        user_id = "tenant-sweep"
        legacy = asdict(
            wb.InstanceBinding(
                instance_id="INSTANCE-SWEEP",
                token=token,
                state="connected",
            )
        )
        active_path = self._binding_path(user_id)
        snapshot_path = active_path.parent / "backups" / "backup_legacy" / active_path.name
        write_json_file(active_path, legacy)
        write_json_file(snapshot_path, legacy)

        first = wb.migrate_all_binding_credentials(self.data_dir)
        second = wb.migrate_all_binding_credentials(self.data_dir)

        self.assertEqual({"scanned": 2, "rewritten": 2}, first)
        self.assertEqual({"scanned": 2, "rewritten": 0}, second)
        self.assertNotIn(token, active_path.read_text(encoding="utf-8"))
        self.assertNotIn(token, snapshot_path.read_text(encoding="utf-8"))

    def test_migration_rejects_malformed_binding_without_exposing_contents(self) -> None:
        sensitive = "wapi-malformed-record-secret"
        path = self._binding_path("tenant-malformed")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"token":"' + sensitive, encoding="utf-8")

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        try:
            with self.assertRaises(CredentialRecoveryError) as error:
                wb.migrate_binding_file(path)
        finally:
            root_logger.removeHandler(handler)

        exposed = f"{error.exception}\n{stream.getvalue()}"
        self.assertNotIn(sensitive, exposed)
        self.assertEqual(
            "Não foi possível validar o binding W-API persistido.",
            str(error.exception),
        )
        self.assertIsNone(error.exception.__cause__)
        self.assertIsNone(error.exception.__context__)


if __name__ == "__main__":
    unittest.main()
