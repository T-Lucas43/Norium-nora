"""Centraliza configuracoes de ambiente para impedir hardcodes nos dominios."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from dotenv import load_dotenv

from app.core.tenant import is_shared_environment


load_dotenv()


def _environment(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


class WebhookConfigurationError(RuntimeError):
    """Configuração insegura do webhook W-API."""


def is_valid_wapi_webhook_secret(secret: object) -> bool:
    """Aceita segredo ASCII não vazio, sem espaços ou caracteres de controle."""
    if (
        not isinstance(secret, str)
        or not secret
        or not secret.isascii()
        or secret != secret.strip()
    ):
        return False
    return not any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in secret)


def validate_wapi_webhook_configuration(
    environ: Mapping[str, str] | None = None,
) -> None:
    """Falha no startup quando a autenticação do webhook não é segura."""
    source = os.environ if environ is None else environ
    raw_secret = source.get("WAPI_WEBHOOK_SECRET", "")
    if raw_secret:
        if not is_valid_wapi_webhook_secret(raw_secret):
            raise WebhookConfigurationError("Configuração inválida do webhook W-API.")
        return
    if is_shared_environment(source, require_explicit=True):
        raise WebhookConfigurationError("Configuração segura do webhook W-API ausente.")


@dataclass(frozen=True, slots=True)
class Settings:
    """Configuração central sem valores secretos embutidos no código."""

    GROQ_API_KEY: str = field(default_factory=lambda: _environment("GROQ_API_KEY"))
    GOOGLE_CLIENT_ID: str = field(default_factory=lambda: _environment("GOOGLE_CLIENT_ID"))
    GOOGLE_CLIENT_SECRET: str = field(default_factory=lambda: _environment("GOOGLE_CLIENT_SECRET"))
    ENVIRONMENT: str = field(default_factory=lambda: _environment("ENVIRONMENT", "development"))
    FRONTEND_URL: str = field(default_factory=lambda: _environment("FRONTEND_URL"))
    NORIUM_DATA_DIR: str = field(default_factory=lambda: _environment("NORIUM_DATA_DIR"))


settings = Settings()
