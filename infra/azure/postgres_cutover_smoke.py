"""Production smoke for PostgreSQL readiness and protected business routes.

Exercise authenticated reads when a dedicated smoke account is configured.
Otherwise verify that all protected routes respond promptly and deny anonymous
access; never fabricate credentials or create a test account in production.
"""
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
        email = os.getenv("NORIUM_SMOKE_EMAIL", "").strip()
        password = os.getenv("NORIUM_SMOKE_PASSWORD", "")
        if bool(email) != bool(password):
            raise RuntimeError("incomplete authenticated smoke configuration")
        headers = {}
        if email:
            login = await client.post(base + "/api/auth/login", json={"email": email, "password": password})
            login.raise_for_status()
            token = login.json().get("token")
            if not token:
                raise RuntimeError("authenticated smoke token missing")
            headers = {"Authorization": "Bearer " + token}
        for path in ("/api/scheduling/services", "/api/scheduling/availability", "/api/scheduling/pages",
                     "/api/scheduling/bookings", "/api/automacoes"):
            response = await client.get(base + path, headers=headers)
            if email:
                response.raise_for_status()
            elif response.status_code != 401:
                raise RuntimeError(f"protected route did not reject anonymous access: {path} ({response.status_code})")
    print("postgres_cutover_smoke_passed", "authenticated=true" if email else "authenticated=false")


if __name__ == "__main__":
    asyncio.run(verify())
