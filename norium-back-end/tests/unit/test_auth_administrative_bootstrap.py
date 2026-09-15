from __future__ import annotations

import base64
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import unittest
import uuid


if os.environ.get("NORIUM_SECURITY_TEST_ISOLATED") == "1":
    from .auth_administrative_bootstrap_cases import AdministrativeBootstrapTests
else:
    BACKEND_ROOT = Path(__file__).resolve().parents[2]
    TEST_RUNTIME_ROOT = (
        BACKEND_ROOT.parent
        / "output"
        / "security-fix-auth-02"
        / "subprocess-data"
    )

    class AdministrativeBootstrapTests(unittest.TestCase):
        """Run each public-API scenario after process-level isolation is established."""

        def isolated_environment(
            self,
            runtime_directory: Path,
            **overrides: str,
        ) -> dict[str, str]:
            environment = {
                key: os.environ[key]
                for key in ("COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR")
                if key in os.environ
            }
            environment.update(
                {
                    "APP_ENV": "test",
                    "ENVIRONMENT": "test",
                    "NORIUM_AUTH_SECRET": secrets.token_urlsafe(64),
                    "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "",
                    "NORIUM_BOOTSTRAP_ADMIN_NAME": "",
                    "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "",
                    "NORIUM_BOOTSTRAP_ADMIN_USER_ID": "",
                    "NORIUM_DATA_DIR": str(runtime_directory),
                    "NORIUM_SECURITY_TEST_ISOLATED": "1",
                    "NORIUM_SMTP_PASSWORD": "",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHON_DOTENV_DISABLED": "1",
                    "TEMP": str(runtime_directory),
                    "TMP": str(runtime_directory),
                    "WAPI_CREDENTIAL_ENCRYPTION_KEY": base64.urlsafe_b64encode(
                        secrets.token_bytes(32)
                    ).decode("ascii"),
                    "WAPI_MASTER_API_KEY": "",
                    "WAPI_TEST_INSTANCE_ID": "",
                    "WAPI_TEST_INSTANCE_TOKEN": "",
                    "WAPI_TEST_TENANT_ID": "",
                }
            )
            environment.update(overrides)
            return environment

        def run_isolated_process(
            self,
            case_name: str,
            runtime_directory: Path,
            **environment_overrides: str,
        ) -> None:
            command = (
                sys.executable,
                "-m",
                "unittest",
                (
                    "tests.unit.test_auth_administrative_bootstrap."
                    f"AdministrativeBootstrapTests.{case_name}"
                ),
                "-v",
            )
            completed = subprocess.run(
                command,
                cwd=BACKEND_ROOT,
                env=self.isolated_environment(
                    runtime_directory,
                    **environment_overrides,
                ),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
            self.assertEqual(
                0,
                completed.returncode,
                msg=(
                    f"Cenario isolado {case_name} falhou.\n"
                    f"stdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}"
                ),
            )

        def run_isolated_case(
            self,
            case_name: str,
            **environment_overrides: str,
        ) -> None:
            runtime_directory = TEST_RUNTIME_ROOT / uuid.uuid4().hex
            runtime_directory.mkdir(parents=True)
            try:
                self.run_isolated_process(
                    case_name,
                    runtime_directory,
                    **environment_overrides,
                )
            finally:
                shutil.rmtree(runtime_directory)
                self.remove_empty_runtime_parents()

        @staticmethod
        def remove_empty_runtime_parents() -> None:
            for directory in (TEST_RUNTIME_ROOT,):
                try:
                    directory.rmdir()
                except OSError:
                    break

        def test_email_only_configuration_cannot_turn_public_registration_into_admin(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_email_only_configuration_cannot_turn_public_registration_into_admin",
                NORIUM_BOOTSTRAP_ADMIN_EMAIL="reserved-owner@example.test",
            )

        def test_identifier_only_configuration_cannot_promote_existing_account(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_identifier_only_configuration_cannot_promote_existing_account",
                NORIUM_BOOTSTRAP_ADMIN_USER_ID="reserved-bootstrap-id",
            )

        def test_complete_configuration_cannot_promote_public_registration_in_nonempty_store(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_complete_configuration_cannot_promote_public_registration_in_nonempty_store",
                NORIUM_BOOTSTRAP_ADMIN_EMAIL="reserved-owner@example.test",
                NORIUM_BOOTSTRAP_ADMIN_NAME="Reserved Bootstrap Owner",
                NORIUM_BOOTSTRAP_ADMIN_PASSWORD="bootstrap-password-not-public",
                NORIUM_BOOTSTRAP_ADMIN_USER_ID="reserved-bootstrap-id",
            )

        def test_complete_configuration_cannot_promote_persisted_account_with_matching_id(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_complete_configuration_cannot_promote_persisted_account_with_matching_id",
                NORIUM_BOOTSTRAP_ADMIN_EMAIL="absent-bootstrap-owner@example.test",
                NORIUM_BOOTSTRAP_ADMIN_NAME="Absent Bootstrap Owner",
                NORIUM_BOOTSTRAP_ADMIN_PASSWORD="absent-bootstrap-password",
                NORIUM_BOOTSTRAP_ADMIN_USER_ID="colliding-common-id",
            )

        def test_incomplete_identity_configuration_does_not_bootstrap_admin(
            self,
        ) -> None:
            incomplete_configurations = (
                (
                    "missing-user-id",
                    {
                        "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "bootstrap-owner@example.test",
                        "NORIUM_BOOTSTRAP_ADMIN_NAME": "Bootstrap Owner",
                        "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "bootstrap-owner-password",
                        "NORIUM_BOOTSTRAP_ADMIN_USER_ID": "",
                    },
                ),
                (
                    "missing-name",
                    {
                        "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "bootstrap-owner@example.test",
                        "NORIUM_BOOTSTRAP_ADMIN_NAME": "",
                        "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "bootstrap-owner-password",
                        "NORIUM_BOOTSTRAP_ADMIN_USER_ID": "bootstrap-owner-id",
                    },
                ),
                (
                    "missing-email",
                    {
                        "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "",
                        "NORIUM_BOOTSTRAP_ADMIN_NAME": "Bootstrap Owner",
                        "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "bootstrap-owner-password",
                        "NORIUM_BOOTSTRAP_ADMIN_USER_ID": "bootstrap-owner-id",
                    },
                ),
                (
                    "missing-password",
                    {
                        "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "bootstrap-owner@example.test",
                        "NORIUM_BOOTSTRAP_ADMIN_NAME": "Bootstrap Owner",
                        "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "",
                        "NORIUM_BOOTSTRAP_ADMIN_USER_ID": "bootstrap-owner-id",
                    },
                ),
            )
            for missing_field, environment in incomplete_configurations:
                with self.subTest(missing_field=missing_field):
                    self.run_isolated_case(
                        "assert_incomplete_identity_configuration_does_not_bootstrap_admin",
                        **environment,
                    )

        def test_complete_bootstrap_is_idempotent_and_creates_only_expected_admin(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_complete_bootstrap_is_idempotent_and_creates_only_expected_admin",
                NORIUM_BOOTSTRAP_ADMIN_EMAIL="bootstrap-owner@example.test",
                NORIUM_BOOTSTRAP_ADMIN_NAME="Bootstrap Owner",
                NORIUM_BOOTSTRAP_ADMIN_PASSWORD="bootstrap-owner-password",
                NORIUM_BOOTSTRAP_ADMIN_USER_ID="bootstrap-owner-id",
            )

        def test_changed_configuration_does_not_replace_persisted_owner(self) -> None:
            runtime_directory = TEST_RUNTIME_ROOT / uuid.uuid4().hex
            runtime_directory.mkdir(parents=True)
            try:
                self.run_isolated_process(
                    "establish_persisted_owner_and_regular_account",
                    runtime_directory,
                    NORIUM_BOOTSTRAP_ADMIN_EMAIL="original-owner@example.test",
                    NORIUM_BOOTSTRAP_ADMIN_NAME="Original Owner",
                    NORIUM_BOOTSTRAP_ADMIN_PASSWORD="original-bootstrap-password",
                    NORIUM_BOOTSTRAP_ADMIN_USER_ID="original-owner-id",
                )
                self.run_isolated_process(
                    "assert_changed_configuration_preserves_persisted_owner",
                    runtime_directory,
                    NORIUM_BOOTSTRAP_ADMIN_EMAIL="regular-account@example.test",
                    NORIUM_BOOTSTRAP_ADMIN_NAME="Replacement Candidate",
                    NORIUM_BOOTSTRAP_ADMIN_PASSWORD="replacement-bootstrap-password",
                    NORIUM_BOOTSTRAP_ADMIN_USER_ID="replacement-owner-id",
                )
            finally:
                shutil.rmtree(runtime_directory)
                self.remove_empty_runtime_parents()

        def test_completed_configuration_cannot_bootstrap_initialized_empty_store(
            self,
        ) -> None:
            runtime_directory = TEST_RUNTIME_ROOT / uuid.uuid4().hex
            runtime_directory.mkdir(parents=True)
            try:
                self.run_isolated_process(
                    "initialize_empty_store_with_incomplete_configuration",
                    runtime_directory,
                    NORIUM_BOOTSTRAP_ADMIN_EMAIL="late-bootstrap@example.test",
                )
                self.run_isolated_process(
                    "assert_completed_configuration_cannot_bootstrap_initialized_store",
                    runtime_directory,
                    NORIUM_BOOTSTRAP_ADMIN_EMAIL="late-bootstrap@example.test",
                    NORIUM_BOOTSTRAP_ADMIN_NAME="Late Bootstrap Candidate",
                    NORIUM_BOOTSTRAP_ADMIN_PASSWORD="late-bootstrap-password",
                    NORIUM_BOOTSTRAP_ADMIN_USER_ID="late-bootstrap-id",
                )
            finally:
                shutil.rmtree(runtime_directory)
                self.remove_empty_runtime_parents()

        def test_legacy_admins_are_preserved_without_promoting_common_account(
            self,
        ) -> None:
            self.run_isolated_case(
                "test_legacy_admins_are_preserved_without_promoting_common_account",
                NORIUM_BOOTSTRAP_ADMIN_EMAIL="common-account@example.test",
                NORIUM_BOOTSTRAP_ADMIN_NAME="Common Account",
                NORIUM_BOOTSTRAP_ADMIN_PASSWORD="unrelated-bootstrap-password",
                NORIUM_BOOTSTRAP_ADMIN_USER_ID="unrelated-bootstrap-id",
            )


if __name__ == "__main__":
    unittest.main()
