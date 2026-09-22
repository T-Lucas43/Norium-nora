"""Adapters em memoria dos seams internos do modulo WhatsApp."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from ._ports import (
    PortFailure,
    PreparedSend,
    ProviderMedia,
    ProviderMediaCommand,
    ProviderSendCommand,
    ProviderSendReceipt,
    ProviderTextCommand,
)
from .models import (
    ConnectionResult,
    NotConnected,
    SendCommand,
    SendMedia,
    SendResult,
    WebhookResult,
)


class InMemoryWApiAdapter:
    """Adapter deterministico para testes comportamentais do modulo."""

    def __init__(self) -> None:
        self._connections: dict[str, ConnectionResult] = {}
        self._media: dict[tuple[str, str], ProviderMedia] = {}
        self._planned_media_failures: dict[tuple[str, str], int] = {}
        self._planned_send_failures: dict[str, int] = {}
        self._planned_instances: dict[str, str] = {}
        self._instance_by_tenant: dict[str, str] = {}
        self._tenant_by_instance: dict[str, str] = {}
        self.webhook_owner_resolution_count = 0
        self._next_instance = 1
        self._next_message = 1

    def register_media(
        self,
        tenant_id: str,
        media_id: str,
        *,
        content: bytes,
        mime_type: str,
    ) -> None:
        self._media[(tenant_id, media_id)] = ProviderMedia(
            content=content,
            mime_type=mime_type,
        )

    def plan_transient_media_failures(
        self,
        tenant_id: str,
        media_id: str,
        *,
        times: int,
    ) -> None:
        if times < 0:
            raise ValueError("times nao pode ser negativo")
        self._planned_media_failures[(tenant_id, media_id)] = times

    def plan_ambiguous_send_failure(
        self,
        tenant_id: str,
        *,
        times: int = 1,
    ) -> None:
        if times < 0:
            raise ValueError("times nao pode ser negativo")
        self._planned_send_failures[tenant_id] = times

    def plan_instance(self, tenant_id: str, instance_id: str) -> None:
        self._planned_instances[tenant_id] = instance_id

    async def ensure_connection(
        self, tenant_id: str, plan: str | None = None
    ) -> ConnectionResult:
        current = self._connections.get(tenant_id)
        if current is not None:
            return current
        await asyncio.sleep(0)
        instance_id = self._planned_instances.get(tenant_id)
        if instance_id is None:
            sequence = self._next_instance
            self._next_instance += 1
            instance_id = f"memory-instance-{sequence}"
        owner = self._tenant_by_instance.get(instance_id)
        if owner is not None and owner != tenant_id:
            raise PortFailure("ownership_conflict")
        result = ConnectionResult(
            status="aguardando_qrcode",
            qr_code=f"memory-qr-{instance_id}",
            state="qr",
        )
        self._instance_by_tenant[tenant_id] = instance_id
        self._tenant_by_instance[instance_id] = tenant_id
        self._connections[tenant_id] = result
        return result

    async def disconnect_local(self, tenant_id: str) -> None:
        instance_id = self._instance_by_tenant.pop(tenant_id, None)
        if (
            instance_id is not None
            and self._tenant_by_instance.get(instance_id) == tenant_id
        ):
            self._tenant_by_instance.pop(instance_id, None)
        self._connections.pop(tenant_id, None)

    async def send(
        self,
        tenant_id: str,
        command: ProviderSendCommand,
    ) -> ProviderSendReceipt:
        if tenant_id not in self._connections:
            raise NotConnected()
        remaining_failures = self._planned_send_failures.get(tenant_id, 0)
        if remaining_failures:
            self._planned_send_failures[tenant_id] = remaining_failures - 1
            raise PortFailure("outcome_unknown")
        await asyncio.sleep(0)
        sequence = self._next_message
        self._next_message += 1
        return ProviderSendReceipt(message_id=f"memory-message-{sequence}")

    async def stream_media(
        self,
        tenant_id: str,
        media_id: str,
    ) -> ProviderMedia:
        key = (tenant_id, media_id)
        remaining_failures = self._planned_media_failures.get(key, 0)
        if remaining_failures:
            self._planned_media_failures[key] = remaining_failures - 1
            raise PortFailure("unavailable")
        media = self._media.get(key)
        if media is None:
            raise PortFailure("not_found")
        return media

    def webhook_instance_id(self, payload: Mapping[str, Any]) -> str | None:
        value = payload.get("instanceId") or payload.get("instance_id")
        return str(value).strip() if value else None

    def webhook_owner(self, instance_id: str) -> str | None:
        self.webhook_owner_resolution_count += 1
        return self._tenant_by_instance.get(instance_id)

    def classify_webhook(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("event") or "unknown").strip().lower()

    def webhook_dedup_key(
        self,
        instance_id: str,
        kind: str,
        payload: Mapping[str, Any],
    ) -> str | None:
        raw_id = payload.get("messageId") or payload.get("eventId") or payload.get("id")
        if not raw_id:
            return None
        status_token = ""
        if "status" in kind:
            status_token = str(
                payload.get("status")
                or payload.get("ack")
                or payload.get("state")
                or ""
            ).strip().lower()
        return f"{instance_id}:{kind}:{raw_id}:{status_token}"

    def webhook_binding_is_current(
        self,
        tenant_id: str,
        instance_id: str,
    ) -> bool:
        return self._tenant_by_instance.get(instance_id) == tenant_id


class InMemoryWhatsAppRuntimeAdapter:
    """Efeitos locais sem I/O usados junto do adapter W-API em memoria."""

    def __init__(self, *, webhook_delay: float = 0.0) -> None:
        self._webhook_delay = max(0.0, float(webhook_delay))
        self._planned_webhook_results: dict[str, WebhookResult] = {}
        self._planned_webhook_failures: dict[str, int] = {}

    def plan_webhook_result(
        self,
        tenant_id: str,
        result: WebhookResult,
    ) -> None:
        self._planned_webhook_results[tenant_id] = result

    def plan_webhook_failures(self, tenant_id: str, *, times: int) -> None:
        if times < 0:
            raise ValueError("times nao pode ser negativo")
        self._planned_webhook_failures[tenant_id] = times

    async def connection_established(
        self,
        tenant_id: str,
        result: ConnectionResult,
    ) -> ConnectionResult:
        return result

    async def prepare_send(
        self,
        tenant_id: str,
        command: SendCommand,
    ) -> PreparedSend:
        if isinstance(command, SendMedia):
            if command.as_sticker:
                provider_kind, public_kind = "sticker", "sticker"
            elif command.mime_type.startswith("audio/"):
                provider_kind, public_kind = "audio", "audio"
            elif command.mime_type.startswith("image/"):
                provider_kind, public_kind = "image", "midia"
            elif command.mime_type.startswith("video/"):
                provider_kind, public_kind = "video", "midia"
            else:
                provider_kind, public_kind = "document", "documento"
            return PreparedSend(
                command=command,
                provider=ProviderMediaCommand(
                    conversation_id=command.conversation_id,
                    kind=provider_kind,
                    data=command.data_url,
                    caption=command.caption or "",
                    file_name=command.file_name,
                    reply_to=command.reply_to or "",
                    view_once=command.view_once,
                ),
                context={
                    "kind": public_kind,
                    "file_name": command.file_name,
                    "view_once": command.view_once,
                },
            )
        return PreparedSend(
            command=command,
            provider=ProviderTextCommand(
                conversation_id=command.conversation_id,
                text=command.text,
                reply_to=command.reply_to or "",
            ),
        )

    async def persist_send(
        self,
        tenant_id: str,
        prepared: PreparedSend,
        receipt: ProviderSendReceipt,
    ) -> SendResult:
        command = prepared.command
        if isinstance(command, SendMedia):
            return SendResult(
                message_id=receipt.message_id,
                kind=str(prepared.context.get("kind") or "midia"),
                file_name=str(
                    prepared.context.get("file_name") or command.file_name
                ),
                view_once=bool(prepared.context.get("view_once", command.view_once)),
            )
        return SendResult(message_id=receipt.message_id)

    async def disconnected(self, tenant_id: str) -> None:
        return None

    async def dispatch_webhook(
        self,
        tenant_id: str,
        payload: Mapping[str, Any],
        kind: str,
    ) -> WebhookResult:
        remaining_failures = self._planned_webhook_failures.get(tenant_id, 0)
        if remaining_failures:
            self._planned_webhook_failures[tenant_id] = remaining_failures - 1
            raise RuntimeError("planned webhook failure")
        if self._webhook_delay:
            await asyncio.sleep(self._webhook_delay)
        return self._planned_webhook_results.get(
            tenant_id,
            WebhookResult(status="success", event=kind),
        )
