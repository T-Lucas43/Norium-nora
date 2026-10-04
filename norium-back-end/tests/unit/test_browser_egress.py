from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from app.infrastructure import browser_egress as egress


class BrowserEgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        channel = patch.dict(egress.os.environ, {"NORIUM_BROWSER_CHANNEL": "chromium"})
        channel.start()
        self.addCleanup(channel.stop)
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

    def test_default_channel_remains_chromium(self):
        with patch.dict(egress.os.environ, {}, clear=True), \
                patch.object(egress.os, "geteuid", return_value=10001, create=True):
            options = egress.chromium_launch_options()
        self.assertEqual("chromium", options["channel"])
        self.assertNotIn("executable_path", options)

    def test_unapproved_channels_fail_closed(self):
        for channel in ("chrome-beta", "chrome-dev", "Chrome", "chrome ", "", "../chrome"):
            with self.subTest(channel=channel), \
                    patch.dict(egress.os.environ, {"NORIUM_BROWSER_CHANNEL": channel}), \
                    patch.object(egress.os, "geteuid", return_value=10001, create=True), \
                    self.assertRaises(HTTPException) as rejected:
                egress.chromium_launch_options()
            self.assertEqual(503, rejected.exception.status_code)

    def test_chrome_uses_fixed_executable_and_preserves_every_guard(self):
        with patch.dict(egress.os.environ, {"NORIUM_BROWSER_CHANNEL": "chrome", "NORIUM_AUTH_SECRET": "synthetic"}), \
                patch.object(egress.os, "geteuid", return_value=10001, create=True), \
                patch.object(egress.Path, "is_file", return_value=True), \
                patch.object(egress.os, "access", return_value=True) as access:
            options = egress.chromium_launch_options()
        self.assertEqual("chrome", options["channel"])
        self.assertEqual("/opt/google/chrome/chrome", options["executable_path"])
        access.assert_called_once_with(egress.CHROME_EXECUTABLE, egress.os.X_OK)
        self.assertTrue(options["headless"])
        self.assertTrue(options["chromium_sandbox"])
        self.assertEqual(["--disable-dev-shm-usage", "--disable-quic", "--proxy-bypass-list=<-loopback>",
                          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable"], options["args"])
        self.assertNotIn("NORIUM_AUTH_SECRET", options["env"])
        self.assertNotIn("NORIUM_BROWSER_CHANNEL", options["env"])

    def test_missing_or_nonexecutable_chrome_has_no_bundled_fallback(self):
        for exists, executable in ((False, True), (True, False)):
            with self.subTest(exists=exists, executable=executable), \
                    patch.dict(egress.os.environ, {"NORIUM_BROWSER_CHANNEL": "chrome"}), \
                    patch.object(egress.os, "geteuid", return_value=10001, create=True), \
                    patch.object(egress.Path, "is_file", return_value=exists), \
                    patch.object(egress.os, "access", return_value=executable), \
                    self.assertRaises(HTTPException) as rejected:
                egress.chromium_launch_options()
            self.assertEqual(503, rejected.exception.status_code)

    def test_selected_chrome_inventory_does_not_resolve_the_bundled_binary(self):
        class UnusedBundle:
            @property
            def executable_path(self):
                raise AssertionError("The unselected bundle must not be inventoried")

        with patch.dict(egress.os.environ, {"NORIUM_BROWSER_CHANNEL": "chrome"}), \
                patch.object(egress.os, "geteuid", return_value=10001, create=True), \
                patch.object(egress.Path, "is_file", return_value=True), \
                patch.object(egress.os, "access", return_value=True):
            self.assertEqual(egress.CHROME_EXECUTABLE, egress.browser_executable_path(UnusedBundle()))

    def test_bundled_inventory_requires_an_executable_file(self):
        browser_type = Mock(executable_path="/synthetic/chromium")
        with patch.object(egress.os, "geteuid", return_value=10001, create=True), \
                patch.object(egress.Path, "is_file", return_value=True), \
                patch.object(egress.os, "access", return_value=False), self.assertRaises(HTTPException):
            egress.browser_executable_path(browser_type)

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
