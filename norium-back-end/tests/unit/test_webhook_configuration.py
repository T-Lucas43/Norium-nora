from __future__ import annotations

import io
import logging
import os
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet

from app import bootstrap
from app.core.settings import (
    WebhookConfigurationError,
    validate_wapi_webhook_configuration,
)
from app.core.tenant import is_local_or_test_environment, is_shared_environment


SHARED_ENVIRONMENTS = ("production", "prod", "railway", "staging")
LOCAL_TEST_ENVIRONMENTS = ("development", "test")
VALID_SECRET = "webhook-secret-for-tests"
VALID_CREDENTIAL_KEY = Fernet.generate_key().decode("ascii")


class WebhookConfigurationTests(unittest.TestCase):
    def test_shared_environments_fail_startup_without_webhook_secret(self) -> None:
        for environment in SHARED_ENVIRONMENTS:
            with self.subTest(environment=environment), patch.dict(
                os.environ,
                {
                    "ENVIRONMENT": environment,
                    "WAPI_CREDENTIAL_ENCRYPTION_KEY": VALID_CREDENTIAL_KEY,
                },
                clear=True,
            ), patch.object(bootstrap, "validate_wapi_test_configuration"):
                with self.assertRaises(RuntimeError):
                    bootstrap.create_app()

    def test_environment_classification_is_centralized_and_fail_closed(self) -> None:
        for environment in SHARED_ENVIRONMENTS:
            with self.subTest(environment=environment):
                environ = {"ENVIRONMENT": environment}
                self.assertTrue(is_shared_environment(environ, require_explicit=True))
                self.assertFalse(is_local_or_test_environment(environ, require_explicit=True))

        for environment in LOCAL_TEST_ENVIRONMENTS:
            with self.subTest(environment=environment):
                environ = {"ENVIRONMENT": environment}
                self.assertFalse(is_shared_environment(environ, require_explicit=True))
                self.assertTrue(is_local_or_test_environment(environ, require_explicit=True))

        self.assertTrue(is_shared_environment({}, require_explicit=True))
        self.assertTrue(
            is_shared_environment(
                {"ENVIRONMENT": "development", "RAILWAY_PROJECT_ID": "configured"},
                require_explicit=True,
            )
        )

    def test_shared_environments_reject_missing_empty_and_invalid_configuration(self) -> None:
        for environment in SHARED_ENVIRONMENTS:
            for secret in (None, "", "   ", "contains whitespace"):
                with self.subTest(environment=environment, secret_kind=repr(secret)):
                    environ = {"ENVIRONMENT": environment}
                    if secret is not None:
                        environ["WAPI_WEBHOOK_SECRET"] = secret
                    with self.assertRaises(WebhookConfigurationError) as error:
                        validate_wapi_webhook_configuration(environ)
                    if secret:
                        self.assertNotIn(secret, str(error.exception))

    def test_local_and_test_allow_missing_but_reject_invalid_configured_secret(self) -> None:
        for environment in LOCAL_TEST_ENVIRONMENTS:
            with self.subTest(environment=environment, case="missing"):
                validate_wapi_webhook_configuration({"ENVIRONMENT": environment})
            with self.subTest(environment=environment, case="invalid"):
                with self.assertRaises(WebhookConfigurationError):
                    validate_wapi_webhook_configuration(
                        {
                            "ENVIRONMENT": environment,
                            "WAPI_WEBHOOK_SECRET": "invalid secret",
                        }
                    )

    def test_valid_secret_is_accepted_in_every_environment(self) -> None:
        for environment in (*SHARED_ENVIRONMENTS, *LOCAL_TEST_ENVIRONMENTS):
            with self.subTest(environment=environment):
                validate_wapi_webhook_configuration(
                    {
                        "ENVIRONMENT": environment,
                        "WAPI_WEBHOOK_SECRET": VALID_SECRET,
                    }
                )

    def test_non_ascii_secret_is_rejected_during_startup_validation(self) -> None:
        with self.assertRaises(WebhookConfigurationError):
            validate_wapi_webhook_configuration(
                {
                    "ENVIRONMENT": "staging",
                    "WAPI_WEBHOOK_SECRET": "segredo-ç",
                }
            )

    def test_uvicorn_access_log_never_exposes_webhook_secret(self) -> None:
        secret = "do-not-log-this-secret"
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "staging",
                "WAPI_WEBHOOK_SECRET": secret,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": VALID_CREDENTIAL_KEY,
            },
            clear=True,
        ), patch.object(bootstrap, "validate_wapi_test_configuration"):
            bootstrap.create_app()

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        access_logger = logging.getLogger("uvicorn.access")
        previous_level = access_logger.level
        previous_disabled = access_logger.disabled
        previous_propagate = access_logger.propagate
        access_logger.setLevel(logging.INFO)
        access_logger.disabled = False
        access_logger.propagate = False
        access_logger.addHandler(handler)
        try:
            access_logger.info(
                '%s - "%s %s HTTP/%s" %d',
                "127.0.0.1:12345",
                "POST",
                f"/api/whatsapp/webhook?secret={secret}&event=received",
                "1.1",
                200,
            )
        finally:
            access_logger.removeHandler(handler)
            access_logger.setLevel(previous_level)
            access_logger.disabled = previous_disabled
            access_logger.propagate = previous_propagate

        self.assertNotIn(secret, stream.getvalue())

    def test_shared_environment_starts_with_valid_secret(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "staging",
                "WAPI_WEBHOOK_SECRET": VALID_SECRET,
                "WAPI_CREDENTIAL_ENCRYPTION_KEY": VALID_CREDENTIAL_KEY,
            },
            clear=True,
        ), patch.object(bootstrap, "validate_wapi_test_configuration"):
            app = bootstrap.create_app()

        self.assertEqual("Norium Engine Chat Central Unificado API", app.title)


if __name__ == "__main__":
    unittest.main()
