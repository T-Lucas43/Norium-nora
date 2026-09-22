"""Contrato unitario do adapter HTTP interno da integracao WhatsApp."""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock

from app.modules.whatsapp._ports import (
    PortFailure,
    ProviderMedia,
    ProviderTextCommand,
)
from app.modules.whatsapp.http_adapter import HttpWApiAdapter
from app.services.wapi_client import WapiError


class HttpWApiAdapterTests(unittest.IsolatedAsyncioTestCase):
    def _adapter(self, **overrides: object) -> HttpWApiAdapter:
        dependencies: dict[str, object] = {
            "connect_service": lambda: MagicMock(),
            "messaging_service": lambda: MagicMock(),
            "binding_store": lambda: MagicMock(),
            "webhook_adapter": lambda: MagicMock(),
            "media_streamer": AsyncMock(
                return_value=ProviderMedia(
                    content=b"media",
                    mime_type="application/octet-stream",
                )
            ),
        }
        dependencies.update(overrides)
        return HttpWApiAdapter(**dependencies)  # type: ignore[arg-type]

    async def test_connect_service_supplier_is_resolved_at_call_time(self) -> None:
        stale_service = MagicMock()
        stale_service.start = AsyncMock()
        current_service = MagicMock()
        current_service.start = AsyncMock(
            return_value={"status": "conectado", "numero": "5511999999999"}
        )
        selected = [stale_service]
        adapter = self._adapter(connect_service=lambda: selected[0])
        selected[0] = current_service

        result = await adapter.ensure_connection("tenant-a")

        stale_service.start.assert_not_awaited()
        current_service.start.assert_awaited_once_with("tenant-a", None)
        self.assertEqual("conectado", result.status)
        self.assertEqual("5511999999999", result.phone)

    async def test_plan_is_forwarded_and_effective_plan_is_exposed(self) -> None:
        connect_service = MagicMock()
        connect_service.start = AsyncMock(
            return_value={"status": "aguardando_qrcode", "qrcode": "qr"}
        )
        connect_service.current_plan = MagicMock(return_value="pro")
        adapter = self._adapter(connect_service=lambda: connect_service)

        result = await adapter.ensure_connection("tenant-a", "pro")

        connect_service.start.assert_awaited_once_with("tenant-a", "pro")
        self.assertEqual("pro", result.plan)

    async def test_disconnect_uses_only_the_local_disconnector(self) -> None:
        connect_service = MagicMock()
        connect_service.disconnect = AsyncMock()
        binding_store = MagicMock()
        binding_store.clear_binding = AsyncMock()
        local_disconnector = AsyncMock()
        adapter = self._adapter(
            connect_service=lambda: connect_service,
            binding_store=lambda: binding_store,
            local_disconnector=local_disconnector,
        )

        await adapter.disconnect_local("tenant-a")

        local_disconnector.assert_awaited_once_with("tenant-a")
        connect_service.disconnect.assert_not_awaited()
        binding_store.clear_binding.assert_not_awaited()

    async def test_ambiguous_text_send_is_not_retried(self) -> None:
        messaging_service = MagicMock()
        messaging_service.send_text = AsyncMock(
            side_effect=WapiError("gateway timeout", status=504)
        )
        adapter = self._adapter(messaging_service=lambda: messaging_service)
        command = ProviderTextCommand(
            conversation_id="5511999999999",
            text="ola",
            reply_to="quoted-message",
        )

        with self.assertRaises(PortFailure) as raised:
            await adapter.send("tenant-a", command)

        self.assertEqual("outcome_unknown", raised.exception.kind)
        messaging_service.send_text.assert_awaited_once_with(
            "tenant-a",
            "5511999999999",
            "ola",
            quoted_message_id="quoted-message",
        )

    async def test_media_streamer_is_an_opaque_mapping(self) -> None:
        provider_media = ProviderMedia(
            content=b"opaque-bytes",
            mime_type="image/webp",
            cache_control="private, max-age=17",
        )
        media_streamer = AsyncMock(return_value=provider_media)
        adapter = self._adapter(media_streamer=media_streamer)

        result = await adapter.stream_media("tenant-a", "opaque-media-id")

        media_streamer.assert_awaited_once_with("tenant-a", "opaque-media-id")
        self.assertIs(provider_media, result)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
