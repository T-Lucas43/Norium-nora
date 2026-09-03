"""Modulo profundo que concentra as invariantes da integracao WhatsApp."""

from __future__ import annotations

import asyncio
import secrets
import time
import weakref
from collections.abc import Callable, Mapping, MutableMapping
from typing import Any

from ._ports import PortFailure, WApiPort, WhatsAppRuntimePort
from .models import (
    ConnectionResult,
    ConsentRequired,
    DisconnectResult,
    MediaNotFound,
    MediaStream,
    OwnershipConflict,
    FeatureUnavailable,
    RemoteOutcomeUnknown,
    RemoteRejected,
    RemoteUnavailable,
    SendCommand,
    SendResult,
    UnknownWebhookInstance,
    WebhookProcessingFailed,
    WebhookResult,
    WebhookUnauthorized,
    WebhookUnavailable,
    WhatsAppIntegrationError,
)


class WhatsAppIntegration:
    """Interface pequena para conexao, envio, webhook e midia por tenant."""

    def __init__(
        self,
        *,
        wapi: WApiPort,
        runtime: WhatsAppRuntimePort,
        webhook_secret: str | Callable[[], str],
        webhook_secret_is_valid: Callable[[str], bool] | None = None,
        allow_missing_webhook_secret: Callable[[], bool] | None = None,
        webhook_event_cache: MutableMapping[str, float] | None = None,
        webhook_inflight: MutableMapping[str, asyncio.Future[bool]] | None = None,
        webhook_cache_ttl: float = 600.0,
        media_retry_delays: tuple[float, ...] = (0.05, 0.2),
    ) -> None:
        self._wapi = wapi
        self._runtime = runtime
        self._webhook_secret = webhook_secret
        self._webhook_secret_is_valid = (
            webhook_secret_is_valid
            if webhook_secret_is_valid is not None
            else lambda value: bool(value.strip())
        )
        self._allow_missing_webhook_secret = (
            allow_missing_webhook_secret
            if allow_missing_webhook_secret is not None
            else lambda: False
        )
        self._webhook_event_cache = (
            webhook_event_cache if webhook_event_cache is not None else {}
        )
        self._webhook_inflight = (
            webhook_inflight if webhook_inflight is not None else {}
        )
        self._webhook_cache_ttl = max(0.0, float(webhook_cache_ttl))
        self._media_retry_delays = tuple(
            max(0.0, float(delay)) for delay in media_retry_delays[:2]
        )
        self._tenant_locks: weakref.WeakKeyDictionary[
            asyncio.AbstractEventLoop,
            dict[str, asyncio.Lock],
        ] = weakref.WeakKeyDictionary()

    @staticmethod
    def _tenant(tenant_id: str) -> str:
        value = str(tenant_id or "").strip()
        if not value:
            raise ValueError("tenant_id e obrigatorio")
        return value

    def _lock_for(self, tenant_id: str) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        locks = self._tenant_locks.get(loop)
        if locks is None:
            locks = {}
            self._tenant_locks[loop] = locks
        lock = locks.get(tenant_id)
        if lock is None:
            lock = asyncio.Lock()
            locks[tenant_id] = lock
        return lock

    def _configured_webhook_secret(self) -> str:
        if callable(self._webhook_secret):
            value = self._webhook_secret()
        else:
            value = self._webhook_secret
        return str(value or "")

    async def ensure_connection(self, tenant_id: str) -> ConnectionResult:
        """Converge chamadas concorrentes para uma unica instancia do tenant."""
        tenant = self._tenant(tenant_id)
        async with self._lock_for(tenant):
            try:
                result = await self._wapi.ensure_connection(tenant)
                return await self._runtime.connection_established(tenant, result)
            except PortFailure as exc:
                if exc.kind == "ownership_conflict":
                    raise OwnershipConflict() from None
                if exc.kind == "consent_required":
                    raise ConsentRequired(exc.safe_message or str(exc)) from None
                if exc.kind == "unavailable":
                    raise RemoteUnavailable() from None
                raise WhatsAppIntegrationError() from None
            except WhatsAppIntegrationError:
                raise
            except Exception:
                raise WhatsAppIntegrationError() from None

    async def disconnect(self, tenant_id: str) -> DisconnectResult:
        """Remove binding e estado local em uma transicao serializada e idempotente."""
        tenant = self._tenant(tenant_id)
        async with self._lock_for(tenant):
            try:
                await self._wapi.disconnect_local(tenant)
                await self._runtime.disconnected(tenant)
                return DisconnectResult()
            except WhatsAppIntegrationError:
                raise
            except Exception:
                raise WhatsAppIntegrationError() from None

    async def send(self, tenant_id: str, command: SendCommand) -> SendResult:
        """Serializa preparo, envio unico e persistencia para o tenant."""
        tenant = self._tenant(tenant_id)
        async with self._lock_for(tenant):
            try:
                prepared = await self._runtime.prepare_send(tenant, command)
                receipt = await self._wapi.send(tenant, prepared.provider)
                return await self._runtime.persist_send(tenant, prepared, receipt)
            except PortFailure as exc:
                if exc.kind == "outcome_unknown":
                    raise RemoteOutcomeUnknown() from None
                if exc.kind == "feature_unavailable":
                    raise FeatureUnavailable() from None
                if exc.kind == "rejected":
                    raise RemoteRejected() from None
                if exc.kind == "unavailable":
                    raise RemoteUnavailable() from None
                raise WhatsAppIntegrationError() from None
            except WhatsAppIntegrationError:
                raise
            except Exception:
                raise WhatsAppIntegrationError() from None

    async def handle_webhook(
        self,
        headers: Mapping[str, Any],
        payload: Mapping[str, Any],
    ) -> WebhookResult:
        """Autentica, resolve o owner e processa cada evento no maximo uma vez."""
        secret = self._configured_webhook_secret()
        if not secret:
            if not self._allow_missing_webhook_secret():
                raise WebhookUnavailable()
        elif not self._webhook_secret_is_valid(secret):
            raise WebhookUnavailable()
        else:
            normalized_headers = {
                str(name).strip().lower(): str(value or "")
                for name, value in headers.items()
            }
            supplied_secret = normalized_headers.get("x-wapi-webhook-secret", "")
            if not secrets.compare_digest(supplied_secret, secret):
                raise WebhookUnauthorized()

        event = dict(payload)
        instance_id = self._wapi.webhook_instance_id(event)
        owner = self._wapi.webhook_owner(instance_id) if instance_id else None
        if not instance_id or not owner:
            raise UnknownWebhookInstance()
        kind = self._wapi.classify_webhook(event)
        dedup_id = self._wapi.webhook_dedup_key(instance_id, kind, event)
        now = time.time()
        for expired in [
            key
            for key, expires_at in self._webhook_event_cache.items()
            if expires_at <= now
        ]:
            self._webhook_event_cache.pop(expired, None)

        processing_future: asyncio.Future[bool] | None = None
        if dedup_id:
            while True:
                if dedup_id in self._webhook_event_cache:
                    return WebhookResult(status="duplicate")
                active = self._webhook_inflight.get(dedup_id)
                if active is None:
                    processing_future = asyncio.get_running_loop().create_future()
                    self._webhook_inflight[dedup_id] = processing_future
                    break
                if await asyncio.shield(active):
                    return WebhookResult(status="duplicate")

        try:
            async with self._lock_for(owner):
                if not self._wapi.webhook_binding_is_current(owner, instance_id):
                    result = WebhookResult(
                        status="ignored",
                        event="stale_binding",
                    )
                else:
                    result = await self._runtime.dispatch_webhook(owner, event, kind)
            if dedup_id:
                self._webhook_event_cache[dedup_id] = (
                    time.time() + self._webhook_cache_ttl
                )
            if processing_future is not None and not processing_future.done():
                processing_future.set_result(True)
            return result
        except WhatsAppIntegrationError:
            raise
        except Exception:
            raise WebhookProcessingFailed() from None
        finally:
            if processing_future is not None:
                if not processing_future.done():
                    processing_future.set_result(False)
                if self._webhook_inflight.get(dedup_id) is processing_future:
                    self._webhook_inflight.pop(dedup_id, None)

    async def stream_media(self, tenant_id: str, media_id: str) -> MediaStream:
        """Obtem midia opaca do tenant sem expor sua origem remota."""
        tenant = self._tenant(tenant_id)
        for attempt in range(len(self._media_retry_delays) + 1):
            try:
                media = await self._wapi.stream_media(tenant, media_id)
                break
            except PortFailure as exc:
                if exc.kind == "not_found":
                    raise MediaNotFound() from None
                if exc.kind != "unavailable":
                    raise WhatsAppIntegrationError() from None
                if attempt >= len(self._media_retry_delays):
                    raise RemoteUnavailable() from None
                await asyncio.sleep(self._media_retry_delays[attempt])
            except WhatsAppIntegrationError:
                raise
            except Exception:
                raise RemoteUnavailable() from None
        return MediaStream(
            content=media.content,
            mime_type=media.mime_type,
            cache_control=media.cache_control,
        )
