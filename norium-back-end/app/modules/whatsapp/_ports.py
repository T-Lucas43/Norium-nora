"""Seams internos do modulo; nao fazem parte da interface dos chamadores."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol, TypeAlias

from .models import ConnectionResult, SendCommand, SendResult, WebhookResult


class PortFailure(RuntimeError):
    """Falha interna do port que nunca deve atravessar a interface publica."""

    def __init__(self, kind: str, message: str = "") -> None:
        super().__init__(kind)
        self.kind = kind
        self.safe_message = str(message or "")


@dataclass(frozen=True, slots=True)
class ProviderSendReceipt:
    """Recibo interno retornado pelo provedor apos um envio."""

    message_id: str


@dataclass(frozen=True, slots=True)
class ProviderTextCommand:
    conversation_id: str
    text: str
    reply_to: str = ""


@dataclass(frozen=True, slots=True)
class ProviderMediaCommand:
    conversation_id: str
    kind: str
    data: str
    caption: str = ""
    file_name: str = ""
    extension: str = ""
    reply_to: str = ""
    view_once: bool = False


ProviderSendCommand: TypeAlias = ProviderTextCommand | ProviderMediaCommand


@dataclass(frozen=True, slots=True)
class PreparedSend:
    command: SendCommand
    provider: ProviderSendCommand
    context: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProviderMedia:
    """Conteudo de midia retornado pelo port, antes da politica HTTP local."""

    content: bytes
    mime_type: str
    cache_control: str = "private, max-age=300"


class WApiPort(Protocol):
    """Port interno para a dependencia externa W-API."""

    async def ensure_connection(self, tenant_id: str) -> ConnectionResult: ...

    async def disconnect_local(self, tenant_id: str) -> None: ...

    async def send(
        self,
        tenant_id: str,
        command: ProviderSendCommand,
    ) -> ProviderSendReceipt: ...

    async def stream_media(
        self,
        tenant_id: str,
        media_id: str,
    ) -> ProviderMedia: ...

    def webhook_instance_id(self, payload: Mapping[str, Any]) -> str | None: ...

    def webhook_owner(self, instance_id: str) -> str | None: ...

    def classify_webhook(self, payload: Mapping[str, Any]) -> str: ...

    def webhook_dedup_key(
        self,
        instance_id: str,
        kind: str,
        payload: Mapping[str, Any],
    ) -> str | None: ...

    def webhook_binding_is_current(
        self,
        tenant_id: str,
        instance_id: str,
    ) -> bool: ...


class WhatsAppRuntimePort(Protocol):
    """Efeitos locais mantidos atras do seam durante a migracao incremental."""

    async def connection_established(
        self,
        tenant_id: str,
        result: ConnectionResult,
    ) -> ConnectionResult: ...

    async def prepare_send(
        self,
        tenant_id: str,
        command: SendCommand,
    ) -> PreparedSend: ...

    async def persist_send(
        self,
        tenant_id: str,
        prepared: PreparedSend,
        receipt: ProviderSendReceipt,
    ) -> SendResult: ...

    async def disconnected(self, tenant_id: str) -> None: ...

    async def dispatch_webhook(
        self,
        tenant_id: str,
        payload: Mapping[str, Any],
        kind: str,
    ) -> WebhookResult: ...
