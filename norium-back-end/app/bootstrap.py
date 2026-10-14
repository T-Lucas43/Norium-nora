"""Compoe a aplicacao e mantem inicializacao, CORS e dominios fora do entrypoint."""

from __future__ import annotations

import json
import asyncio
from contextlib import asynccontextmanager, suppress
import logging
import os
import re
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.gzip import GZipMiddleware

from app.core.request_context import reset_request_context, set_request_context
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.security import TokenValidationError, auth_secret, decode_signed_token
from app.core.settings import settings, validate_wapi_webhook_configuration
from app.core.tenant import is_shared_environment
from app.core.log_masking import configure_log_minimization
from app.infrastructure.observability.diagnostics import record_request
from app.infrastructure.persistence.json_repository import PersistenceError
from app.infrastructure.persistence.postgres_store import PostgresStoreError
from app.infrastructure.auth_sessions import SessionError
from app.infrastructure.http.spa import configure_spa
from app.infrastructure.reliability.idempotency import (
    begin_request,
    body_digest,
    complete_request,
)
from app.services.wapi_connect import validate_wapi_test_configuration
from app.services.system_logs import record_system_log
from app.services.wapi_credentials import (
    validate_wapi_credential_encryption_configuration,
)
from app.services.oauth_credentials import validate_configuration as validate_oauth_encryption_configuration
from app.modules.auth.router import (
    assert_route_permissions,
    assert_workspace_access,
    router as auth_router,
    user_from_token,
)
from app.modules.admin_finance.router import router as admin_finance_router
from app.modules.automations.router import router as automacoes_router
from app.modules.brainstorm.router import router as brainstorm_router
from app.modules.calendar.router import integracoes_google_router, router as agenda_router
from app.modules.chat.router import router as chat_router
from app.modules.clients.router import router as clients_router
from app.modules.commercial.router import router as commercial_router
from app.modules.finance.router import router as financeiro_router
from app.modules.reports.router import router as reports_router
from app.modules.scheduling.router import public_router as scheduling_public_router, router as scheduling_router
from app.modules.inbox.router import router as inbox_router
from app.modules.intelligence.router import (
    browser_router,
    knowledge_router,
    marketplace_router,
    models_router,
)
from app.modules.auth.email_router import router as account_email_router
from app.modules.mail.router import router as gmail_router
from app.modules.message_templates.router import router as message_templates_router
from app.modules.nora.router import router as nora_router
from app.modules.operations.router import router as operations_router
from app.modules.platform.router import router as platform_router
from app.modules.profile.router import router as perfil_router
from app.modules.public_site.router import router as public_site_router
from app.modules.privacy.router import data_lifecycle_worker, router as privacy_router
from app.modules.tasks.router import router as tarefas_router
from app.modules.team.router import (
    router as team_chat_router,
    start_recording_maintenance,
    stop_recording_maintenance,
)
from app.modules.team.studio_router import router as call_studio_router
from app.modules.team.meeting_router import router as call_meeting_router
from app.modules.team.turn_credentials import validate_turn_configuration
from app.modules.team.call_configuration import validate_team_call_configuration
from app.modules.team.sfu_tokens import validate_sfu_configuration
from app.modules.system.router import router as system_router
from app.modules.workhub.router import clients_router as workhub_clients_router
from app.modules.workhub.router import router as workhub_router


LOCAL_FRONTEND_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:4180",
    "http://127.0.0.1:4180",
)


def validate_runtime_topology() -> None:
    """JSON stores and in-memory coordination require one web writer."""
    if not is_shared_environment(require_explicit=True):
        return
    try:
        workers = int(os.getenv("WEB_CONCURRENCY", "1"))
    except ValueError as exc:
        raise RuntimeError("WEB_CONCURRENCY must be an integer") from exc
    if workers != 1:
        raise RuntimeError("Norium legacy stores require WEB_CONCURRENCY=1 until the SQL migration is complete")
_WEBHOOK_SECRET_QUERY_PATTERN = re.compile(
    r"([?&]secret=)[^&#\s\"']*",
    flags=re.IGNORECASE,
)


def _redact_webhook_secret(value: object) -> object:
    if isinstance(value, str):
        return _WEBHOOK_SECRET_QUERY_PATTERN.sub(r"\1<redacted>", value)
    if isinstance(value, bytes):
        decoded = value.decode("ascii", errors="replace")
        return _WEBHOOK_SECRET_QUERY_PATTERN.sub(r"\1<redacted>", decoded).encode("ascii")
    return value


class _WebhookSecretAccessLogFilter(logging.Filter):
    """Remove o segredo da query antes de qualquer handler do access log."""

    _norium_webhook_secret_filter = True

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact_webhook_secret(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_webhook_secret(value) for value in record.args)
        elif isinstance(record.args, dict):
            record.args = {
                key: _redact_webhook_secret(value)
                for key, value in record.args.items()
            }
        return True


def configure_webhook_secret_log_redaction() -> None:
    """Instala uma redação idempotente no access logger usado pelo Uvicorn."""
    access_logger = logging.getLogger("uvicorn.access")
    if any(
        getattr(active_filter, "_norium_webhook_secret_filter", False)
        for active_filter in access_logger.filters
    ):
        return
    access_logger.addFilter(_WebhookSecretAccessLogFilter())

api_limiter = SlidingWindowRateLimiter(limit=600, window_seconds=60)
public_limiter = SlidingWindowRateLimiter(limit=120, window_seconds=60)
auth_ip_limiter = SlidingWindowRateLimiter(limit=30, window_seconds=15 * 60)
webhook_limiter = SlidingWindowRateLimiter(limit=120, window_seconds=60)
ai_limiter = SlidingWindowRateLimiter(limit=30, window_seconds=60)
# A voz ao vivo sintetiza uma requisicao por frase; um limite proprio evita cortar a fala no meio.
voice_limiter = SlidingWindowRateLimiter(limit=120, window_seconds=60)
message_limiter = SlidingWindowRateLimiter(limit=60, window_seconds=60)
admin_limiter = SlidingWindowRateLimiter(limit=60, window_seconds=60)
internal_limiter = SlidingWindowRateLimiter(limit=240, window_seconds=60)


def rate_limit_bucket(path: str) -> str:
    if path.startswith("/api/nora/brain/internal/"):
        return "internal"
    if path.startswith("/api/whatsapp/webhook"):
        return "webhook"
    if path == "/api/nora/voz":
        return "voice"
    if path.startswith(("/api/nora", "/api/brainstorm/sessions")):
        return "ai"
    if path.startswith(("/api/chat/enviar", "/api/team-chat/messages")):
        return "message"
    if path.startswith(("/api/admin", "/api/auth/admin")):
        return "admin"
    if path.startswith(("/api/auth/login", "/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/verify-email")):
        return "auth"
    if "/public/" in path or "/publico/" in path or path.startswith("/health"):
        return "public"
    return "api" if path.startswith("/api/") else "none"


async def enforce_rate_limit(path: str, key: str) -> None:
    bucket = rate_limit_bucket(path)
    limiter = {
        "api": api_limiter,
        "public": public_limiter,
        "auth": auth_ip_limiter,
        "webhook": webhook_limiter,
        "ai": ai_limiter,
        "voice": voice_limiter,
        "message": message_limiter,
        "admin": admin_limiter,
        "internal": internal_limiter,
    }.get(bucket)
    if limiter:
        await limiter.check(f"{bucket}:{key}")


async def idempotency_identity(request: Request, raw_token: str) -> str | None:
    """Autoriza replay somente depois de revalidar sessao, tenant e permissao."""
    try:
        user = await user_from_token(raw_token)
        await assert_workspace_access(user, request)
        assert_route_permissions(user, request.url.path)
    except Exception:
        return None
    return str(user.get("id") or "").strip() or None


def cors_origins() -> list[str]:
    configured = [item.strip() for item in settings.FRONTEND_URL.split(",") if item.strip()]
    vercel_origins: list[str] = []
    for variable in ("VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_BRANCH_URL", "VERCEL_URL"):
        domain = os.getenv(variable, "").strip().rstrip("/")
        if domain:
            vercel_origins.append(domain if "://" in domain else f"https://{domain}")
    local_origins = () if is_shared_environment() else LOCAL_FRONTEND_ORIGINS
    return list(dict.fromkeys((*local_origins, *configured, *vercel_origins)))


async def safe_validation_error(request: Request, exc: RequestValidationError):
    # Default validation errors include rejected input, possibly a password.
    errors = [{key: error[key] for key in ("loc", "msg", "type") if key in error} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors}, headers={"Cache-Control": "no-store"})


def create_app() -> FastAPI:
    validate_runtime_topology()
    validate_wapi_credential_encryption_configuration()
    validate_oauth_encryption_configuration()
    validate_wapi_test_configuration()
    validate_wapi_webhook_configuration()
    validate_team_call_configuration()
    validate_turn_configuration()
    validate_sfu_configuration()
    configure_webhook_secret_log_redaction()
    configure_log_minimization()
    from app.modules.team.call_observability import configure_call_logging
    configure_call_logging()
    @asynccontextmanager
    async def lifespan(_app):
        from app.services.system_email import worker
        from app.services.system_email_reminders import worker as reminder_worker
        from app.modules.automations.events import worker as automation_worker
        from app.services.gmail_incremental import worker as gmail_worker
        from app.modules.team.chat_queue import worker as team_chat_worker
        await start_recording_maintenance()
        delivery = asyncio.create_task(worker())
        reminders = asyncio.create_task(reminder_worker())
        automations = asyncio.create_task(automation_worker())
        privacy_maintenance = asyncio.create_task(data_lifecycle_worker())
        gmail_sync = asyncio.create_task(gmail_worker())
        team_chat_queue = asyncio.create_task(team_chat_worker())
        try:
            yield
        finally:
            await stop_recording_maintenance()
            delivery.cancel()
            reminders.cancel()
            automations.cancel()
            privacy_maintenance.cancel()
            gmail_sync.cancel()
            team_chat_queue.cancel()
            with suppress(asyncio.CancelledError):
                await team_chat_queue
            with suppress(asyncio.CancelledError):
                await delivery
            with suppress(asyncio.CancelledError):
                await reminders
            with suppress(asyncio.CancelledError):
                await automations
            with suppress(asyncio.CancelledError):
                await privacy_maintenance
            with suppress(asyncio.CancelledError):
                await gmail_sync

    app = FastAPI(title="Norium Engine Chat Central Unificado API", lifespan=lifespan)

    app.add_exception_handler(RequestValidationError, safe_validation_error)

    @app.exception_handler(SessionError)
    async def invalid_session(request: Request, exc: SessionError):
        from app.modules.auth.session_http import session_error
        error = session_error(exc)
        return JSONResponse(status_code=error.status_code, headers=error.headers, content={"detail": error.detail})

    @app.exception_handler(PostgresStoreError)
    @app.exception_handler(PersistenceError)
    async def persistence_unavailable(request: Request, exc: PersistenceError):
        return JSONResponse(status_code=503, headers={"Retry-After": "30"}, content={
            "code": "storage_unavailable",
            "detail": "Dados temporariamente indisponiveis. Tente novamente mais tarde.",
        })
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "X-Request-ID",
            "X-Norium-Workspace",
            "X-Call-Client-Id",
            "X-Recording-Chunk-Id",
            "X-Recording-Operation-Id",
        ],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1_000, compresslevel=5)

    @app.middleware("http")
    async def request_reliability_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        workspace_id = request.headers.get("X-Norium-Workspace") or "primary"
        context_tokens = set_request_context(request_id, workspace_id)
        started = time.perf_counter()
        response: Response | None = None
        idempotency_key = request.headers.get("Idempotency-Key", "").strip()
        method = request.method.upper()
        mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        user_id = "anonymous"
        raw_token = ""
        idempotency_user_id: str | None = None
        idempotency_lease_id: str | None = None

        authorization = request.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            raw_token = authorization.split(" ", 1)[1].strip()
            try:
                token_payload = decode_signed_token(
                    raw_token,
                    secret=auth_secret(),
                )
                user_id = str(token_payload.get("sub") or "anonymous")
            except TokenValidationError:
                pass

        try:
            if method != "OPTIONS":
                client_host = request.client.host if request.client else "unknown"
                try:
                    await enforce_rate_limit(request.url.path, user_id if user_id != "anonymous" else client_host)
                except HTTPException as exc:
                    if exc.status_code != 429:
                        raise
                    response = JSONResponse(
                        status_code=429,
                        content={"detail": exc.detail},
                        headers=exc.headers,
                    )

            if response is None and mutation and idempotency_key and raw_token and not request.url.path.startswith("/api/auth/"):
                idempotency_user_id = await idempotency_identity(request, raw_token)
            if response is None and mutation and idempotency_key and idempotency_user_id:
                body = await request.body()
                state = await begin_request(
                    idempotency_user_id,
                    idempotency_key,
                    method,
                    request.url.path,
                    body_digest(body),
                )
                if state["state"] == "conflict":
                    response = JSONResponse(
                        status_code=409,
                        content={"detail": "A chave de idempotencia ja foi usada para outra operacao."},
                    )
                elif state["state"] == "processing":
                    response = JSONResponse(
                        status_code=409,
                        content={"detail": "Esta operacao ainda esta sendo processada."},
                    )
                elif state["state"] == "uncertain":
                    response = JSONResponse(
                        status_code=409,
                        content={
                            "code": "idempotency_outcome_unknown",
                            "detail": "O resultado anterior precisa ser conciliado antes de uma nova tentativa.",
                        },
                    )
                elif state["state"] == "completed":
                    record = state["record"]
                    response = JSONResponse(
                        status_code=int(record.get("statusCode") or 200),
                        content=record.get("payload"),
                        headers={"X-Idempotency-Replayed": "true"},
                    )
                else:
                    idempotency_lease_id = str(state["record"].get("leaseId") or "")

            if response is None:
                response = await call_next(request)

            if mutation and idempotency_key and idempotency_user_id and response.headers.get("X-Idempotency-Replayed") != "true":
                body_chunks = [chunk async for chunk in response.body_iterator]
                response_body = b"".join(body_chunks)
                content_type = response.headers.get("content-type", "")
                cached_payload: object
                if "application/json" in content_type and len(response_body) <= 1_000_000:
                    try:
                        cached_payload = json.loads(response_body.decode("utf-8"))
                    except (UnicodeError, json.JSONDecodeError):
                        cached_payload = {"detail": "Resposta processada sem corpo JSON reutilizavel."}
                else:
                    cached_payload = {"detail": "Operacao concluida.", "statusCode": response.status_code}
                await complete_request(
                    idempotency_user_id,
                    idempotency_key,
                    response.status_code,
                    cached_payload,
                    {"content-type": content_type},
                    lease_id=idempotency_lease_id or "",
                )
                headers = {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in {"content-length", "content-type"}
                }
                response = Response(
                    content=response_body,
                    status_code=response.status_code,
                    headers=headers,
                    media_type=content_type.split(";", 1)[0] or None,
                    background=response.background,
                )

            duration_ms = (time.perf_counter() - started) * 1000
            response.headers["X-Request-ID"] = request_id
            response.headers["Server-Timing"] = f"app;dur={duration_ms:.2f}"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            # Camera e microfone sao recursos centrais das reunioes do Modo
            # Equipe. `camera=()` bloqueia getUserMedia antes mesmo de o
            # navegador poder mostrar o pedido de permissao ao usuario.
            response.headers["Permissions-Policy"] = (
                "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"
            )
            response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
                "script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https:; font-src 'self' data:; "
                "media-src 'self' data: blob: https:; frame-src 'self' data: blob:; "
                "connect-src 'self' https: wss:"
            )
            # Rotas de mídia definem a própria validade (ex.: foto privada por 5 min);
            # sobrescrever com no-store fazia o navegador baixar tudo de novo.
            if request.url.path.startswith("/api/") and "cache-control" not in response.headers:
                response.headers["Cache-Control"] = "no-store"
            if is_shared_environment():
                response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            record_request(request.url.path, method, response.status_code, duration_ms, request_id)
            # Leituras rápidas e bem-sucedidas ficam só nas métricas em memória; gravar
            # cada uma no banco gerava uma escrita por tela aberta ou atualização automática.
            routine_read = method in {"GET", "HEAD", "OPTIONS"} and response.status_code < 400 and duration_ms < 1500
            if request.url.path.startswith("/api/") and request.url.path != "/api/auth/admin/system-logs" and not routine_read:
                await asyncio.to_thread(
                    record_system_log,
                    "http_request",
                    level="error" if response.status_code >= 500 else "warning" if response.status_code >= 400 else "info",
                    message=f"{method} {request.url.path} · HTTP {response.status_code}",
                    user_id=user_id,
                    workspace_id=workspace_id,
                    metadata={
                        "method": method,
                        "path": request.url.path,
                        "statusCode": response.status_code,
                        "durationMs": round(duration_ms, 2),
                        "requestId": request_id,
                    },
                )
            return response
        except PersistenceError as exc:
            return await persistence_unavailable(request, exc)
        except Exception as exc:
            duration_ms = (time.perf_counter() - started) * 1000
            if request.url.path.startswith("/api/"):
                await asyncio.to_thread(
                    record_system_log,
                    "http_request_failed",
                    level="error",
                    message=f"{method} {request.url.path} · falha interna",
                    user_id=user_id,
                    workspace_id=workspace_id,
                    metadata={
                        "method": method,
                        "path": request.url.path,
                        "durationMs": round(duration_ms, 2),
                        "requestId": request_id,
                        "errorType": type(exc).__name__,
                    },
                )
            raise
        finally:
            reset_request_context(context_tokens)

    # A ordem é mantida para preservar a documentação e a resolução das rotas.
    app.include_router(nora_router)
    app.include_router(public_site_router)
    app.include_router(auth_router)
    app.include_router(privacy_router)
    from app.modules.auth.ai_costs_router import router as ai_costs_router
    app.include_router(ai_costs_router)
    app.include_router(account_email_router)
    app.include_router(admin_finance_router)
    app.include_router(agenda_router)
    app.include_router(scheduling_router)
    app.include_router(scheduling_public_router)
    app.include_router(integracoes_google_router)
    app.include_router(gmail_router)
    app.include_router(message_templates_router)
    app.include_router(inbox_router)
    app.include_router(operations_router)
    app.include_router(workhub_router)
    app.include_router(clients_router)
    app.include_router(workhub_clients_router)
    app.include_router(commercial_router)
    app.include_router(perfil_router)
    app.include_router(tarefas_router)
    app.include_router(financeiro_router)
    app.include_router(reports_router)
    app.include_router(automacoes_router)
    app.include_router(browser_router)
    app.include_router(knowledge_router)
    app.include_router(marketplace_router)
    app.include_router(models_router)
    app.include_router(team_chat_router)
    app.include_router(call_studio_router)
    app.include_router(call_meeting_router)
    app.include_router(brainstorm_router)
    app.include_router(chat_router)
    app.include_router(system_router)
    app.include_router(platform_router)
    configure_spa(app)
    return app
