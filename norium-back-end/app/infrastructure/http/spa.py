"""Entrega opcional do frontend compilado no mesmo processo da API."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse


BACKEND_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SPA_ROOT = BACKEND_ROOT / "static"
API_PREFIXES = ("api/",)
RESERVED_PATHS = {"docs", "redoc", "openapi.json", "health"}


def spa_root() -> Path:
    configured = os.getenv("NORIUM_SPA_DIR", "").strip()
    return Path(configured) if configured else DEFAULT_SPA_ROOT


def app_spa_root(app: FastAPI) -> Path:
    configured = getattr(app.state, "norium_spa_root", None)
    return Path(configured) if configured else spa_root()


def accepts_html(request: Request) -> bool:
    return "text/html" in request.headers.get("accept", "").lower()


def spa_index_response(root: Path | None = None) -> FileResponse | None:
    index_path = (root or spa_root()).resolve() / "index.html"
    if not index_path.is_file():
        return None

    response = FileResponse(index_path)
    response.headers["Cache-Control"] = "no-store"
    return response


def configure_spa(app: FastAPI, root: Path | None = None) -> bool:
    """Registra o fallback da SPA somente quando existe um build valido."""
    static_root = (root or spa_root()).resolve()
    index_path = static_root / "index.html"
    if not index_path.is_file():
        return False
    app.state.norium_spa_root = static_root

    @app.get("/{requested_path:path}", include_in_schema=False)
    async def serve_spa(requested_path: str, request: Request) -> FileResponse:
        normalized = requested_path.strip("/")
        if normalized in RESERVED_PATHS or normalized.startswith(API_PREFIXES):
            raise HTTPException(status_code=404, detail="Recurso nao encontrado.")

        candidate = (static_root / normalized).resolve()
        try:
            candidate.relative_to(static_root)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Recurso nao encontrado.") from exc

        if candidate.is_file():
            response = FileResponse(candidate)
            if candidate.name == "env.js":
                response.headers["Cache-Control"] = "no-store"
            elif "assets" in candidate.relative_to(static_root).parts:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return response

        if not accepts_html(request):
            raise HTTPException(status_code=404, detail="Recurso nao encontrado.")

        response = spa_index_response(static_root)
        if response is None:
            raise HTTPException(status_code=404, detail="Frontend nao encontrado.")
        return response

    return True
