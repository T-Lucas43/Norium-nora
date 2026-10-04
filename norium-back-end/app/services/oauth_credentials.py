"""Dedicated, authenticated OAuth storage, bound to account and purpose."""
from __future__ import annotations

import json
import os

from cryptography.fernet import Fernet

from app.core.credentials import CredentialConfigurationError, CredentialRecoveryError, FernetCredentialStore
from app.core.tenant import environment_names, SHARED_RUNTIME_MARKERS, is_shared_environment

ACTIVE_KEY_ENV = "NORIUM_OAUTH_CREDENTIAL_ENCRYPTION_KEY"
PREVIOUS_KEYS_ENV = "NORIUM_OAUTH_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS"
SECTIONS = frozenset({"gmailToken", "gmailOauthState", "calendarToken", "calendarOauthState"})
_TEST_KEY = Fernet.generate_key().decode("ascii")
FORMAT = "oauth-bound-v1"


def validate_configuration() -> None:
    if is_shared_environment() and any(os.getenv(name, "").strip() for name in ("GMAIL_CLIENT_ID", "GOOGLE_CLIENT_ID")):
        credential_store()


def credential_store() -> FernetCredentialStore:
    active = os.getenv(ACTIVE_KEY_ENV, "").strip()
    names = environment_names()
    if (not active and names and names.issubset({"test", "testing"})
            and not any(os.getenv(name, "").strip() for name in SHARED_RUNTIME_MARKERS)):
        active = _TEST_KEY
    if not active:
        raise CredentialConfigurationError("Criptografia OAuth não configurada. Configure a chave dedicada no secret manager.")
    previous = tuple(value.strip() for value in os.getenv(PREVIOUS_KEYS_ENV, "").split(",") if value.strip())
    return FernetCredentialStore(active, previous)


def protect(user_id: str, section: str, value: dict) -> dict:
    if section not in SECTIONS or not isinstance(value, dict):
        raise CredentialRecoveryError("Conteúdo de credencial OAuth inválido.")
    if not value:
        return {}
    payload = json.dumps({"account": user_id, "purpose": section, "value": value}, ensure_ascii=False, separators=(",", ":"))
    return {"format": FORMAT, "credential": credential_store().store(payload)}


def recover(user_id: str, section: str, envelope: object) -> tuple[dict, bool]:
    if section not in SECTIONS or not isinstance(envelope, dict):
        raise CredentialRecoveryError("Credencial OAuth inválida.")
    if not envelope:
        return {}, False
    if envelope.get("format") != FORMAT:
        # Legacy data is read only to encrypt it before returning credentials.
        # A missing/invalid key cannot fall back to plaintext operation.
        credential_store()
        if "format" in envelope or "ciphertext" in envelope or "credential" in envelope:
            raise CredentialRecoveryError("Envelope OAuth inválido.")
        return dict(envelope), True
    recovered = credential_store().retrieve(envelope.get("credential"))
    try:
        payload = json.loads(recovered.value)
        if (not isinstance(payload, dict) or payload.get("account") != user_id or payload.get("purpose") != section
                or not isinstance(payload.get("value"), dict)):
            raise ValueError("invalid_binding")
    except (ValueError, TypeError):
        raise CredentialRecoveryError("A credencial OAuth não pertence a este contexto.") from None
    return payload["value"], recovered.needs_rewrite
