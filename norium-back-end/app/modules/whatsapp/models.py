"""Tipos estaveis da interface do modulo de integracao WhatsApp."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias


class WhatsAppIntegrationError(RuntimeError):
    """Falha publica sanitizada, sem detalhes do provedor."""

    code = "integration_error"

    def __init__(self, message: str = "Falha ao processar operacao do WhatsApp.") -> None:
        super().__init__(message)


class NotConnected(WhatsAppIntegrationError):
    """O tenant nao possui uma conexao disponivel para envio."""

    code = "not_connected"

    def __init__(self) -> None:
        super().__init__("WhatsApp nao conectado.")


class MediaNotFound(WhatsAppIntegrationError):
    """A midia nao pertence ao tenant ou nao esta disponivel."""

    code = "media_not_found"

    def __init__(self) -> None:
        super().__init__("Midia do WhatsApp nao encontrada.")


class RemoteUnavailable(WhatsAppIntegrationError):
    """O provedor remoto permaneceu indisponivel apos os retries seguros."""

    code = "remote_unavailable"

    def __init__(self) -> None:
        super().__init__("WhatsApp temporariamente indisponivel.")


class RemoteOutcomeUnknown(WhatsAppIntegrationError):
    """O provedor pode ter aceitado o envio; repetir seria inseguro."""

    code = "remote_outcome_unknown"

    def __init__(self) -> None:
        super().__init__("Nao foi possivel confirmar o resultado do envio.")


class OwnershipConflict(WhatsAppIntegrationError):
    """Uma instancia remota ja pertence a outro tenant."""

    code = "ownership_conflict"

    def __init__(self) -> None:
        super().__init__("Instancia do WhatsApp pertence a outro tenant.")


class ConsentRequired(WhatsAppIntegrationError):
    code = "consent_required"

    def __init__(self, message: str = "Aceite necessario antes de conectar.") -> None:
        super().__init__(message)


class FeatureUnavailable(WhatsAppIntegrationError):
    code = "feature_unavailable"

    def __init__(self) -> None:
        super().__init__("Recurso indisponivel no plano atual da W-API.")


class RemoteRejected(WhatsAppIntegrationError):
    code = "remote_rejected"

    def __init__(self) -> None:
        super().__init__("A API do WhatsApp recusou a operacao.")


class InvalidMedia(WhatsAppIntegrationError):
    code = "invalid_media"

    def __init__(self, message: str = "Arquivo de midia invalido.") -> None:
        super().__init__(message)


class MediaTooLarge(WhatsAppIntegrationError):
    code = "media_too_large"

    def __init__(self) -> None:
        super().__init__("Midia acima do limite permitido.")


class UnsupportedMedia(WhatsAppIntegrationError):
    code = "unsupported_media"

    def __init__(self, message: str = "Tipo de midia nao permitido.") -> None:
        super().__init__(message)


class WebhookUnauthorized(WhatsAppIntegrationError):
    """A requisicao nao comprovou conhecer o segredo do webhook."""

    code = "webhook_unauthorized"

    def __init__(self) -> None:
        super().__init__("Webhook WhatsApp nao autorizado.")


class WebhookUnavailable(WhatsAppIntegrationError):
    """A configuracao local nao permite aceitar webhooks com seguranca."""

    code = "webhook_unavailable"

    def __init__(self) -> None:
        super().__init__("Webhook WhatsApp indisponivel ate a configuracao segura.")


class UnknownWebhookInstance(WhatsAppIntegrationError):
    """A instancia nao possui um proprietario local verificavel."""

    code = "unknown_webhook_instance"

    def __init__(self) -> None:
        super().__init__("Evento nao reconhecido.")


class WebhookProcessingFailed(WhatsAppIntegrationError):
    """O evento autenticado falhou sem ser marcado como processado."""

    code = "webhook_processing_failed"

    def __init__(self) -> None:
        super().__init__("Falha temporaria ao processar webhook.")


@dataclass(frozen=True, slots=True)
class ConnectionResult:
    """Estado de conexao sem credenciais ou detalhes do provedor."""

    status: str
    qr_code: str | None = None
    state: str | None = None
    phone: str | None = None
    connected_at: float | None = None
    detail: str | None = None
    consent_required: bool = False


@dataclass(frozen=True, slots=True)
class DisconnectResult:
    """Resultado idempotente da remocao da conexao local."""

    status: str = "desconectado"


@dataclass(frozen=True, slots=True)
class WebhookResult:
    """Resposta publica minima do processamento de um webhook."""

    status: str
    event: str | None = None

    def as_dict(self) -> dict[str, str]:
        result = {"status": self.status}
        if self.event is not None:
            result["event"] = self.event
        return result


@dataclass(frozen=True, slots=True)
class SendText:
    """Comando de envio de texto independente do contrato da W-API."""

    conversation_id: str
    text: str
    reply_to: str | None = None


@dataclass(frozen=True, slots=True)
class SendMedia:
    """Comando de midia sem credenciais nem URL remota do provedor."""

    conversation_id: str
    file_name: str
    mime_type: str
    data_url: str
    caption: str | None = None
    as_sticker: bool = False
    reply_to: str | None = None
    view_once: bool = False


SendCommand: TypeAlias = SendText | SendMedia


@dataclass(frozen=True, slots=True)
class SendResult:
    """Resultado publico de envio sem tokens ou URLs do provedor."""

    message_id: str
    status: str = "enviado_real"
    channel: str = "whatsapp"
    kind: str | None = None
    local_url: str | None = None
    file_name: str | None = None
    view_once: bool = False


@dataclass(frozen=True, slots=True)
class MediaStream:
    """Midia pronta para a resposta HTTP, sem origem ou credenciais remotas."""

    content: bytes
    mime_type: str
    cache_control: str
