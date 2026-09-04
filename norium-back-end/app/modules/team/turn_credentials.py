"""Credenciais ICE efêmeras atrás de uma seam independente de fornecedor."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Mapping, Protocol


DEFAULT_STUN_URLS = (
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
)
DEFAULT_TTL_SECONDS = 600
DEFAULT_REFRESH_MARGIN_SECONDS = 120


class TurnConfigurationError(RuntimeError):
    """A configuração TURN existe, mas não é segura ou utilizável."""


class TurnUnavailableError(RuntimeError):
    """Não existe um emissor TURN disponível neste processo."""


@dataclass(frozen=True, slots=True)
class TurnSubject:
    team_id: str
    user_id: str


@dataclass(frozen=True, slots=True)
class TurnCredentialDocument:
    ice_servers: tuple[dict[str, object], ...]
    expires_at: datetime
    refresh_after: datetime

    def as_payload(self) -> dict[str, object]:
        return {
            "iceServers": [dict(server) for server in self.ice_servers],
            "expiresAt": self.expires_at.isoformat(),
            "refreshAfter": self.refresh_after.isoformat(),
        }


class TurnCredentialProvider(Protocol):
    def issue(self, subject: TurnSubject) -> TurnCredentialDocument:
        """Emite uma configuração ICE curta para um membro já autorizado."""


@dataclass(frozen=True, slots=True)
class UnavailableTurnCredentialProvider:
    reason: str = "O serviço TURN não está configurado para este ambiente."

    def issue(self, subject: TurnSubject) -> TurnCredentialDocument:
        del subject
        raise TurnUnavailableError(self.reason)


@dataclass(frozen=True, slots=True)
class HmacTurnCredentialProvider:
    """Adapter genérico para o protocolo TURN REST usado por coturn e equivalentes."""

    stun_urls: tuple[str, ...]
    turn_urls: tuple[str, ...]
    shared_secret: str
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    refresh_margin_seconds: int = DEFAULT_REFRESH_MARGIN_SECONDS
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def __post_init__(self) -> None:
        _validate_values(
            self.stun_urls,
            self.turn_urls,
            self.shared_secret,
            self.ttl_seconds,
            self.refresh_margin_seconds,
        )

    def issue(self, subject: TurnSubject) -> TurnCredentialDocument:
        now = self.now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        now = now.astimezone(timezone.utc)
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        refresh_after = expires_at - timedelta(seconds=self.refresh_margin_seconds)
        opaque_subject = base64.urlsafe_b64encode(
            hashlib.sha256(f"{subject.team_id}\0{subject.user_id}".encode("utf-8")).digest()[:12]
        ).decode("ascii").rstrip("=")
        username = f"{int(expires_at.timestamp())}:{opaque_subject}"
        credential = base64.b64encode(
            hmac.new(
                self.shared_secret.encode("utf-8"),
                username.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        return TurnCredentialDocument(
            ice_servers=(
                {"urls": list(self.stun_urls)},
                {
                    "urls": list(self.turn_urls),
                    "username": username,
                    "credential": credential,
                    "credentialType": "password",
                },
            ),
            expires_at=expires_at,
            refresh_after=refresh_after,
        )


def _csv_urls(raw: str, defaults: tuple[str, ...] = ()) -> tuple[str, ...]:
    values = tuple(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    return values or defaults


def _boolean(name: str, raw: str) -> bool:
    normalized = raw.strip().lower()
    if normalized in {"", "0", "false", "no"}:
        return False
    if normalized in {"1", "true", "yes"}:
        return True
    raise TurnConfigurationError(f"{name} deve ser true ou false.")


def _integer(source: Mapping[str, str], name: str, default: int) -> int:
    try:
        return int(source.get(name, str(default)).strip())
    except (AttributeError, ValueError) as exc:
        raise TurnConfigurationError(f"{name} deve ser um número inteiro.") from exc


def _validate_urls(urls: tuple[str, ...], schemes: tuple[str, ...], name: str) -> None:
    if not urls:
        raise TurnConfigurationError(f"{name} deve conter ao menos uma URL.")
    for url in urls:
        if not url.startswith(schemes) or "@" in url or any(character.isspace() for character in url):
            raise TurnConfigurationError(f"{name} contém uma URL inválida ou com credencial permanente.")


def _validate_values(
    stun_urls: tuple[str, ...],
    turn_urls: tuple[str, ...],
    shared_secret: str,
    ttl_seconds: int,
    refresh_margin_seconds: int,
) -> None:
    _validate_urls(stun_urls, ("stun:", "stuns:"), "TEAM_CALL_STUN_URLS")
    _validate_urls(turn_urls, ("turn:", "turns:"), "TEAM_CALL_TURN_URLS")
    if not any(url.startswith("turns:") for url in turn_urls):
        raise TurnConfigurationError("TEAM_CALL_TURN_URLS deve incluir TURN/TLS com o esquema turns:.")
    if (
        len(shared_secret) < 32
        or shared_secret != shared_secret.strip()
        or not shared_secret.isascii()
        or any(character.isspace() or ord(character) < 32 for character in shared_secret)
    ):
        raise TurnConfigurationError("TEAM_CALL_TURN_SHARED_SECRET deve ter ao menos 32 caracteres ASCII sem espaços.")
    if not 60 <= ttl_seconds <= 3600:
        raise TurnConfigurationError("TEAM_CALL_TURN_TTL_SECONDS deve ficar entre 60 e 3600.")
    if not 15 <= refresh_margin_seconds < ttl_seconds:
        raise TurnConfigurationError("TEAM_CALL_TURN_REFRESH_MARGIN_SECONDS deve ser menor que o TTL e ter ao menos 15 segundos.")


def turn_provider_from_environment(
    environ: Mapping[str, str] | None = None,
    *,
    now: Callable[[], datetime] | None = None,
) -> TurnCredentialProvider:
    source = os.environ if environ is None else environ
    required = _boolean("TEAM_CALL_TURN_REQUIRED", source.get("TEAM_CALL_TURN_REQUIRED", ""))
    raw_turn_urls = source.get("TEAM_CALL_TURN_URLS", "").strip()
    shared_secret = source.get("TEAM_CALL_TURN_SHARED_SECRET", "")
    if not raw_turn_urls and not shared_secret.strip():
        if required:
            raise TurnConfigurationError("O serviço TURN é obrigatório, mas não foi configurado.")
        return UnavailableTurnCredentialProvider()
    if not raw_turn_urls or not shared_secret.strip():
        raise TurnConfigurationError("URLs TURN e segredo compartilhado devem ser configurados juntos.")

    stun_urls = _csv_urls(source.get("TEAM_CALL_STUN_URLS", ""), DEFAULT_STUN_URLS)
    turn_urls = _csv_urls(raw_turn_urls)
    ttl_seconds = _integer(source, "TEAM_CALL_TURN_TTL_SECONDS", DEFAULT_TTL_SECONDS)
    refresh_margin_seconds = _integer(
        source,
        "TEAM_CALL_TURN_REFRESH_MARGIN_SECONDS",
        min(DEFAULT_REFRESH_MARGIN_SECONDS, ttl_seconds // 2),
    )
    return HmacTurnCredentialProvider(
        stun_urls=stun_urls,
        turn_urls=turn_urls,
        shared_secret=shared_secret,
        ttl_seconds=ttl_seconds,
        refresh_margin_seconds=refresh_margin_seconds,
        **({"now": now} if now is not None else {}),
    )


def validate_turn_configuration(environ: Mapping[str, str] | None = None) -> None:
    turn_provider_from_environment(environ)
