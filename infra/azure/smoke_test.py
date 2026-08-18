from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
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


def signed_token(secret: str, user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": int(time.time()) + 300,
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_part = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), payload_part.encode("ascii"), hashlib.sha256).digest()
    signature_part = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    return f"{payload_part}.{signature_part}"


async def validate(base_url: str, secret: str, user_id: str, email: str) -> None:
    normalized = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        health = await client.get(f"{normalized}/health")
        health.raise_for_status()
        if not isinstance(health.json(), dict):
            raise RuntimeError("A verificacao de saude nao retornou um objeto JSON.")

        frontend = await client.get(normalized, headers={"Accept": "text/html"})
        frontend.raise_for_status()
        if "Norium" not in frontend.text:
            raise RuntimeError("O frontend publicado nao contem a identificacao do Norium.")

    websocket_base = normalized.replace("https://", "wss://").replace("http://", "ws://")
    token = signed_token(secret, user_id, email)
    websocket_url = f"{websocket_base}/api/team-chat/ws?token={quote(token)}"
    async with websockets.connect(websocket_url, open_timeout=30, close_timeout=10) as socket:
        await wait_for_message_type(socket, "CONNECTED")
        await socket.send("PING")
        await wait_for_message_type(socket, "ACK")


def main() -> None:
    parser = argparse.ArgumentParser(description="Valida frontend, API e WebSocket do Norium na Azure.")
    parser.add_argument("base_url")
    parser.add_argument("--user-id", default="lucas123")
    parser.add_argument("--email", default="tarcisiolucas43@gmail.com")
    args = parser.parse_args()

    secret = os.getenv("NORIUM_SMOKE_AUTH_SECRET", "").strip()
    if not secret:
        raise SystemExit("NORIUM_SMOKE_AUTH_SECRET nao foi informada.")
    asyncio.run(validate(args.base_url, secret, args.user_id, args.email))
    print("AZURE_SMOKE_OK")


if __name__ == "__main__":
    main()
