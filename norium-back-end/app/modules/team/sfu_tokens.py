"""Credenciais temporarias para transportes SFU de chamadas de equipe."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Mapping, Protocol
from urllib.parse import urlsplit


DEFAULT_SFU_TOKEN_TTL_SECONDS = 300
MIN_SFU_TOKEN_TTL_SECONDS = 60
MAX_SFU_TOKEN_TTL_SECONDS = 600


class SfuConfigurationError(RuntimeError):
    """Impede inicializacao com uma configuracao SFU insegura."""


class SfuUnavailableError(RuntimeError):
    """O transporte SFU nao esta habilitado neste processo."""


@dataclass(frozen=True, slots=True)
class SfuTokenSubject:
    team_id: str
    call_id: str
    user_id: str
    media_session_id: str


@dataclass(frozen=True, slots=True)
class SfuTokenDocument:
    server_url: str
    token: str
    expires_at: datetime

    def as_payload(self) -> dict[str, str]:
        return {
            "serverUrl": self.server_url,
            "token": self.token,
            "expiresAt": self.expires_at.isoformat(),
        }


class SfuTokenProvider(Protocol):
    """Seam de emissao de acesso ao SFU, independente do fornecedor."""

    def issue(self, subject: SfuTokenSubject) -> SfuTokenDocument: ...


@dataclass(frozen=True, slots=True)
class UnavailableSfuTokenProvider:
    reason: str = "O transporte SFU nao esta configurado para este ambiente."

    def issue(self, subject: SfuTokenSubject) -> SfuTokenDocument:
        del subject
        raise SfuUnavailableError(self.reason)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


@dataclass(frozen=True, slots=True)
class LiveKitTokenProvider:
    """Emite grants LiveKit locais sem enviar o segredo ao fornecedor."""

    server_url: str
    api_key: str
    api_secret: str = field(repr=False)
    ttl_seconds: int = 300
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    token_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex

    def issue(self, subject: SfuTokenSubject) -> SfuTokenDocument:
        now = self.now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        now = now.astimezone(timezone.utc)
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        room_digest = hashlib.sha256(
            f"{subject.team_id}\0{subject.call_id}".encode("utf-8")
        ).hexdigest()[:32]
        participant_digest = hashlib.sha256(
            (
                f"{subject.team_id}\0{subject.call_id}\0{subject.user_id}"
                f"\0{subject.media_session_id}"
            ).encode("utf-8")
        ).hexdigest()[:40]
        header = {"alg": "HS256", "typ": "JWT"}
        claims = {
            "iss": self.api_key,
            "sub": f"participant-{participant_digest}",
            "metadata": json.dumps(
                {"userId": subject.user_id}, separators=(",", ":"), sort_keys=True,
            ),
            "jti": self.token_id_factory(),
            "iat": int(now.timestamp()),
            "nbf": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
            "video": {
                "roomJoin": True,
                "room": f"team-call-{room_digest}",
                "canPublish": True,
                "canSubscribe": True,
                "canPublishData": False,
                "canUpdateOwnMetadata": False,
                "canPublishSources": [
                    "microphone",
                    "camera",
                    "screen_share",
                    "screen_share_audio",
                ],
            },
        }
        header_segment = _base64url(json.dumps(
            header, separators=(",", ":"), sort_keys=True,
        ).encode("utf-8"))
        payload_segment = _base64url(json.dumps(
            claims, separators=(",", ":"), sort_keys=True,
        ).encode("utf-8"))
        signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
        signature = _base64url(hmac.new(
            self.api_secret.encode("utf-8"), signing_input, hashlib.sha256,
        ).digest())
        return SfuTokenDocument(
            server_url=self.server_url,
            token=f"{header_segment}.{payload_segment}.{signature}",
            expires_at=expires_at,
        )


def _enabled(source: Mapping[str, str]) -> bool:
    raw = source.get("TEAM_CALL_SFU_ENABLED", "false").strip().lower()
    if raw in {"true", "1", "yes"}:
        return True
    if raw in {"false", "0", "no", ""}:
        return False
    raise SfuConfigurationError("TEAM_CALL_SFU_ENABLED deve ser true ou false.")


def _ttl_seconds(source: Mapping[str, str]) -> int:
    try:
        ttl = int(source.get(
            "TEAM_CALL_SFU_TOKEN_TTL_SECONDS",
            str(DEFAULT_SFU_TOKEN_TTL_SECONDS),
        ))
    except (TypeError, ValueError) as exc:
        raise SfuConfigurationError(
            "TEAM_CALL_SFU_TOKEN_TTL_SECONDS deve ser um numero inteiro."
        ) from exc
    if not MIN_SFU_TOKEN_TTL_SECONDS <= ttl <= MAX_SFU_TOKEN_TTL_SECONDS:
        raise SfuConfigurationError(
            "TEAM_CALL_SFU_TOKEN_TTL_SECONDS deve ficar entre 60 e 600."
        )
    return ttl


def _livekit_values(source: Mapping[str, str]) -> tuple[str, str, str, int]:
    url = source.get("TEAM_CALL_LIVEKIT_URL", "").strip()
    api_key = source.get("TEAM_CALL_LIVEKIT_API_KEY", "").strip()
    api_secret = source.get("TEAM_CALL_LIVEKIT_API_SECRET", "")
    if not url or not api_key or not api_secret.strip():
        raise SfuConfigurationError("URL, chave e segredo do LiveKit devem ser configurados juntos.")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "wss"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise SfuConfigurationError("TEAM_CALL_LIVEKIT_URL deve ser uma URL wss sem credenciais.")
    if (
        not api_key.isascii()
        or any(character.isspace() or ord(character) < 32 for character in api_key)
    ):
        raise SfuConfigurationError("TEAM_CALL_LIVEKIT_API_KEY deve ser ASCII sem espacos.")
    if (
        len(api_secret) < 32
        or api_secret != api_secret.strip()
        or not api_secret.isascii()
        or any(character.isspace() or ord(character) < 32 for character in api_secret)
    ):
        raise SfuConfigurationError(
            "TEAM_CALL_LIVEKIT_API_SECRET deve ter ao menos 32 caracteres ASCII sem espacos."
        )
    return url.rstrip("/"), api_key, api_secret, _ttl_seconds(source)


def sfu_provider_from_environment(
    environ: Mapping[str, str] | None = None,
) -> SfuTokenProvider:
    source = os.environ if environ is None else environ
    if not _enabled(source):
        return UnavailableSfuTokenProvider()
    url, api_key, api_secret, ttl_seconds = _livekit_values(source)
    return LiveKitTokenProvider(
        server_url=url,
        api_key=api_key,
        api_secret=api_secret,
        ttl_seconds=ttl_seconds,
    )


def validate_sfu_configuration(environ: Mapping[str, str] | None = None) -> None:
    sfu_provider_from_environment(environ)
