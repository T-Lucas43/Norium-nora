"""Testes unitários de infraestrutura e regras isoladas."""

from __future__ import annotations

import base64
import os
import secrets


os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("WAPI_TEST_INSTANCE_ID", "")
os.environ.setdefault("WAPI_TEST_INSTANCE_TOKEN", "")
os.environ.setdefault("WAPI_TEST_TENANT_ID", "")
# Chave efêmera por processo: os testes nunca dependem de um segredo fixo nem
# deixam o backend cair para armazenamento em texto puro.
os.environ.setdefault(
    "WAPI_CREDENTIAL_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
)
