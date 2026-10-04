"""Per-run HTTPS CONNECT proxy with public numeric-IP connections.

TLS stays end-to-end between Chromium and the original host. No interception,
certificate bypass, ambient proxy or second hostname resolution is introduced.
This is application egress enforcement; it does not replace OS isolation.
"""
from __future__ import annotations

import asyncio
import base64
import os
import secrets
from contextlib import suppress

from fastapi import HTTPException

from app.infrastructure.public_http import PublicNetworkBackend, validate_public_url

MAX_CONNECTIONS = 32
MAX_TRAFFIC_BYTES = 128 * 1024 * 1024
MAX_TUNNEL_SECONDS = 20 * 60


def chromium_launch_options() -> dict:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise HTTPException(503, "O navegador exige execução sem privilégios de root.")
    return {"channel": "chromium", "headless": True, "chromium_sandbox": True, "args": [
        "--disable-dev-shm-usage", "--disable-quic", "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable",
    ]}


class BrowserEgress:
    def __init__(self, allowed_domains: list[str], blocked_domains: list[str], *, backend=None):
        if not allowed_domains:
            raise HTTPException(403, "Defina os domínios autorizados do perfil, incluindo seus recursos externos.")
        self.allowed, self.blocked = list(allowed_domains), list(blocked_domains)
        self.backend = backend or PublicNetworkBackend()
        self.username, self.password = "norium", secrets.token_urlsafe(32)
        self._authorization = "Basic " + base64.b64encode(f"{self.username}:{self.password}".encode("ascii")).decode("ascii")
        self.server = None
        self.tasks: set[asyncio.Task] = set()
        self.traffic = 0
        self.closed = False

    async def start(self) -> dict:
        self.server = await asyncio.start_server(self._accept, "127.0.0.1", 0, limit=16_384)
        port = self.server.sockets[0].getsockname()[1]
        return {"server": f"http://127.0.0.1:{port}", "username": self.username, "password": self.password}

    async def close(self) -> None:
        self.closed = True
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)

    async def _reply(self, writer, status: int) -> None:
        challenge = 'Proxy-Authenticate: Basic realm="Norium"\r\n' if status == 407 else ""
        writer.write(f"HTTP/1.1 {status} Proxy\r\n{challenge}Content-Length: 0\r\nConnection: close\r\n\r\n".encode("ascii"))
        await writer.drain()

    def destination(self, header: bytes) -> str:
        if len(header) > 16_384:
            raise HTTPException(400, "proxy_header_invalid")
        try:
            lines = header.decode("ascii").split("\r\n")
            method, authority, version = lines[0].split(" ")
            pairs = [line.split(":", 1) for line in lines[1:] if line]
            if any(len(pair) != 2 for pair in pairs):
                raise ValueError
            auth = [value.strip() for key, value in pairs if key.lower() == "proxy-authorization"]
            if len(auth) != 1 or not secrets.compare_digest(auth[0], self._authorization):
                raise HTTPException(407, "proxy_authentication_required")
            if method != "CONNECT" or version not in {"HTTP/1.0", "HTTP/1.1"} or any(char in authority for char in "/?#\\"):
                raise ValueError
            if any(key.lower() == "transfer-encoding" or (key.lower() == "content-length" and value.strip() != "0") for key, value in pairs):
                raise ValueError
            if any(key.lower() == "host" and value.strip() != authority for key, value in pairs):
                raise ValueError
            from urllib.parse import urlsplit
            parsed = urlsplit("https://" + authority)
            if parsed.port != 443:
                raise ValueError
            _, host = validate_public_url("https://" + authority + "/", self.allowed, self.blocked)
            return host
        except (ValueError, UnicodeError):
            raise HTTPException(400, "proxy_destination_invalid") from None

    def _count(self, count: int) -> None:
        self.traffic += count
        if self.traffic > MAX_TRAFFIC_BYTES:
            raise HTTPException(413, "proxy_traffic_limit")

    async def _accept(self, reader, writer) -> None:
        task = asyncio.current_task()
        upstream = None
        accepted = False
        try:
            if self.closed or len(self.tasks) >= MAX_CONNECTIONS:
                await self._reply(writer, 503)
                return
            self.tasks.add(task)
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            host = self.destination(header)
            upstream = await self.backend.connect_tcp(host, 443, timeout=8)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            accepted = True

            async def upload():
                while data := await asyncio.wait_for(reader.read(65_536), timeout=60):
                    self._count(len(data))
                    await upstream.write(data, timeout=30)

            async def download():
                while data := await upstream.read(65_536, timeout=60):
                    self._count(len(data))
                    writer.write(data)
                    await asyncio.wait_for(writer.drain(), timeout=30)

            pumps = {asyncio.create_task(upload()), asyncio.create_task(download())}
            try:
                async with asyncio.timeout(MAX_TUNNEL_SECONDS):
                    done, _ = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
                    for finished in done:
                        finished.result()
            finally:
                for pump in pumps:
                    pump.cancel()
                await asyncio.gather(*pumps, return_exceptions=True)
        except HTTPException as exc:
            if not accepted:
                with suppress(Exception):
                    await self._reply(writer, exc.status_code)
        except Exception:
            if not accepted:
                with suppress(Exception):
                    await self._reply(writer, 502)
        finally:
            if upstream:
                with suppress(Exception):
                    await upstream.aclose()
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()
            self.tasks.discard(task)


class IsolatedBrowser:
    """Couple browser cleanup to proxy cleanup, including launch failures."""
    def __init__(self, browser, proxy: BrowserEgress):
        self.browser, self.proxy = browser, proxy

    def __getattr__(self, name):
        return getattr(self.browser, name)

    async def close(self) -> None:
        try:
            await self.browser.close()
        finally:
            await self.proxy.close()
