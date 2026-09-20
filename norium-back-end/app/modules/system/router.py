from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from app.infrastructure.http.spa import (
    accepts_html,
    app_spa_root,
    spa_index_response,
)
from app.infrastructure.observability.diagnostics import diagnostics_snapshot
from app.infrastructure.reliability.idempotency import reliability_snapshot
from app.modules.auth.router import can_manage_system, current_user
from app.core.tenant import get_data_root


router = APIRouter(tags=["Sistema"])
_browser_health_lock = asyncio.Lock()
_browser_health_cache: dict[str, Any] | None = None


@router.get("/")
async def root(request: Request):
    if accepts_html(request):
        response = spa_index_response(app_spa_root(request.app))
        if response is not None:
            return response
    return {"status": "Online", "engine": "Norium Chat API"}


@router.get("/health")
async def health() -> dict[str, Any]:
    revision = os.getenv("NORIUM_RELEASE_SHA", "")
    if re.fullmatch(r"[0-9a-f]{40}", revision):
        return {"status": "ok", "revision": revision}
    return {"status": "ok"}


def _readiness_snapshot() -> dict[str, Any]:
    started = time.perf_counter()
    checks: dict[str, Any] = {}
    root = get_data_root().resolve()
    marker: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".readiness-", dir=root, delete=False) as handle:
            marker = Path(handle.name)
            handle.write(b"ready")
            handle.flush()
            os.fsync(handle.fileno())
        if marker.read_bytes() != b"ready":
            raise OSError("readiness marker mismatch")
        free_bytes = shutil.disk_usage(root).free
        minimum_free = max(1, int(os.getenv("NORIUM_READINESS_MIN_FREE_BYTES", str(64 * 1024 * 1024))))
        if free_bytes < minimum_free:
            raise OSError("persistent volume below minimum free space")
        checks["persistence"] = {"status": "ready", "freeBytes": free_bytes}
    finally:
        if marker is not None:
            marker.unlink(missing_ok=True)

    if os.getenv("NORA_BRAIN_ENABLED", "0").strip() == "1":
        from app.modules.nora.brain.repository import repository

        checks["noraBrain"] = repository().ping()
    return {
        "status": "ready",
        "checks": checks,
        "latencyMs": round((time.perf_counter() - started) * 1000, 2),
    }


@router.get("/health/ready")
async def readiness() -> dict[str, Any]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(_readiness_snapshot), timeout=8)
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"status": "not_ready", "reason": type(exc).__name__}) from exc


@router.get("/health/browser")
async def browser_health() -> dict[str, Any]:
    """Prova fixa e cacheada de que o Chromium da revisao consegue agir."""
    global _browser_health_cache
    if _browser_health_cache is not None:
        return _browser_health_cache
    async with _browser_health_lock:
        if _browser_health_cache is None:
            from app.modules.intelligence.browser_runtime import browser_runtime_health

            _browser_health_cache = await asyncio.wait_for(browser_runtime_health(), timeout=20)
    return _browser_health_cache


@router.get("/api/system/diagnostics")
async def diagnostics(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_system(user):
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Diagnosticos restritos ao administrador do sistema.")
    return diagnostics_snapshot()


@router.get("/api/system/outbox")
async def outbox(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await reliability_snapshot(str(user.get("id") or "lucas123"))
