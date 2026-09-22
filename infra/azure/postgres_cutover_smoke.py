"""Authenticated production smoke for PostgreSQL-backed business modules."""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

import httpx


async def verify() -> None:
    base = os.environ["AZURE_PUBLIC_URL"].rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment:
        raise ValueError("https destination required")
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        ready = await client.get(base + "/health/ready")
        ready.raise_for_status()
        payload = ready.json()
        if payload.get("checks", {}).get("persistence", {}).get("driver") != "postgresql":
            raise RuntimeError("postgresql readiness receipt missing")
        login = await client.post(base + "/api/auth/login", json={
            "email": os.environ["NORIUM_SMOKE_EMAIL"], "password": os.environ["NORIUM_SMOKE_PASSWORD"]})
        login.raise_for_status()
        token = login.json().get("token")
        if not token:
            raise RuntimeError("authenticated smoke token missing")
        headers = {"Authorization": "Bearer " + token}
        for path in ("/api/scheduling/services", "/api/scheduling/availability", "/api/scheduling/pages",
                     "/api/scheduling/bookings", "/api/automacoes"):
            response = await client.get(base + path, headers=headers)
            response.raise_for_status()
    print("postgres_cutover_smoke_passed")


if __name__ == "__main__":
    asyncio.run(verify())
