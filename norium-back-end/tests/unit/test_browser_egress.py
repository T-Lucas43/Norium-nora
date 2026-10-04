from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.infrastructure import browser_egress as egress


class BrowserEgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.backend = AsyncMock()
        self.proxy = egress.BrowserEgress(["example.test"], ["blocked.example.test"], backend=self.backend)

    def header(self, authority="example.test:443", *, method="CONNECT", auth=None):
        authorization = self.proxy._authorization if auth is None else auth
        return f"{method} {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: {authorization}\r\n\r\n".encode("ascii")

    def test_requires_explicit_domain_allowlist(self):
        with self.assertRaises(HTTPException):
            egress.BrowserEgress([], [])

    def test_connect_preserves_original_public_hostname_for_pinned_backend(self):
        self.assertEqual("example.test", self.proxy.destination(self.header()))
        self.assertEqual("cdn.example.test", self.proxy.destination(self.header("cdn.example.test:443")))

    def test_rejects_credentials_ports_local_domains_and_unlisted_hosts(self):
        for destination in ("example.test:80", "example.test:22", "127.0.0.1:443", "[::1]:443",
                            "blocked.example.test:443", "other.test:443", "example.test.evil.test:443",
                            "user@example.test:443", "example.test:443/ignored", "example.test:443?query"):
            with self.subTest(destination=destination), self.assertRaises(HTTPException):
                self.proxy.destination(self.header(destination))

    def test_proxy_authentication_and_connect_only(self):
        for header in (self.header(auth="Basic invalid"), self.header(method="GET"),
                       self.header().replace(b"\r\n\r\n", b"\r\nTransfer-Encoding: chunked\r\n\r\n"),
                       self.header().replace(b"\r\n\r\n", b"\r\nProxy-Authorization: duplicate\r\n\r\n"),
                       b"x" * 20_000):
            with self.assertRaises(HTTPException):
                self.proxy.destination(header)

    def test_sandbox_is_mandatory_and_root_has_no_fallback(self):
        with patch.object(egress.os, "geteuid", return_value=0, create=True), self.assertRaises(HTTPException):
            egress.chromium_launch_options()
        with patch.object(egress.os, "geteuid", return_value=10001, create=True):
            options = egress.chromium_launch_options()
        self.assertTrue(options["chromium_sandbox"])
        self.assertNotIn("--no-sandbox", options["args"])
        self.assertIn("--disable-quic", options["args"])
        self.assertIn("--proxy-bypass-list=<-loopback>", options["args"])

    def test_traffic_budget_is_shared_across_connections(self):
        with patch.object(egress, "MAX_TRAFFIC_BYTES", 10):
            self.proxy._count(6)
            with self.assertRaises(HTTPException):
                self.proxy._count(5)

    def test_browser_environment_does_not_inherit_backend_credentials(self):
        with patch.dict(egress.os.environ, {"HOME": "/home/synthetic", "NORIUM_AUTH_SECRET": "synthetic-auth",
                "NORIUM_DATABASE_URL": "synthetic-db", "GMAIL_CLIENT_SECRET": "synthetic-oauth", "GROQ_API_KEY": "synthetic-api"}), \
                patch.object(egress.os, "geteuid", return_value=10001, create=True):
            environment = egress.chromium_launch_options()["env"]
        self.assertEqual("/home/synthetic", environment["HOME"])
        for key in ("NORIUM_AUTH_SECRET", "NORIUM_DATABASE_URL", "GMAIL_CLIENT_SECRET", "GROQ_API_KEY"):
            self.assertNotIn(key, environment)

    async def test_rejected_connect_does_not_open_upstream(self):
        reader, writer = AsyncMock(), AsyncMock()
        writer.write = lambda _data: None
        writer.close = lambda: None
        reader.readuntil.return_value = self.header("127.0.0.1:443")
        await self.proxy._accept(reader, writer)
        self.backend.connect_tcp.assert_not_called()
        self.assertEqual(set(), self.proxy.tasks)

    async def test_tunnel_uses_backend_and_closes_upstream(self):
        reader, writer, upstream = AsyncMock(), AsyncMock(), AsyncMock()
        writer.write = lambda _data: None
        writer.close = lambda: None
        reader.readuntil.return_value = self.header()
        reader.read.return_value = b""
        upstream.read.return_value = b""
        self.backend.connect_tcp.return_value = upstream
        await self.proxy._accept(reader, writer)
        self.backend.connect_tcp.assert_awaited_once_with("example.test", 443, timeout=8)
        upstream.aclose.assert_awaited_once()

    async def test_browser_cleanup_always_closes_proxy(self):
        browser, proxy = AsyncMock(), AsyncMock()
        browser.close.side_effect = RuntimeError("synthetic close failure")
        with self.assertRaises(RuntimeError):
            await egress.IsolatedBrowser(browser, proxy).close()
        proxy.close.assert_awaited_once()
