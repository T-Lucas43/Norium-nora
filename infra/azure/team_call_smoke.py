"""Production smoke confined to two pre-provisioned accounts in a test team.

Validates deployed HTTP/WebSocket lifecycle, not production RTP. The independent
external TURN/TLS media gate must pass before publication. Never logs credentials,
payloads, user/team IDs, SDP, addresses or raw exception messages.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import AsyncExitStack
import json
import os
import re
import secrets
import time
from urllib.parse import quote, urlsplit

import httpx
import websockets


async def receive(socket, kind: str, call_id: str = "", event: str = "") -> dict:
    async with asyncio.timeout(15):
        while True:
            payload = json.loads(await socket.recv())
            if payload.get("type") == "CALL_ERROR":
                raise RuntimeError("call_protocol_error")
            if (payload.get("type") == kind and (not call_id or payload.get("callId") == call_id)
                and (not event or payload.get("event") == event)):
                return payload


async def verify_revision(client: httpx.AsyncClient, base: str, expected_revision: str) -> None:
    response = await client.get(base + "/health")
    response.raise_for_status()
    health = response.json()
    if not isinstance(health, dict) or health.get("revision") != expected_revision:
        raise RuntimeError("production_revision_mismatch")


async def wait_for_revision(base_url: str, expected_revision: str, timeout: float = 180) -> None:
    """Wait for ingress cutover; never accept a healthy but outdated revision."""
    if not re.fullmatch(r"[0-9a-f]{40}", expected_revision):
        raise ValueError("expected_revision_required")
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("https_destination_required")
    try:
        async with asyncio.timeout(timeout), httpx.AsyncClient(timeout=15, follow_redirects=False, headers={"Cache-Control": "no-cache"}) as client:
            while True:
                try:
                    await verify_revision(client, base_url.rstrip("/"), expected_revision)
                    return
                except RuntimeError as error:
                    if str(error) != "production_revision_mismatch":
                        raise
                except httpx.HTTPStatusError as error:
                    if error.response.status_code < 500:
                        raise
                except httpx.TransportError:
                    pass
                await asyncio.sleep(3)
    except TimeoutError as error:
        raise RuntimeError("production_revision_not_ready") from error


async def validate_ready_deployment(base_url: str, expected_revision: str, internal_test: bool) -> dict:
    await wait_for_revision(base_url, expected_revision)
    validate_profile = validate_internal if internal_test else validate
    return await validate_profile(base_url, expected_revision)


async def validate(base_url: str, expected_revision: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", expected_revision):
        raise ValueError("expected_revision_required")
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or parsed.username or parsed.query or not parsed.hostname:
        raise ValueError("https_destination_required")
    required = ("NORIUM_SMOKE_EMAIL", "NORIUM_SMOKE_PASSWORD", "NORIUM_SMOKE_PEER_EMAIL",
                "NORIUM_SMOKE_PEER_PASSWORD", "TEAM_CALL_SMOKE_TEAM_ID", "TEAM_CALL_METRICS_TOKEN")
    if any(not os.getenv(name) for name in required):
        raise ValueError("smoke_configuration_missing")
    started = time.monotonic()
    base = base_url.rstrip("/")
    call_id = "call_" + secrets.token_hex(16)
    accounts = []
    admitted = False
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client, AsyncExitStack() as stack:
        await verify_revision(client, base, expected_revision)
        response = await client.get(base + "/")
        response.raise_for_status()
        for prefix in ("NORIUM_SMOKE", "NORIUM_SMOKE_PEER"):
            response = await client.post(base + "/api/auth/login", json={
                "email": os.environ[prefix + "_EMAIL"], "password": os.environ[prefix + "_PASSWORD"]})
            response.raise_for_status()
            account = response.json()
            user = account["user"]
            if str(user.get("teamOwnerId") or user["id"]) != os.environ["TEAM_CALL_SMOKE_TEAM_ID"]:
                raise RuntimeError("smoke_team_mismatch")
            account["headers"] = {"Authorization": "Bearer " + account["token"]}
            account["clientId"] = secrets.token_hex(16)
            accounts.append(account)
        if accounts[0]["user"]["id"] == accounts[1]["user"]["id"]:
            raise RuntimeError("independent_accounts_required")
        for account in accounts:
            config = await client.get(base + "/api/team-chat/calls/configuration", headers=account["headers"])
            config.raise_for_status()
            if config.json().get("newCallsEnabled") is not True or config.json().get("recordingEnabled") is not False:
                raise RuntimeError("unexpected_rollout_configuration")
            ice = await client.get(base + "/api/team-chat/calls/ice-servers", headers=account["headers"])
            ice.raise_for_status()
            if "no-store" not in ice.headers.get("cache-control", ""):
                raise RuntimeError("credential_cache_policy_failed")
            ticket = await client.post(base + "/api/auth/websocket-ticket", headers=account["headers"])
            ticket.raise_for_status()
            socket_url = base.replace("https://", "wss://", 1) + "/api/team-chat/ws?ticket=" + quote(ticket.json()["ticket"])
            account["socket"] = await stack.enter_async_context(websockets.connect(socket_url, open_timeout=15, close_timeout=5))
            await receive(account["socket"], "CONNECTED")
        host, peer = accounts
        try:
            await host["socket"].send(json.dumps({"type": "CALL_INVITE", "callId": call_id,
                "clientId": host["clientId"], "scope": "direct", "recipientId": peer["user"]["id"]}))
            admitted = True  # Cleanup also covers a lost admission ACK.
            await receive(host["socket"], "CALL_ACK", call_id, "CALL_INVITE")
            await receive(peer["socket"], "CALL_INVITE", call_id)
            await peer["socket"].send(json.dumps({"type": "CALL_ACCEPT", "callId": call_id, "clientId": peer["clientId"]}))
            await receive(peer["socket"], "CALL_ACK", call_id, "CALL_ACCEPT")
            for account in accounts:
                await account["socket"].send(json.dumps({"type": "CALL_HEARTBEAT", "callId": call_id,
                    "clientId": account["clientId"]}))
                await receive(account["socket"], "CALL_ACK", call_id, "CALL_HEARTBEAT")
            denied = await client.delete(base + "/api/team-chat/calls/" + call_id, headers=peer["headers"])
            if denied.status_code != 403:
                raise RuntimeError("host_authorization_failed")
            metric_path = base + "/api/team-chat/calls/metrics"
            if (await client.get(metric_path)).status_code != 404:
                raise RuntimeError("metrics_auth_failed")
            metrics = await client.get(metric_path, headers={"Authorization": "Bearer " + os.environ["TEAM_CALL_METRICS_TOKEN"]})
            metrics.raise_for_status()
            if "team_call_join_admitted_total" not in metrics.text:
                raise RuntimeError("metrics_missing")
        finally:
            if admitted:
                ended = await client.delete(base + "/api/team-chat/calls/" + call_id, headers=host["headers"])
                ended.raise_for_status()
        for account in accounts:
            response = await client.get(base + "/api/team-chat/calls/active", headers=account["headers"])
            response.raise_for_status()
            if any(item.get("callId") == call_id for item in response.json()["calls"]):
                raise RuntimeError("call_cleanup_failed")
        await verify_revision(client, base, expected_revision)
    return {"status": "passed", "revision": expected_revision, "durationSeconds": round(time.monotonic() - started, 3),
            "checks": ["https", "expected_revision", "frontend", "two_authenticated_sessions", "dedicated_team", "rollout",
                       "ephemeral_ice_no_store", "invite_accept_heartbeat", "host_authorization",
                       "protected_metrics", "call_cleanup"], "productionRtpValidated": False}


async def validate_internal(base_url: str, expected_revision: str) -> dict:
    """Authorized internal-test profile: prove deployment, not call connectivity."""
    if not re.fullmatch(r"[0-9a-f]{40}", expected_revision):
        raise ValueError("expected_revision_required")
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("https_destination_required")
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        await verify_revision(client, base, expected_revision)
        page = await client.get(base + "/", headers={"Accept": "text/html"})
        page.raise_for_status()
        if "text/html" not in page.headers.get("content-type", ""):
            raise RuntimeError("frontend_missing")
        for path in ("/calls/active", "/calls/configuration", "/calls/ice-servers"):
            if (await client.get(base + "/api/team-chat" + path)).status_code not in {401, 403}:
                raise RuntimeError("call_authentication_failed")
        if (await client.get(base + "/api/team-chat/calls/metrics")).status_code != 404:
            raise RuntimeError("metrics_not_private")
    return {"status": "passed", "releaseProfile": "internal-test", "revision": expected_revision,
            "checks": ["https", "expected_revision", "frontend", "call_authentication", "private_metrics"],
            "deferred": ["external_turn_tls", "external_metrics_alerts", "dedicated_two_account_smoke"],
            "productionRtpValidated": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url")
    parser.add_argument("--expected-revision", required=True, help="Immutable commit SHA expected at the production URL")
    parser.add_argument("--internal-test", action="store_true")
    args = parser.parse_args()
    try:
        result = asyncio.run(validate_ready_deployment(args.base_url, args.expected_revision, args.internal_test))
    except Exception as error:
        # Exception text from HTTP/WebSocket libraries can include a ticket URL.
        print(json.dumps({"status": "failed", "errorType": type(error).__name__}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
