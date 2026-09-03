"""Adapter incremental para efeitos locais ainda implementados pelo chat legado.

O adapter nao importa o router nem captura seus singletons. Os efeitos sao
fornecidos como callbacks e resolvidos somente quando cada operacao acontece;
assim, a composicao pode usar lambdas que consultam o estado atual do modulo
legado (inclusive durante testes que substituem dependencias em runtime).
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeAlias, TypeVar

from ._ports import PreparedSend, ProviderSendReceipt
from .models import ConnectionResult, SendCommand, SendResult, WebhookResult


_T = TypeVar("_T")
_MaybeAwaitable: TypeAlias = _T | Awaitable[_T]

ConnectionEstablishedCallback: TypeAlias = Callable[
    [str, ConnectionResult],
    _MaybeAwaitable[ConnectionResult | Mapping[str, Any] | None],
]
DisconnectedCallback: TypeAlias = Callable[
    [str],
    _MaybeAwaitable[object | None],
]
PrepareSendCallback: TypeAlias = Callable[
    [str, SendCommand],
    _MaybeAwaitable[PreparedSend],
]
PersistSendCallback: TypeAlias = Callable[
    [str, PreparedSend, ProviderSendReceipt],
    _MaybeAwaitable[SendResult | Mapping[str, Any] | None],
]
DispatchWebhookCallback: TypeAlias = Callable[
    [str, Mapping[str, Any], str],
    _MaybeAwaitable[WebhookResult | Mapping[str, Any]],
]


async def _resolve(value: _MaybeAwaitable[_T]) -> _T:
    """Aceita callbacks sincronizados ou assincronos sem esconder seus erros."""
    if inspect.isawaitable(value):
        return await value
    return value


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _connection_result(
    value: ConnectionResult | Mapping[str, Any] | None,
    *,
    fallback: ConnectionResult,
) -> ConnectionResult:
    if value is None:
        return fallback
    if isinstance(value, ConnectionResult):
        return value

    status = _optional_text(value.get("status")) or fallback.status
    qr_code = _optional_text(
        value.get("qr_code", value.get("qrcode", value.get("qrCode")))
    )
    if qr_code is None and status != "conectado":
        qr_code = fallback.qr_code

    return ConnectionResult(
        status=status,
        qr_code=qr_code,
        state=_optional_text(value.get("state")) or fallback.state,
        phone=_optional_text(value.get("phone")) or fallback.phone,
        connected_at=(
            _optional_float(value.get("connected_at", value.get("connectedAt")))
            if "connected_at" in value or "connectedAt" in value
            else fallback.connected_at
        ),
        detail=_optional_text(value.get("detail")) or fallback.detail,
        consent_required=bool(
            value.get(
                "consent_required",
                value.get("consentRequired", fallback.consent_required),
            )
        ),
    )


def _send_result(
    value: SendResult | Mapping[str, Any] | None,
    *,
    receipt: ProviderSendReceipt,
) -> SendResult:
    if value is None:
        return SendResult(message_id=receipt.message_id)
    if isinstance(value, SendResult):
        return value
    message_id = _optional_text(
        value.get("message_id", value.get("messageId", value.get("id")))
    )
    return SendResult(
        message_id=message_id or receipt.message_id,
        status=_optional_text(value.get("status")) or "enviado_real",
        channel=_optional_text(value.get("channel", value.get("canal")))
        or "whatsapp",
        kind=_optional_text(value.get("kind", value.get("tipo"))),
        local_url=_optional_text(
            value.get("local_url", value.get("arquivoUrl"))
        ),
        file_name=_optional_text(
            value.get("file_name", value.get("nomeArquivo"))
        ),
        view_once=bool(
            value.get("view_once", value.get("visualizacaoUnica", False))
        ),
    )


def _webhook_result(
    value: WebhookResult | Mapping[str, Any],
) -> WebhookResult:
    if isinstance(value, WebhookResult):
        return value
    status = _optional_text(value.get("status")) or "ignored"
    return WebhookResult(
        status=status,
        event=_optional_text(value.get("event")),
    )


class LegacyWhatsAppRuntimeAdapter:
    """Ponte callback-driven entre o modulo profundo e efeitos ainda legados."""

    def __init__(
        self,
        *,
        connection_established: ConnectionEstablishedCallback,
        disconnected: DisconnectedCallback,
        prepare_send: PrepareSendCallback,
        persist_send: PersistSendCallback,
        dispatch_webhook: DispatchWebhookCallback,
    ) -> None:
        self._connection_established = connection_established
        self._disconnected = disconnected
        self._prepare_send = prepare_send
        self._persist_send = persist_send
        self._dispatch_webhook = dispatch_webhook

    async def connection_established(
        self,
        tenant_id: str,
        result: ConnectionResult,
    ) -> ConnectionResult:
        legacy_result = await _resolve(
            self._connection_established(tenant_id, result)
        )
        return _connection_result(legacy_result, fallback=result)

    async def disconnected(self, tenant_id: str) -> None:
        await _resolve(self._disconnected(tenant_id))

    async def prepare_send(
        self,
        tenant_id: str,
        command: SendCommand,
    ) -> PreparedSend:
        return await _resolve(self._prepare_send(tenant_id, command))

    async def persist_send(
        self,
        tenant_id: str,
        prepared: PreparedSend,
        receipt: ProviderSendReceipt,
    ) -> SendResult:
        legacy_result = await _resolve(
            self._persist_send(tenant_id, prepared, receipt)
        )
        return _send_result(legacy_result, receipt=receipt)

    async def dispatch_webhook(
        self,
        tenant_id: str,
        payload: Mapping[str, Any],
        kind: str,
    ) -> WebhookResult:
        legacy_result = await _resolve(
            self._dispatch_webhook(tenant_id, payload, kind)
        )
        return _webhook_result(legacy_result)


CallbackWhatsAppRuntimeAdapter = LegacyWhatsAppRuntimeAdapter


__all__ = [
    "CallbackWhatsAppRuntimeAdapter",
    "LegacyWhatsAppRuntimeAdapter",
]
