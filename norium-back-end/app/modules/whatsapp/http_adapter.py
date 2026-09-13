"""Adapter de producao do port W-API sobre os servicos HTTP existentes.

As dependencias sao suppliers deliberadamente late-bound. Isso permite que o
composition root troque ``wapi_connect``/``wapi_messaging`` em runtime (como os
testes legados ja fazem) sem capturar uma instancia antiga no modulo profundo.

Credenciais, ids de instancia e URLs remotas nunca fazem parte dos argumentos
ou resultados publicos deste adapter. Eles continuam resolvidos pelos servicos
W-API e pelo store de bindings, atras deste port interno.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeAlias

from app.services.wapi_client import WapiError
from app.services.wapi_connect import ConsentRequiredError
from app.services.wapi_messaging import MessagingUnavailable

from ._ports import (
    PortFailure,
    ProviderMedia,
    ProviderMediaCommand,
    ProviderSendCommand,
    ProviderSendReceipt,
    ProviderTextCommand,
)
from .models import (
    ConnectionResult,
    InvalidMedia,
    MediaNotFound,
    MediaTooLarge,
    NotConnected,
    UnsupportedMedia,
)


DependencySupplier: TypeAlias = Callable[[], Any]
MediaStreamer: TypeAlias = Callable[
    [str, str],
    Awaitable[ProviderMedia] | ProviderMedia,
]
LocalDisconnector: TypeAlias = Callable[[str], Awaitable[object] | object]


async def _await_if_needed(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _text_field(command: object, field: str, default: str = "") -> str:
    value = getattr(command, field, default)
    return str(value or "")


def _optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _provider_rejected(exc: WapiError) -> bool:
    """Distingue rejeicao confirmada de resultado remoto possivelmente aceito."""
    status = exc.status
    return status is not None and 300 <= status < 500 and status not in {
        408,
        425,
        429,
    }


class HttpWApiAdapter:
    """Implementacao de producao de :class:`WApiPort`.

    O adapter nao instancia os servicos: o composition root fornece suppliers
    como ``lambda: wapi_connect``. Assim, monkey-patches e futuras trocas de
    implementacao continuam visiveis em cada chamada.

    ``media_streamer`` e intencionalmente opaco. A resolucao de metadados,
    binding, credencial, URL temporaria e cache fica fora deste adapter; aqui
    entram apenas ``tenant_id``/``media_id`` e saem bytes mais MIME type.
    """

    def __init__(
        self,
        *,
        connect_service: DependencySupplier,
        messaging_service: DependencySupplier,
        binding_store: DependencySupplier,
        webhook_adapter: DependencySupplier,
        media_streamer: MediaStreamer,
        local_disconnector: LocalDisconnector | None = None,
        media_send_timeout: float = 110.0,
    ) -> None:
        self._connect_service = connect_service
        self._messaging_service = messaging_service
        self._binding_store = binding_store
        self._webhook_adapter = webhook_adapter
        self._media_streamer = media_streamer
        self._local_disconnector = local_disconnector
        self._media_send_timeout = max(1.0, float(media_send_timeout))

    async def ensure_connection(self, tenant_id: str) -> ConnectionResult:
        try:
            raw = await self._connect_service().start(tenant_id)
        except ConsentRequiredError as exc:
            raise PortFailure("consent_required", str(exc)) from None
        except WapiError:
            raise PortFailure("unavailable") from None
        except PortFailure:
            raise
        except Exception as exc:
            # O binding e o lifecycle sao a fonte das invariantes de ownership.
            # Seus erros nao atravessam o port nem carregam detalhes persistidos.
            name = type(exc).__name__
            if name in {"InstanceOwnershipError", "OwnershipConflictError"}:
                raise PortFailure("ownership_conflict") from None
            raise PortFailure("unavailable") from None

        if not isinstance(raw, Mapping):
            raise PortFailure("unavailable")
        return ConnectionResult(
            status=str(raw.get("status") or "iniciando"),
            qr_code=(str(raw["qrcode"]) if raw.get("qrcode") else None),
            state=(str(raw["state"]) if raw.get("state") else None),
            phone=(str(raw["numero"]) if raw.get("numero") else None),
            connected_at=_optional_float(raw.get("conectadoEm")),
            detail=(str(raw["detail"]) if raw.get("detail") else None),
            consent_required=bool(raw.get("consent_required", False)),
        )

    async def disconnect_local(self, tenant_id: str) -> None:
        """Remove somente o binding Norium; nunca desloga a instancia remota."""
        try:
            if self._local_disconnector is not None:
                await _await_if_needed(self._local_disconnector(tenant_id))
            else:
                clear_binding = self._binding_store().clear_binding
                await _await_if_needed(clear_binding(tenant_id))
        except PortFailure:
            raise
        except Exception:
            raise PortFailure("persistence") from None

    async def send(
        self,
        tenant_id: str,
        command: ProviderSendCommand,
    ) -> ProviderSendReceipt:
        """Executa exatamente um POST logico; envio nunca recebe retry aqui."""
        service = self._messaging_service()
        conversation_id = _text_field(command, "conversation_id")
        reply_to = _text_field(command, "reply_to")
        try:
            # O runtime ja entregou um comando privado pronto para o provedor.
            if isinstance(command, ProviderMediaCommand):
                raw = await service.send_media(
                    tenant_id,
                    conversation_id,
                    _text_field(command, "kind"),
                    _text_field(command, "data"),
                    caption=_text_field(command, "caption"),
                    file_name=_text_field(command, "file_name"),
                    extension=_text_field(command, "extension"),
                    timeout=self._media_send_timeout,
                    quoted_message_id=reply_to,
                    view_once=bool(getattr(command, "view_once", False)),
                )
            elif isinstance(command, ProviderTextCommand):
                raw = await service.send_text(
                    tenant_id,
                    conversation_id,
                    _text_field(command, "text"),
                    quoted_message_id=reply_to,
                )
            else:
                raise PortFailure("rejected")
        except (MessagingUnavailable, NotConnected):
            raise NotConnected() from None
        except WapiError as exc:
            if exc.status == 403 or "acesso negado" in str(exc.message or "").lower():
                raise PortFailure("feature_unavailable") from None
            if _provider_rejected(exc):
                raise PortFailure("rejected") from None
            # Network/timeout/5xx apos um envio nao pode ser repetido: o
            # provedor pode ter aceitado a mensagem antes da falha observada.
            raise PortFailure("outcome_unknown") from None
        except PortFailure:
            raise
        except Exception:
            raise PortFailure("outcome_unknown") from None

        if not isinstance(raw, Mapping):
            raise PortFailure("outcome_unknown")
        message_id = str(raw.get("messageId") or "").strip()
        if not raw.get("sent") or not message_id:
            raise PortFailure("rejected")
        return ProviderSendReceipt(message_id=message_id)

    async def stream_media(
        self,
        tenant_id: str,
        media_id: str,
    ) -> ProviderMedia:
        try:
            media = await _await_if_needed(self._media_streamer(tenant_id, media_id))
        except MediaNotFound:
            raise PortFailure("not_found") from None
        except PortFailure:
            raise
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if status_code == 404:
                raise PortFailure("not_found") from None
            if status_code == 400:
                raise InvalidMedia(
                    str(getattr(exc, "detail", "") or "")
                ) from None
            if status_code == 413:
                raise MediaTooLarge() from None
            if status_code == 415:
                raise UnsupportedMedia(
                    str(getattr(exc, "detail", "") or "")
                ) from None
            raise PortFailure("unavailable") from None
        if not isinstance(media, ProviderMedia):
            raise PortFailure("unavailable")
        return media

    def webhook_instance_id(self, payload: Mapping[str, Any]) -> str | None:
        try:
            value = self._webhook_adapter().instance_id(dict(payload))
        except Exception:
            return None
        normalized = str(value or "").strip()
        return normalized or None

    def webhook_owner(self, instance_id: str) -> str | None:
        try:
            value = self._binding_store().owner_of_instance(instance_id)
        except Exception:
            # Falha fechada: o chamador nao deve diferenciar instancia alheia de
            # indisponibilidade do indice de ownership.
            return None
        normalized = str(value or "").strip()
        return normalized or None

    def classify_webhook(self, payload: Mapping[str, Any]) -> str:
        try:
            value = self._webhook_adapter().classify_event(dict(payload))
        except Exception:
            return "unknown"
        return str(value or "unknown").strip().lower() or "unknown"

    def webhook_dedup_key(
        self,
        instance_id: str,
        kind: str,
        payload: Mapping[str, Any],
    ) -> str | None:
        try:
            raw_id = self._webhook_adapter().event_id(dict(payload))
        except Exception:
            return None
        event_id = str(raw_id or "").strip()
        if not event_id:
            return None
        status_token = ""
        webhook = self._webhook_adapter()
        status_kind = str(getattr(webhook, "EVENT_STATUS", "status"))
        if kind == status_kind:
            nested = payload.get("data")
            wrapped = nested if isinstance(nested, Mapping) else {}
            status_token = str(
                payload.get("status")
                or payload.get("ack")
                or payload.get("state")
                or payload.get("chatStatus")
                or payload.get("unreadCount")
                or wrapped.get("status")
                or wrapped.get("ack")
                or wrapped.get("state")
                or wrapped.get("chatStatus")
                or wrapped.get("unreadCount")
                or ""
            ).strip().lower()
        return f"{instance_id}:{kind}:{event_id}:{status_token}"

    def webhook_binding_is_current(
        self,
        tenant_id: str,
        instance_id: str,
    ) -> bool:
        try:
            owner = self._binding_store().owner_of_instance(instance_id)
        except Exception:
            return False
        return str(owner or "").strip() == tenant_id


__all__ = ["HttpWApiAdapter"]
