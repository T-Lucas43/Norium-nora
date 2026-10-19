"""Configuração segura do adapter de credenciais da W-API."""

from __future__ import annotations

import os
from typing import Mapping

from cryptography.fernet import Fernet

from app.core.credentials import (
    CredentialConfigurationError,
    CredentialStore,
    FernetCredentialStore,
)
from app.core.tenant import SHARED_RUNTIME_MARKERS, environment_names
from app.services.whatsapp_provider import is_evolution


ACTIVE_KEY_ENV = "EVOLUTION_CREDENTIAL_ENCRYPTION_KEY" if is_evolution() else "WAPI_CREDENTIAL_ENCRYPTION_KEY"
PREVIOUS_KEYS_ENV = "EVOLUTION_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS" if is_evolution() else "WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS"
_TEST_ENVIRONMENTS = frozenset({"test", "testing"})
_EPHEMERAL_TEST_KEY = Fernet.generate_key().decode("ascii")
_MISSING_KEY_MESSAGE = (
    f"Configuração da criptografia de credenciais WhatsApp ausente; defina {ACTIVE_KEY_ENV}."
)
_INVALID_KEY_MESSAGE = (
    f"Configuração da criptografia WhatsApp inválida; verifique {ACTIVE_KEY_ENV} e {PREVIOUS_KEYS_ENV}."
)


def _is_explicit_test_environment(source: Mapping[str, str]) -> bool:
    names = environment_names(source)
    return (
        bool(names)
        and names.issubset(_TEST_ENVIRONMENTS)
        and not any(source.get(name, "").strip() for name in SHARED_RUNTIME_MARKERS)
    )


def wapi_credential_store(
    environ: Mapping[str, str] | None = None,
) -> CredentialStore:
    """Cria o adapter sem reter ou expor valores da configuração."""
    source = os.environ if environ is None else environ
    active_key = source.get(ACTIVE_KEY_ENV, "").strip()
    if not active_key:
        if _is_explicit_test_environment(source):
            active_key = _EPHEMERAL_TEST_KEY
        else:
            raise CredentialConfigurationError(_MISSING_KEY_MESSAGE) from None

    previous_keys = tuple(
        value
        for item in source.get(PREVIOUS_KEYS_ENV, "").split(",")
        if (value := item.strip())
    )
    store: FernetCredentialStore | None = None
    try:
        store = FernetCredentialStore(active_key, previous_keys)
    except CredentialConfigurationError:
        pass
    if store is None:
        raise CredentialConfigurationError(_INVALID_KEY_MESSAGE) from None
    return store


def validate_wapi_credential_encryption_configuration(
    environ: Mapping[str, str] | None = None,
) -> None:
    """Falha cedo quando um runtime não-testável não possui uma chave válida."""
    wapi_credential_store(environ)
