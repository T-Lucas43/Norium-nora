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
    from .auth_password_reauthentication_cases import PasswordReauthenticationTests
else:
    BACKEND_ROOT = Path(__file__).resolve().parents[2]
    TEST_RUNTIME_ROOT = (
        BACKEND_ROOT.parent
        / "output"
        / "security-fix-auth-04"
        / "subprocess-data"
    )

    class PasswordReauthenticationTests(unittest.TestCase):
        """Run every API scenario after establishing process-level isolation."""

        def run_isolated_case(self, case_name: str) -> None:
            runtime_directory = TEST_RUNTIME_ROOT / uuid.uuid4().hex
            runtime_directory.mkdir(parents=True)
            clean_environment = {
                key: os.environ[key]
                for key in ("COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR")
                if key in os.environ
            }
            clean_environment.update(
                {
                    "APP_ENV": "test",
                    "ENVIRONMENT": "test",
                    "NORIUM_AUTH_SECRET": secrets.token_urlsafe(64),
                    "NORIUM_BOOTSTRAP_ADMIN_EMAIL": "",
                    "NORIUM_BOOTSTRAP_ADMIN_PASSWORD": "",
                    "NORIUM_DATA_DIR": str(runtime_directory),
                    "NORIUM_SECURITY_TEST_ISOLATED": "1",
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
            command = (
                sys.executable,
                "-m",
                "unittest",
                (
                    "tests.unit.test_auth_password_reauthentication."
                    f"PasswordReauthenticationTests.{case_name}"
                ),
                "-v",
            )
            try:
                completed = subprocess.run(
                    command,
                    cwd=BACKEND_ROOT,
                    env=clean_environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=120,
                    check=False,
                )
            finally:
                shutil.rmtree(runtime_directory)
                try:
                    TEST_RUNTIME_ROOT.rmdir()
                except OSError:
                    pass
            self.assertEqual(
                0,
                completed.returncode,
                msg=(
                    f"Cenario isolado {case_name} falhou.\n"
                    f"stdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}"
                ),
            )

        def test_management_patch_cannot_change_own_password(self) -> None:
            self.run_isolated_case(
                "test_management_patch_cannot_change_own_password"
            )

        def test_wrong_current_password_preserves_password_and_session(self) -> None:
            self.run_isolated_case(
                "test_wrong_current_password_preserves_password_and_session"
            )

        def test_correct_current_password_rotates_password_and_session(self) -> None:
            self.run_isolated_case(
                "test_correct_current_password_rotates_password_and_session"
            )

        def test_privileged_accounts_cannot_bypass_reauthentication(self) -> None:
            self.run_isolated_case(
                "test_privileged_accounts_cannot_bypass_reauthentication"
            )

        def test_authorized_admin_reset_revokes_only_target_session(self) -> None:
            self.run_isolated_case(
                "test_authorized_admin_reset_revokes_only_target_session"
            )

        def test_self_profile_update_without_password_remains_allowed(self) -> None:
            self.run_isolated_case(
                "test_self_profile_update_without_password_remains_allowed"
            )


if __name__ == "__main__":
    unittest.main()
