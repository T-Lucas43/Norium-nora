"""Primitivas de senha e token isoladas das regras de autenticacao."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from app.core.tenant import get_system_db_path, read_json_file, write_json_file


LEGACY_PASSWORD_ITERATIONS = 180_000
PASSWORD_ITERATIONS = 600_000
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7
AUTH_CONFIG_PATH = Path(get_system_db_path("auth_config"))


class TokenValidationError(ValueError):
    """Token ausente, adulterado ou expirado."""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(f"{raw}{padding}".encode("ascii"))


def auth_secret() -> bytes:
    """Usa ambiente ou segredo aleatório persistente, nunca um valor conhecido."""
    configured = os.getenv("NORIUM_AUTH_SECRET", "").strip()
    if configured:
        return configured.encode("utf-8")

    stored = read_json_file(AUTH_CONFIG_PATH, {})
    persisted = stored.get("secret") if isinstance(stored, dict) else None
    if isinstance(persisted, str) and len(persisted) >= 32:
        return persisted.encode("utf-8")

    generated = secrets.token_urlsafe(64)
    write_json_file(AUTH_CONFIG_PATH, {"secret": generated})
    try:
        AUTH_CONFIG_PATH.chmod(0o600)
    except OSError:
        pass
    return generated.encode("utf-8")


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        PASSWORD_ITERATIONS,
    )
    return f"pbkdf2_sha256_v2${PASSWORD_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        parts = stored_hash.split("$")
        if len(parts) == 3 and parts[0] == "pbkdf2_sha256":
            _, salt, expected = parts
            iterations = LEGACY_PASSWORD_ITERATIONS
        elif len(parts) == 4 and parts[0] == "pbkdf2_sha256_v2":
            _, raw_iterations, salt, expected = parts
            iterations = int(raw_iterations)
            if iterations < LEGACY_PASSWORD_ITERATIONS:
                return False
        else:
            return False

        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt),
            iterations,
        )
        return hmac.compare_digest(digest.hex(), expected)
    except (TypeError, ValueError):
        return False


def password_needs_rehash(stored_hash: str) -> bool:
    return not stored_hash.startswith(f"pbkdf2_sha256_v2${PASSWORD_ITERATIONS}$")


def create_signed_token(
    user: dict[str, Any],
    *,
    secret: bytes,
    ttl_seconds: int = TOKEN_TTL_SECONDS,
) -> str:
    payload = {
        "sub": user["id"],
        "email": user["email"],
        "exp": int(time.time()) + ttl_seconds,
    }
    payload_raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_part = _b64url_encode(payload_raw)
    signature = hmac.new(secret, payload_part.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_part}.{_b64url_encode(signature)}"


def decode_signed_token(token: str, *, secret: bytes) -> dict[str, Any]:
    try:
        payload_part, signature_part = token.split(".", 1)
        expected_signature = hmac.new(secret, payload_part.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(_b64url_decode(signature_part), expected_signature):
            raise TokenValidationError("Assinatura inválida.")
        payload = json.loads(_b64url_decode(payload_part).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            raise TokenValidationError("Sessão expirada.")
        return payload
    except TokenValidationError:
        raise
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise TokenValidationError("Token inválido.") from exc
