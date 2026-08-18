from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from app.infrastructure.http.spa import (
    accepts_html,
    app_spa_root,
    spa_index_response,
)
from app.infrastructure.observability.diagnostics import diagnostics_snapshot
from app.infrastructure.reliability.idempotency import reliability_snapshot
from app.modules.auth.router import current_user


router = APIRouter(tags=["Sistema"])


@router.get("/")
async def root(request: Request):
    if accepts_html(request):
        response = spa_index_response(app_spa_root(request.app))
        if response is not None:
            return response
    return {"status": "Online", "engine": "Norium Chat API"}


@router.get("/health")
async def health() -> dict[str, Any]:
    return diagnostics_snapshot()


@router.get("/api/system/diagnostics")
async def diagnostics(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return diagnostics_snapshot()


@router.get("/api/system/outbox")
async def outbox(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await reliability_snapshot(str(user.get("id") or "lucas123"))
