"""Armazenamento autenticado de credenciais atrás de uma interface pequena."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

from cryptography.fernet import Fernet, InvalidToken


_FERNET_ENVELOPE_FORMAT = "fernet-v1"


class CredentialConfigurationError(RuntimeError):
    """A configuração segura da cifra está ausente ou é inválida."""


class CredentialRecoveryError(RuntimeError):
    """A credencial não pôde ser autenticada e recuperada."""


@dataclass(frozen=True, slots=True)
class RecoveredCredential:
    """Resultado em memória; nunca inclui o segredo na representação."""

    value: str = field(repr=False)
    needs_rewrite: bool = False


class CredentialStore(Protocol):
    """Seam mínima usada por adapters que persistem credenciais."""

    def store(self, credential: str) -> dict[str, Any]:
        """Protege uma credencial e devolve um envelope persistível."""

    def retrieve(self, envelope: object) -> RecoveredCredential:
        """Autentica e recupera uma credencial do envelope."""


class FernetCredentialStore:
    """Adapter Fernet com chave ativa e chaves antigas somente para leitura."""

    def __init__(
        self,
        active_key: str,
        previous_keys: Sequence[str] = (),
    ) -> None:
        configured_keys = tuple(dict.fromkeys((active_key, *previous_keys)))
        fernets: list[Fernet] = []
        invalid = False
        for configured_key in configured_keys:
            if not isinstance(configured_key, str) or not configured_key:
                invalid = True
                break
            try:
                encoded_key = configured_key.encode("ascii")
                fernets.append(Fernet(encoded_key))
            except (TypeError, ValueError, UnicodeError):
                invalid = True
                break
        if invalid or not fernets:
            raise CredentialConfigurationError(
                "Configuração da chave de criptografia de credenciais inválida."
            ) from None
        self._fernets = tuple(fernets)

    def __repr__(self) -> str:
        return "<FernetCredentialStore keys=<redacted>>"

    def store(self, credential: str) -> dict[str, Any]:
        if not isinstance(credential, str) or not credential:
            raise CredentialRecoveryError(
                "Não foi possível proteger a credencial."
            ) from None
        encoded_credential: bytes | None = None
        try:
            encoded_credential = credential.encode("utf-8")
        except UnicodeError:
            pass
        if encoded_credential is None:
            raise CredentialRecoveryError(
                "Não foi possível proteger a credencial."
            ) from None
        ciphertext = self._fernets[0].encrypt(encoded_credential).decode("ascii")
        return {
            "format": _FERNET_ENVELOPE_FORMAT,
            "ciphertext": ciphertext,
        }

    def retrieve(self, envelope: object) -> RecoveredCredential:
        if not isinstance(envelope, dict):
            raise CredentialRecoveryError(
                "Não foi possível recuperar a credencial protegida."
            ) from None
        ciphertext = envelope.get("ciphertext")
        if (
            envelope.get("format") != _FERNET_ENVELOPE_FORMAT
            or not isinstance(ciphertext, str)
            or not ciphertext
        ):
            raise CredentialRecoveryError(
                "Não foi possível recuperar a credencial protegida."
            ) from None

        encoded_ciphertext: bytes | None = None
        try:
            encoded_ciphertext = ciphertext.encode("ascii")
        except UnicodeError:
            pass
        if encoded_ciphertext is None:
            raise CredentialRecoveryError(
                "Não foi possível recuperar a credencial protegida."
            ) from None

        for key_index, fernet in enumerate(self._fernets):
            plaintext: bytes | None = None
            try:
                plaintext = fernet.decrypt(encoded_ciphertext)
            except InvalidToken:
                pass
            if plaintext is None:
                continue

            recovered: str | None = None
            try:
                recovered = plaintext.decode("utf-8")
            except UnicodeError:
                pass
            if recovered:
                return RecoveredCredential(
                    value=recovered,
                    needs_rewrite=key_index != 0,
                )
            break

        raise CredentialRecoveryError(
            "Não foi possível recuperar a credencial protegida."
        ) from None
