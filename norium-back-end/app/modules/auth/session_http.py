"""Same-origin cookie protocol; business routes remain Bearer-only."""
from __future__ import annotations

import os
import secrets
import time
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

from app.core.tenant import is_shared_environment
from app.infrastructure import auth_sessions as sessions

REFRESH_COOKIE = "__Host-norium-refresh"
CSRF_COOKIE = "__Host-norium-csrf"


def public_origin(request: Request) -> str:
    configured = os.getenv("BACKEND_PUBLIC_URL", "").strip()
    if not configured and is_shared_environment():
        raise HTTPException(503, "Origem pública de autenticação não configurada.")
    parsed = urlsplit(configured or str(request.base_url))
    if parsed.username or parsed.password or not parsed.hostname or parsed.query or parsed.fragment:
        raise HTTPException(503, "Origem pública de autenticação inválida.")
    if is_shared_environment() and parsed.scheme != "https":
        raise HTTPException(503, "Autenticação exige origem HTTPS.")
    return f"{parsed.scheme}://{parsed.netloc}"


def require_origin(request: Request, *, password_login: bool = False) -> None:
    origin = request.headers.get("origin")
    expected = public_origin(request)
    if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
        raise HTTPException(403, "Origem de autenticação não autorizada.")
    # Non-browser password clients cannot mount browser CSRF. They receive no
    # cookie authority from this exception: cookie restoration always requires Origin.
    if password_login and not origin and not request.headers.get("sec-fetch-site") and not request.headers.get("cookie"):
        return
    if origin != expected:
        raise HTTPException(403, "Origem de autenticação não autorizada.")


def require_csrf(request: Request, *, password_login: bool = False) -> str:
    require_origin(request, password_login=password_login)
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(415, "Autenticação exige JSON.")
    if password_login and not request.headers.get("origin") and not request.headers.get("cookie"):
        return ""
    csrf, supplied = request.cookies.get(CSRF_COOKIE, ""), request.headers.get("x-norium-csrf", "")
    if (not 40 <= len(csrf) <= 100 or not csrf.isascii() or not supplied.isascii()
            or not secrets.compare_digest(csrf, supplied)):
        raise HTTPException(403, "Proteção CSRF inválida. Atualize a página.")
    return csrf


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Vary"] = "Origin, Cookie"


def set_cookies(response: Response, row: dict, refresh: str, csrf: str | None = None) -> None:
    remaining = max(0, int(row["expires"]) - int(time.time()))
    max_age = remaining if row["persistent"] else None
    response.set_cookie(REFRESH_COOKIE, refresh, max_age=max_age, secure=True, httponly=True, samesite="lax", path="/")
    if csrf is not None:
        response.set_cookie(CSRF_COOKIE, csrf, max_age=max_age, secure=True, httponly=True, samesite="lax", path="/")
    no_store(response)


def clear_cookies(response: Response) -> None:
    for name in (REFRESH_COOKIE, CSRF_COOKIE):
        response.delete_cookie(name, path="/", secure=True, httponly=True, samesite="lax")
    no_store(response)


def session_error(error: sessions.SessionError) -> HTTPException:
    messages = {"session_limit": "Limite de sessões atingido. Encerre uma sessão existente.",
                "csrf_invalid": "Proteção CSRF inválida.",
                "refresh_rate_limit": "Aguarde alguns segundos antes de renovar a sessão.",
                "refresh_reused": "Uma credencial já usada foi apresentada. Entre novamente."}
    return HTTPException(error.status, messages.get(error.code, "Sessão encerrada ou expirada. Entre novamente."),
                         headers={"Cache-Control": "no-store", "X-Norium-Auth-Error": error.code})
