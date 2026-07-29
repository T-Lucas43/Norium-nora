"""Centraliza configuracoes de ambiente para impedir hardcodes nos dominios."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv


load_dotenv()


def _environment(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


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
