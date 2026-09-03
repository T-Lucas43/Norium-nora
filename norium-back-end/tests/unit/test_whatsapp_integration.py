"""Comportamentos do modulo profundo de integracao WhatsApp."""

from __future__ import annotations

import asyncio
import unittest

from app.modules.whatsapp import (
    DisconnectResult,
    MediaNotFound,
    MediaStream,
    NotConnected,
    OwnershipConflict,
    RemoteOutcomeUnknown,
    SendMedia,
    SendText,
    UnknownWebhookInstance,
    WebhookProcessingFailed,
    WebhookResult,
    WebhookUnauthorized,
    WhatsAppIntegration,
)
from app.modules.whatsapp.adapters import (
    InMemoryWhatsAppRuntimeAdapter,
    InMemoryWApiAdapter,
)


class WhatsAppIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_connection_uses_one_instance_per_tenant(self) -> None:
        integration = WhatsAppIntegration(
            wapi=InMemoryWApiAdapter(),
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )

        first, second = await asyncio.gather(
            integration.ensure_connection("tenant-a"),
            integration.ensure_connection("tenant-a"),
        )

        self.assertEqual(first, second)
        self.assertEqual("aguardando_qrcode", first.status)
        self.assertTrue(first.qr_code)

    async def test_send_is_isolated_by_tenant(self) -> None:
        integration = WhatsAppIntegration(
            wapi=InMemoryWApiAdapter(),
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )
        await integration.ensure_connection("tenant-a")

        sent = await integration.send(
            "tenant-a",
            SendText(conversation_id="5511999999999", text="ola"),
        )

        self.assertEqual("memory-message-1", sent.message_id)
        with self.assertRaises(NotConnected) as raised:
            await integration.send(
                "tenant-b",
                SendText(
                    conversation_id="5511888888888",
                    text="nao deve enviar",
                ),
            )
        self.assertEqual("not_connected", raised.exception.code)

    async def test_send_media_uses_the_same_public_interface(self) -> None:
        integration = WhatsAppIntegration(
            wapi=InMemoryWApiAdapter(),
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )
        await integration.ensure_connection("tenant-a")

        sent = await integration.send(
            "tenant-a",
            SendMedia(
                conversation_id="5511999999999",
                file_name="foto.png",
                mime_type="image/png",
                data_url="data:image/png;base64,aW1hZ2U=",
                caption="foto",
                reply_to="quoted-message",
                view_once=True,
            ),
        )

        self.assertEqual("memory-message-1", sent.message_id)
        self.assertEqual("midia", sent.kind)
        self.assertEqual("foto.png", sent.file_name)
        self.assertTrue(sent.view_once)

    async def test_stream_media_is_isolated_by_tenant(self) -> None:
        wapi = InMemoryWApiAdapter()
        wapi.register_media(
            "tenant-a",
            "media-1",
            content=b"jpeg-data",
            mime_type="image/jpeg",
        )
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )

        streamed = await integration.stream_media("tenant-a", "media-1")

        self.assertEqual(
            MediaStream(
                content=b"jpeg-data",
                mime_type="image/jpeg",
                cache_control="private, max-age=300",
            ),
            streamed,
        )
        with self.assertRaises(MediaNotFound) as raised:
            await integration.stream_media("tenant-b", "media-1")
        self.assertEqual("media_not_found", raised.exception.code)

    async def test_stream_media_retries_transient_remote_failures(self) -> None:
        wapi = InMemoryWApiAdapter()
        wapi.register_media(
            "tenant-a",
            "media-1",
            content=b"jpeg-data",
            mime_type="image/jpeg",
        )
        wapi.plan_transient_media_failures("tenant-a", "media-1", times=2)
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
            media_retry_delays=(0, 0),
        )

        streamed = await integration.stream_media("tenant-a", "media-1")

        self.assertEqual(
            MediaStream(
                content=b"jpeg-data",
                mime_type="image/jpeg",
                cache_control="private, max-age=300",
            ),
            streamed,
        )

    async def test_send_does_not_retry_when_remote_outcome_is_unknown(self) -> None:
        wapi = InMemoryWApiAdapter()
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )
        await integration.ensure_connection("tenant-a")
        wapi.plan_ambiguous_send_failure("tenant-a")

        with self.assertRaises(RemoteOutcomeUnknown) as raised:
            await integration.send(
                "tenant-a",
                SendText(conversation_id="5511999999999", text="ola"),
            )

        self.assertEqual("remote_outcome_unknown", raised.exception.code)
        sent = await integration.send(
            "tenant-a",
            SendText(conversation_id="5511999999999", text="nova tentativa explicita"),
        )
        self.assertEqual("memory-message-1", sent.message_id)

    async def test_one_remote_instance_cannot_have_two_tenant_owners(self) -> None:
        wapi = InMemoryWApiAdapter()
        wapi.plan_instance("tenant-a", "shared-instance")
        wapi.plan_instance("tenant-b", "shared-instance")
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )

        await integration.ensure_connection("tenant-a")

        with self.assertRaises(OwnershipConflict) as raised:
            await integration.ensure_connection("tenant-b")
        self.assertEqual("ownership_conflict", raised.exception.code)

    async def test_disconnect_is_idempotent_and_removes_local_access(self) -> None:
        integration = WhatsAppIntegration(
            wapi=InMemoryWApiAdapter(),
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="test-webhook-secret-that-is-long-enough",
        )
        await integration.ensure_connection("tenant-a")

        first = await integration.disconnect("tenant-a")
        second = await integration.disconnect("tenant-a")

        self.assertEqual(DisconnectResult(status="desconectado"), first)
        self.assertEqual(first, second)
        with self.assertRaises(NotConnected):
            await integration.send(
                "tenant-a",
                SendText(conversation_id="5511999999999", text="nao enviar"),
            )

    async def test_webhook_authenticates_before_resolving_the_tenant(self) -> None:
        wapi = InMemoryWApiAdapter()
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=InMemoryWhatsAppRuntimeAdapter(),
            webhook_secret="correct-secret",
        )

        with self.assertRaises(WebhookUnauthorized):
            await integration.handle_webhook(
                {"x-wapi-webhook-secret": "wrong-secret"},
                {"instanceId": "unknown", "event": "received", "messageId": "m-1"},
            )

        self.assertEqual(0, wapi.webhook_owner_resolution_count)

    async def test_webhook_resolves_owner_from_instance_and_ignores_spoofed_tenant(self) -> None:
        wapi = InMemoryWApiAdapter()
        runtime = InMemoryWhatsAppRuntimeAdapter()
        wapi.plan_instance("tenant-a", "instance-a")
        runtime.plan_webhook_result(
            "tenant-a",
            WebhookResult(status="success", event="owned-by-a"),
        )
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=runtime,
            webhook_secret="correct-secret",
        )
        await integration.ensure_connection("tenant-a")

        result = await integration.handle_webhook(
            {"X-WAPI-Webhook-Secret": "correct-secret"},
            {
                "instanceId": "instance-a",
                "event": "received",
                "messageId": "m-1",
                "tenantId": "tenant-b",
            },
        )

        self.assertEqual(WebhookResult(status="success", event="owned-by-a"), result)
        with self.assertRaises(UnknownWebhookInstance):
            await integration.handle_webhook(
                {"x-wapi-webhook-secret": "correct-secret"},
                {"instanceId": "unknown", "event": "received", "messageId": "m-2"},
            )

    async def test_webhook_deduplication_is_concurrent_and_scoped_by_instance(self) -> None:
        wapi = InMemoryWApiAdapter()
        runtime = InMemoryWhatsAppRuntimeAdapter(webhook_delay=0.01)
        wapi.plan_instance("tenant-a", "instance-a")
        wapi.plan_instance("tenant-b", "instance-b")
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=runtime,
            webhook_secret="correct-secret",
        )
        await integration.ensure_connection("tenant-a")
        await integration.ensure_connection("tenant-b")
        headers = {"x-wapi-webhook-secret": "correct-secret"}
        payload_a = {
            "instanceId": "instance-a",
            "event": "received",
            "messageId": "same-message",
        }
        payload_b = {**payload_a, "instanceId": "instance-b"}

        first, duplicate = await asyncio.gather(
            integration.handle_webhook(headers, payload_a),
            integration.handle_webhook(headers, payload_a),
        )
        other_tenant = await integration.handle_webhook(headers, payload_b)

        self.assertEqual({"success", "duplicate"}, {first.status, duplicate.status})
        self.assertEqual("success", other_tenant.status)

    async def test_failed_webhook_is_not_cached_and_can_be_retried(self) -> None:
        wapi = InMemoryWApiAdapter()
        runtime = InMemoryWhatsAppRuntimeAdapter()
        wapi.plan_instance("tenant-a", "instance-a")
        runtime.plan_webhook_failures("tenant-a", times=1)
        integration = WhatsAppIntegration(
            wapi=wapi,
            runtime=runtime,
            webhook_secret="correct-secret",
        )
        await integration.ensure_connection("tenant-a")
        headers = {"x-wapi-webhook-secret": "correct-secret"}
        payload = {
            "instanceId": "instance-a",
            "event": "received",
            "messageId": "retry-message",
        }

        with self.assertRaises(WebhookProcessingFailed):
            await integration.handle_webhook(headers, payload)
        retry = await integration.handle_webhook(headers, payload)
        duplicate = await integration.handle_webhook(headers, payload)

        self.assertEqual("success", retry.status)
        self.assertEqual("duplicate", duplicate.status)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
