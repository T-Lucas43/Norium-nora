"""HTTP access to public networks, with DNS checked at the TCP connection.

The original URL is retained for Host, SNI and certificate verification. Only
the network backend receives a validated numeric IP, preventing DNS rebinding
between a preflight lookup and the connection. No environment proxy is used.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from contextlib import contextmanager
from time import monotonic
from typing import AsyncIterator, Iterable, Iterator
from urllib.parse import urlparse

import httpcore
import httpx
from fastapi import HTTPException


def host_matches(host: str, rule: str) -> bool:
    normalized = rule.strip().lower().lstrip(".")
    return bool(normalized and (host == normalized or host.endswith(f".{normalized}")))


def _public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return bool(address.is_global and not address.is_multicast and "%" not in value)


def validate_public_url(url: str, allowed_domains: list[str] | None = None, blocked_domains: list[str] | None = None) -> tuple[str, str]:
    try:
        parsed = urlparse(url.strip())
        host = (parsed.hostname or "").rstrip(".").lower()
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="A URL informada nao e valida.") from exc
    if parsed.scheme != "https" or not host or parsed.username is not None or parsed.password is not None:
        raise HTTPException(status_code=400, detail="Use uma URL HTTPS publica, sem credenciais embutidas.")
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise HTTPException(status_code=400, detail="Enderecos locais ou privados nao podem ser acessados.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not _public_address(host):
            raise HTTPException(status_code=400, detail="Enderecos locais ou privados nao podem ser acessados.")
    if any(host_matches(host, rule) for rule in blocked_domains or []):
        raise HTTPException(status_code=403, detail="O dominio esta bloqueado neste perfil.")
    if allowed_domains and not any(host_matches(host, rule) for rule in allowed_domains):
        raise HTTPException(status_code=403, detail="O dominio nao esta na lista permitida deste perfil.")
    if port is not None and port not in {80, 443}:
        raise HTTPException(status_code=400, detail="Somente portas web padrao sao permitidas.")
    return parsed.geturl(), host


async def resolve_public_addresses(host: str, port: int | None, timeout: float = 8) -> list[str]:
    try:
        records = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM),
            timeout=timeout,
        )
    except (OSError, TimeoutError) as exc:
        raise HTTPException(status_code=400, detail="O dominio informado nao pode ser resolvido.") from exc
    addresses: list[str] = []
    for record in records:
        address = str(record[4][0])
        if not _public_address(address):
            raise HTTPException(status_code=400, detail="O dominio resolve para uma rede local ou privada.")
        if address not in addresses:
            addresses.append(address)
    if not addresses or len(addresses) > 32:
        raise HTTPException(status_code=400, detail="O dominio nao possui uma resolucao publica valida.")
    return addresses


async def assert_public_dns(host: str) -> None:
    await resolve_public_addresses(host, None)


class PublicNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, backend: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.backend = backend if backend is not None else httpcore.AnyIOBackend()

    async def connect_tcp(self, host: str, port: int, timeout: float | None = None,
                          local_address: str | None = None,
                          socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None) -> httpcore.AsyncNetworkStream:
        if port not in {80, 443}:
            raise HTTPException(status_code=400, detail="Somente portas web padrao sao permitidas.")
        deadline = monotonic() + (timeout if timeout is not None else 8)
        addresses = await resolve_public_addresses(host, port, max(0, deadline - monotonic()))
        last_error: Exception | None = None
        for address in addresses:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise httpcore.ConnectTimeout("Public connection timed out") from last_error
            try:
                return await self.backend.connect_tcp(
                    address, port, timeout=remaining, local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        raise httpcore.ConnectError("Public connection failed") from last_error

    async def connect_unix_socket(self, path: str, timeout: float | None = None,
                                  socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None) -> httpcore.AsyncNetworkStream:
        raise HTTPException(status_code=400, detail="Sockets locais nao sao permitidos.")

    async def sleep(self, seconds: float) -> None:
        await self.backend.sleep(seconds)


@contextmanager
def _http_errors() -> Iterator[None]:
    try:
        yield
    except (httpcore.TimeoutException, httpcore.NetworkError, httpcore.ProtocolError, httpcore.UnsupportedProtocol) as exc:
        # Both public APIs expose the same concrete error names. Preserve the
        # timeout/protocol category so callers keep their current error handling.
        error = getattr(httpx, type(exc).__name__, httpx.TransportError)
        raise error(str(exc)) from exc


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, response: httpcore.Response) -> None:
        self.response = response

    async def __aiter__(self) -> AsyncIterator[bytes]:
        with _http_errors():
            async for chunk in self.response.aiter_stream():
                yield chunk

    async def aclose(self) -> None:
        with _http_errors():
            await self.response.aclose()


class PublicHTTPTransport(httpx.AsyncBaseTransport):
    def __init__(self, allowed_domains: list[str] | None = None,
                 blocked_domains: list[str] | None = None,
                 network_backend: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.allowed_domains = list(allowed_domains or [])
        self.blocked_domains = list(blocked_domains or [])
        self.pool = httpcore.AsyncConnectionPool(
            ssl_context=httpcore.default_ssl_context(),
            network_backend=PublicNetworkBackend(network_backend),
            max_connections=10, max_keepalive_connections=5,
            http1=True, http2=False, retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not self.allowed_domains:
            raise HTTPException(status_code=403, detail="Defina os dominios autorizados antes de conectar.")
        validate_public_url(str(request.url), self.allowed_domains, self.blocked_domains)
        # Do not accept an extension that overrides the original TLS hostname.
        extensions = {key: value for key, value in request.extensions.items() if key != "sni_hostname"}
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(scheme=request.url.raw_scheme, host=request.url.raw_host,
                             port=request.url.port, target=request.url.raw_path),
            headers=request.headers.raw, content=request.stream, extensions=extensions,
        )
        with _http_errors():
            response = await self.pool.handle_async_request(core_request)
        return httpx.Response(response.status, headers=response.headers,
                              stream=_ResponseStream(response), extensions=response.extensions)

    async def aclose(self) -> None:
        with _http_errors():
            await self.pool.aclose()
