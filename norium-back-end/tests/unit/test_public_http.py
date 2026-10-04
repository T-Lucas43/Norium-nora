from __future__ import annotations

import os
import socket
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpcore
import httpx
from fastapi import HTTPException

from app.infrastructure import public_http
from app.modules.intelligence import service


def records(*addresses):
    return [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM,
             socket.IPPROTO_TCP, "", (address, 443)) for address in addresses]


class RecordingStream(httpcore.AsyncMockStream):
    def __init__(self, content):
        super().__init__(content)
        self.sent = []
        self.tls = []
        self.closed = False

    async def write(self, buffer, timeout=None):
        self.sent.append(buffer)
        await super().write(buffer, timeout)

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls.append((ssl_context, server_hostname))
        return await super().start_tls(ssl_context, server_hostname, timeout)

    async def aclose(self):
        self.closed = True
        await super().aclose()


class RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, response=b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"):
        self.stream = RecordingStream([response])
        self.calls = []
        self.failures = set()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.calls.append((host, port, timeout))
        if host in self.failures:
            raise httpcore.ConnectError("Synthetic failure")
        return self.stream

    async def sleep(self, seconds):
        pass


class PublicHTTPTests(unittest.IsolatedAsyncioTestCase):
    def test_invalid_private_multicast_and_userinfo_urls_fail_closed(self):
        for url in (
            "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://224.0.0.1/",
            "http://localhost/", "https://user:password@example.com/", "https://@example.com/",
            "https://example.com:invalid/", "https://example.com:0/", "https://example.com:8443/",
            "file:///etc/passwd", "https://[invalid/", "http://example.com/",
        ):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                public_http.validate_public_url(url)

    async def test_empty_malformed_mixed_private_and_multicast_dns_are_rejected(self):
        for answers in ([], records("invalid"), records("8.8.8.8", "127.0.0.1"),
                        records("224.0.0.1"), records("::ffff:127.0.0.1")):
            with self.subTest(answers=answers), patch.object(public_http.socket, "getaddrinfo", return_value=answers):
                with self.assertRaises(HTTPException):
                    await public_http.resolve_public_addresses("example.com", 443)

    async def test_dns_error_is_rejected_before_connecting(self):
        backend = RecordingBackend()
        with patch.object(public_http.socket, "getaddrinfo", side_effect=socket.gaierror()):
            with self.assertRaises(HTTPException):
                await public_http.PublicNetworkBackend(backend).connect_tcp("example.com", 443)
        self.assertEqual([], backend.calls)

    async def test_connect_uses_numeric_public_ip_with_original_host_and_verified_tls(self):
        backend = RecordingBackend()
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8")) as dns:
            async with httpx.AsyncClient(transport=public_http.PublicHTTPTransport(["example.com"], network_backend=backend), trust_env=False) as client:
                result = await client.get("https://example.com/resource", extensions={"sni_hostname": "attacker.example"})
        self.assertEqual("ok", result.text)
        self.assertEqual(1, dns.call_count)
        self.assertEqual("8.8.8.8", backend.calls[0][0])
        self.assertGreater(backend.calls[0][2], 0)
        self.assertLessEqual(backend.calls[0][2], 5)
        self.assertIn(b"Host: example.com\r\n", b"".join(backend.stream.sent))
        context, hostname = backend.stream.tls[0]
        self.assertEqual("example.com", hostname)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)
        self.assertTrue(context.check_hostname)
        self.assertTrue(backend.stream.closed)

    async def test_rebinding_after_preflight_is_rejected_before_any_tcp_connection(self):
        backend = RecordingBackend()
        with patch.object(public_http.socket, "getaddrinfo", side_effect=[records("8.8.8.8"), records("127.0.0.1")]):
            await public_http.assert_public_dns("example.com")
            async with httpx.AsyncClient(transport=public_http.PublicHTTPTransport(["example.com"], network_backend=backend), trust_env=False) as client:
                with self.assertRaises(HTTPException):
                    await client.get("https://example.com/")
        self.assertEqual([], backend.calls)

    async def test_failover_uses_only_addresses_from_same_validated_resolution(self):
        backend = RecordingBackend()
        backend.failures.add("8.8.8.8")
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8", "1.1.1.1")) as dns:
            stream = await public_http.PublicNetworkBackend(backend).connect_tcp("example.com", 443)
        self.assertIs(backend.stream, stream)
        self.assertEqual(["8.8.8.8", "1.1.1.1"], [call[0] for call in backend.calls])
        self.assertEqual(1, dns.call_count)

    async def test_private_answer_prevents_even_public_address_from_connecting(self):
        backend = RecordingBackend()
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8", "10.0.0.1")):
            with self.assertRaises(HTTPException):
                await public_http.PublicNetworkBackend(backend).connect_tcp("example.com", 443)
        self.assertEqual([], backend.calls)

    async def test_transport_applies_domain_policy_before_resolution(self):
        backend = RecordingBackend()
        transport = public_http.PublicHTTPTransport(["allowed.example"], ["blocked.allowed.example"], backend)
        with patch.object(public_http.socket, "getaddrinfo") as dns:
            async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
                for url in ("https://outside.example/", "https://blocked.allowed.example/"):
                    with self.subTest(url=url), self.assertRaises(HTTPException):
                        await client.get(url)
        dns.assert_not_called()
        self.assertEqual([], backend.calls)

    async def test_unix_socket_and_non_web_port_are_rejected(self):
        backend = public_http.PublicNetworkBackend(RecordingBackend())
        with self.assertRaises(HTTPException):
            await backend.connect_unix_socket("/var/run/docker.sock")
        with self.assertRaises(HTTPException):
            await backend.connect_tcp("8.8.8.8", 22)

    async def test_transport_without_allowed_origin_fails_before_resolution(self):
        backend = RecordingBackend()
        with patch.object(public_http.socket, "getaddrinfo") as dns:
            async with httpx.AsyncClient(transport=public_http.PublicHTTPTransport(network_backend=backend), trust_env=False) as client:
                with self.assertRaises(HTTPException):
                    await client.get("https://example.com/")
        dns.assert_not_called()
        self.assertEqual([], backend.calls)

    async def test_safe_fetch_rejects_redirect_without_following_or_using_environment_proxy(self):
        backend = RecordingBackend(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n")
        factory = public_http.PublicHTTPTransport
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8")), patch.object(
            service, "PublicHTTPTransport", side_effect=lambda *args: factory(*args, network_backend=backend)
        ), patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:3128", "HTTPS_PROXY": "http://127.0.0.1:3128"}):
            with self.assertRaises(HTTPException) as error:
                await service.safe_fetch("https://example.com/")
        self.assertEqual(409, error.exception.status_code)
        self.assertEqual(["8.8.8.8"], [call[0] for call in backend.calls])
        self.assertTrue(backend.stream.closed)

    async def test_safe_fetch_keeps_content_limit_and_closes_connection(self):
        body = b"x" * (service.MAX_FETCH_BYTES + 1)
        backend = RecordingBackend(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        factory = public_http.PublicHTTPTransport
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8")), patch.object(
            service, "PublicHTTPTransport", side_effect=lambda *args: factory(*args, network_backend=backend)
        ):
            with self.assertRaises(HTTPException) as error:
                await service.safe_fetch("https://example.com/")
        self.assertEqual(413, error.exception.status_code)
        self.assertTrue(backend.stream.closed)

    async def test_core_network_errors_remain_httpx_errors(self):
        backend = RecordingBackend()
        backend.failures.add("8.8.8.8")
        with patch.object(public_http.socket, "getaddrinfo", return_value=records("8.8.8.8")):
            async with httpx.AsyncClient(transport=public_http.PublicHTTPTransport(["example.com"], network_backend=backend), trust_env=False) as client:
                with self.assertRaises(httpx.ConnectError):
                    await client.get("https://example.com/")

    async def test_whatsapp_media_rebinding_is_rejected_before_connecting(self):
        from app.modules.chat import router as chat_router
        backend = RecordingBackend()
        factory = public_http.PublicHTTPTransport
        with patch.object(public_http.socket, "getaddrinfo", side_effect=[records("8.8.8.8"), records("127.0.0.1")]), patch.object(
            chat_router, "PublicHTTPTransport", side_effect=lambda *args: factory(*args, network_backend=backend)
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.fetch_external_whatsapp_media("https://api.w-api.app/media/image.jpeg")
        self.assertEqual(400, error.exception.status_code)
        self.assertEqual([], backend.calls)

    async def test_whatsapp_media_uses_pinned_connection_and_keeps_binary_limits(self):
        from app.modules.chat import router as chat_router
        backend = RecordingBackend(b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 2\r\n\r\nok")
        factory = public_http.PublicHTTPTransport
        with tempfile.TemporaryDirectory() as directory, patch.object(chat_router, "REMOTE_MEDIA_TEMP_DIR", Path(directory)), patch.object(
            public_http.socket, "getaddrinfo", return_value=records("8.8.8.8")
        ), patch.object(chat_router, "PublicHTTPTransport", side_effect=lambda *args: factory(*args, network_backend=backend)):
            artifact = await chat_router.fetch_external_whatsapp_media("https://api.w-api.app/media/image.jpeg")
            self.assertEqual(b"ok", artifact.path.read_bytes())
            self.assertEqual(2, artifact.size)
            self.assertEqual("image/jpeg", artifact.mime_type)
        self.assertEqual(["8.8.8.8"], [call[0] for call in backend.calls])
        self.assertEqual("api.w-api.app", backend.stream.tls[0][1])
        self.assertTrue(backend.stream.closed)


if __name__ == "__main__":
    unittest.main()
