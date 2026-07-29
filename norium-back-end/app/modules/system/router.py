from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.infrastructure.observability.diagnostics import diagnostics_snapshot
from app.infrastructure.reliability.idempotency import reliability_snapshot
from app.modules.auth.router import current_user


router = APIRouter(tags=["Sistema"])


@router.get("/health")
async def health() -> dict[str, Any]:
    return diagnostics_snapshot()


@router.get("/api/system/diagnostics")
async def diagnostics(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return diagnostics_snapshot()


@router.get("/api/system/outbox")
async def outbox(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await reliability_snapshot(str(user.get("id") or "lucas123"))
