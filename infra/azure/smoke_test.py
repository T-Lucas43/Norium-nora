from __future__ import annotations

import argparse
import asyncio
import json
import os
from urllib.parse import quote

import httpx
import websockets


async def wait_for_message_type(socket: websockets.ClientConnection, expected: str, timeout: float = 15) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise RuntimeError(f"WebSocket nao enviou a mensagem {expected} no prazo esperado.")
        message = json.loads(await asyncio.wait_for(socket.recv(), timeout=remaining))
        if message.get("type") == expected:
            return message


async def validate(base_url: str, email: str, password: str) -> None:
    normalized = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        health = await client.get(f"{normalized}/health")
        health.raise_for_status()
        if health.json() != {"status": "ok"}:
            raise RuntimeError("A verificacao de saude retornou um payload inesperado.")

        frontend = await client.get(normalized, headers={"Accept": "text/html"})
        frontend.raise_for_status()
        if "Norium" not in frontend.text:
            raise RuntimeError("O frontend publicado nao contem a identificacao do Norium.")

        login = await client.post(
            f"{normalized}/api/auth/login",
            json={"email": email, "password": password},
        )
        login.raise_for_status()
        token = str(login.json().get("token") or "").strip()
        if not token:
            raise RuntimeError("O login de smoke test nao retornou uma sessao valida.")

        ticket_response = await client.post(
            f"{normalized}/api/auth/websocket-ticket",
            headers={"Authorization": f"Bearer {token}"},
        )
        ticket_response.raise_for_status()
        ticket = str(ticket_response.json().get("ticket") or "").strip()
        if not ticket:
            raise RuntimeError("A API nao retornou um ticket WebSocket valido.")

    websocket_base = normalized.replace("https://", "wss://").replace("http://", "ws://")
    websocket_url = f"{websocket_base}/api/team-chat/ws?ticket={quote(ticket)}"
    async with websockets.connect(websocket_url, open_timeout=30, close_timeout=10) as socket:
        await wait_for_message_type(socket, "CONNECTED")
        await socket.send("PING")
        await wait_for_message_type(socket, "ACK")


def main() -> None:
    parser = argparse.ArgumentParser(description="Valida frontend, API e WebSocket do Norium na Azure.")
    parser.add_argument("base_url")
    args = parser.parse_args()

    email = os.getenv("NORIUM_SMOKE_EMAIL", "").strip()
    password = os.getenv("NORIUM_SMOKE_PASSWORD", "").strip()
    if not email or not password:
        raise SystemExit("NORIUM_SMOKE_EMAIL e NORIUM_SMOKE_PASSWORD devem ser informadas.")
    asyncio.run(validate(args.base_url, email, password))
    print("AZURE_SMOKE_OK")


if __name__ == "__main__":
    main()
