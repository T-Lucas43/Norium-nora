"""Testes que congelam os contratos públicos da API."""

from __future__ import annotations

import base64
import os
import secrets


os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("WAPI_TEST_INSTANCE_ID", "")
os.environ.setdefault("WAPI_TEST_INSTANCE_TOKEN", "")
os.environ.setdefault("WAPI_TEST_TENANT_ID", "")
os.environ.setdefault(
    "WAPI_CREDENTIAL_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
)
