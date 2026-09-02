from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Request

from app.infrastructure.http.spa import (
    accepts_html,
    app_spa_root,
    spa_index_response,
)
from app.infrastructure.observability.diagnostics import diagnostics_snapshot
from app.infrastructure.reliability.idempotency import reliability_snapshot
from app.modules.auth.router import can_manage_system, current_user


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
    return {"status": "ok"}


@router.get("/health/browser")
async def browser_health() -> dict[str, Any]:
    """Prova fixa e cacheada de que o Chromium da revisao consegue agir."""
    global _browser_health_cache
    if _browser_health_cache is not None:
        return _browser_health_cache
    async with _browser_health_lock:
        if _browser_health_cache is None:
            from app.modules.intelligence.browser_runtime import browser_runtime_health

            _browser_health_cache = await asyncio.wait_for(browser_runtime_health(), timeout=45)
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
