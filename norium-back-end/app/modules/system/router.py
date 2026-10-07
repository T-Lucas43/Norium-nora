from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field

from app.shared.schemas import StrictModel
from app.infrastructure.release_metadata import release_snapshot

from app.infrastructure.http.spa import (
    accepts_html,
    app_spa_root,
    spa_index_response,
)
from app.infrastructure.observability.diagnostics import diagnostics_snapshot
from app.infrastructure.reliability.idempotency import reconcile_request, reliability_snapshot
from app.modules.auth.router import can_manage_system, current_user
from app.core.tenant import get_data_root


router = APIRouter(tags=["Sistema"])


class IdempotencyReconciliationPayload(StrictModel):
    """Evidencia do operador para liberar uma mutacao de resultado incerto."""

    key: str = Field(min_length=1, max_length=128)
    outcome: Literal["completed", "no_effect"]
    note: str = Field(min_length=3, max_length=320)
    statusCode: int = Field(default=200, ge=200, lt=500)


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


@router.get("/api/system/release")
async def release_identity(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return release_snapshot()


def _readiness_snapshot() -> dict[str, Any]:
    started = time.perf_counter()
    checks: dict[str, Any] = {}
    from app.infrastructure.persistence import postgres_store

    uses_postgres = postgres_store.configured() or postgres_store.required()
    from app.infrastructure import auth_sessions
    auth_sessions.readiness()
    checks["sessions"] = {"status": "ready"}
    if uses_postgres:
        checks["persistence"] = postgres_store.ping()
    else:
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
        "ready": True,
        "checks": checks,
        "latencyMs": round((time.perf_counter() - started) * 1000, 2),
    }


@router.get("/health/ready")
async def readiness() -> dict[str, Any]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(_readiness_snapshot), timeout=8)
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"status": "not_ready", "ready": False, "reason": type(exc).__name__}) from exc


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


@router.post("/api/system/idempotency/reconcile")
async def reconcile_idempotency(
    payload: IdempotencyReconciliationPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Libera retry ou replay somente apos evidencia explicita do operador.

    O namespace e o mesmo do middleware de idempotencia (por usuario), e a
    rota herda a guarda de `current_user`: sessao, workspace e permissao de
    dashboard sao revalidados. Chaves de outro tenant nunca sao encontradas.
    """
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Login necessario.")
    key = payload.key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="Informe a chave de idempotencia.")
    note = payload.note.strip()
    try:
        if payload.outcome == "no_effect":
            record = await reconcile_request(user_id, key, "no_effect", actor=user_id, note=note)
        else:
            record = await reconcile_request(
                user_id,
                key,
                "completed",
                status_code=payload.statusCode,
                payload={
                    "detail": "Resultado confirmado por conciliacao do operador.",
                    "note": note,
                },
                headers={"content-type": "application/json"},
                actor=user_id,
                note=note,
            )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Operacao de idempotencia nao encontrada.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"key": key, "status": record.get("status"), "outcome": payload.outcome, "record": record}
