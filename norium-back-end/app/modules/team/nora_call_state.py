"""Consent and capture policy. This module never grants access to a room.

The caller must supply membership/session IDs from the existing CallCoordinator,
and entitlement from a server-side plan policy, never a browser/model payload.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping


CONSENT_NOTICE = (
    "Com sua autorização, o áudio do microfone será enviado em trechos ao Groq "
    "para transcrição. O texto será compartilhado nesta reunião. Você pode "
    "retirar a autorização a qualquer momento; a Nora será pausada para todos. "
    "A transcrição terá o mesmo prazo de retenção da gravação."
)


@dataclass(frozen=True)
class NoraCallConfig:
    enabled: bool = False
    max_concurrent: int = 2
    chunk_seconds: int = 10
    queue_size: int = 4
    max_participants: int = 12

    @classmethod
    def from_environment(cls) -> NoraCallConfig:
        def bounded(name: str, default: int, low: int, high: int) -> int:
            try:
                return max(low, min(high, int(os.getenv(name, str(default)))))
            except ValueError:
                return default
        return cls(
            enabled=os.getenv("NORA_CALL_ENABLED", "0").strip() == "1",
            max_concurrent=bounded("NORA_CALL_MAX_CONCURRENT", 2, 1, 2),
            chunk_seconds=bounded("NORA_CALL_CHUNK_SECONDS", 10, 5, 10),
        )


class NoraCallDenied(ValueError):
    """Public policy errors contain no provider, audio or transcript details."""


@dataclass
class NoraConsentState:
    call_id: str
    host_user_id: str
    config: NoraCallConfig
    entitled: bool = False
    transport: str = "mesh"
    revision: int = 0
    requested: bool = False
    ended: bool = False
    sessions: dict[str, str] = field(default_factory=dict)
    consents: dict[str, tuple[int, str]] = field(default_factory=dict)

    def sync_members(self, sessions: Mapping[str, str]) -> bool:
        members = {str(user): str(session) for user, session in sessions.items()
                   if user and session}
        if len(members) > self.config.max_participants:
            raise NoraCallDenied("Limite de participantes da Nora atingido.")
        if members == self.sessions:
            return False
        self.sessions = members
        # Every roster/session change fences all buffered/in-flight audio. Each
        # participant must consent to the new audience before capture resumes.
        self.revision += 1
        self.consents.clear()
        return True

    def request(self, user_id: str, enabled: bool) -> None:
        if user_id != self.host_user_id or user_id not in self.sessions:
            raise NoraCallDenied("Somente o organizador presente pode controlar a Nora.")
        if type(enabled) is not bool:
            raise NoraCallDenied("Estado da Nora inválido.")
        if enabled and (not self.config.enabled or not self.entitled or self.transport != "sfu" or self.ended):
            raise NoraCallDenied("Nora em reuniões indisponível para esta chamada.")
        if self.requested != enabled:
            self.requested = enabled
            self.revision += 1
            self.consents.clear()

    def consent(self, user_id: str, session_id: str, revision: int, accepted: bool) -> None:
        if not self.requested or self.ended or self.sessions.get(user_id) != session_id:
            raise NoraCallDenied("Sessão de consentimento indisponível.")
        if type(revision) is not int or revision != self.revision or type(accepted) is not bool:
            raise NoraCallDenied("O aviso de transcrição mudou. Revise o consentimento.")
        if accepted:
            self.consents[user_id] = (revision, session_id)
        else:
            # Withdrawal invalidates outstanding results even if consent is
            # immediately granted again in the same browser.
            self.revision += 1
            self.consents.clear()

    @property
    def capture_allowed(self) -> bool:
        return bool(
            self.config.enabled and self.entitled and self.transport == "sfu"
            and self.requested and not self.ended and self.sessions
            and self.host_user_id in self.sessions
            and all(self.consents.get(user) == (self.revision, session)
                    for user, session in self.sessions.items())
        )

    def finish(self) -> None:
        self.ended = True
        self.requested = False
        self.revision += 1
        self.consents.clear()

    def snapshot(self, *, connected: bool = False) -> dict:
        # Consent eligibility alone is never advertised as "listening".
        state = "listening" if self.capture_allowed and connected else (
            "awaiting_agent" if self.capture_allowed else "awaiting_consent" if self.requested else "paused"
        )
        return {"callId": self.call_id, "revision": self.revision, "requested": self.requested,
                "state": state, "notice": CONSENT_NOTICE,
                "pendingUserIds": sorted(user for user, session in self.sessions.items()
                                         if self.consents.get(user) != (self.revision, session))}
