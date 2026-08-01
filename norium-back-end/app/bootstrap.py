"""Compoe a aplicacao e mantem inicializacao, CORS e dominios fora do entrypoint."""

from __future__ import annotations

import json
import time
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse, Response

from app.core.request_context import reset_request_context, set_request_context
from app.core.security import TokenValidationError, auth_secret, decode_signed_token
from app.core.settings import settings
from app.infrastructure.observability.diagnostics import record_request
from app.infrastructure.reliability.idempotency import (
    begin_request,
    body_digest,
    complete_request,
)
from app.modules.auth.router import router as auth_router
from app.modules.admin_finance.router import router as admin_finance_router
from app.modules.automations.router import router as automacoes_router
from app.modules.brainstorm.router import router as brainstorm_router
from app.modules.calendar.router import integracoes_google_router, router as agenda_router
from app.modules.chat.router import router as chat_router
from app.modules.clients.router import router as clients_router
from app.modules.commercial.router import router as commercial_router
from app.modules.finance.router import router as financeiro_router
from app.modules.inbox.router import router as inbox_router
from app.modules.mail.router import router as gmail_router
from app.modules.nora.router import router as nora_router
from app.modules.operations.router import router as operations_router
from app.modules.platform.router import router as platform_router
from app.modules.profile.router import router as perfil_router
from app.modules.tasks.router import router as tarefas_router
from app.modules.team.router import router as team_chat_router
from app.modules.system.router import router as system_router
from app.modules.workhub.router import clients_router as workhub_clients_router
from app.modules.workhub.router import router as workhub_router


LOCAL_FRONTEND_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)


def cors_origins() -> list[str]:
    configured = [item.strip() for item in settings.FRONTEND_URL.split(",") if item.strip()]
    return list(dict.fromkeys((*LOCAL_FRONTEND_ORIGINS, *configured)))


def create_app() -> FastAPI:
    app = FastAPI(title="Norium Engine Chat Central Unificado API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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

        authorization = request.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            try:
                token_payload = decode_signed_token(
                    authorization.split(" ", 1)[1].strip(),
                    secret=auth_secret(),
                )
                user_id = str(token_payload.get("sub") or "anonymous")
            except TokenValidationError:
                pass

        try:
            if mutation and idempotency_key and not request.url.path.startswith("/api/auth/"):
                body = await request.body()
                state = await begin_request(
                    user_id,
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
                elif state["state"] == "completed":
                    record = state["record"]
                    response = JSONResponse(
                        status_code=int(record.get("statusCode") or 200),
                        content=record.get("payload"),
                        headers={"X-Idempotency-Replayed": "true"},
                    )

            if response is None:
                response = await call_next(request)

            if mutation and idempotency_key and response.headers.get("X-Idempotency-Replayed") != "true":
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
                    user_id,
                    idempotency_key,
                    response.status_code,
                    cached_payload,
                    {"content-type": content_type},
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
            record_request(request.url.path, method, response.status_code, duration_ms, request_id)
            return response
        finally:
            reset_request_context(context_tokens)

    # A ordem é mantida para preservar a documentação e a resolução das rotas.
    app.include_router(nora_router)
    app.include_router(auth_router)
    app.include_router(admin_finance_router)
    app.include_router(agenda_router)
    app.include_router(integracoes_google_router)
    app.include_router(gmail_router)
    app.include_router(inbox_router)
    app.include_router(operations_router)
    app.include_router(workhub_router)
    app.include_router(clients_router)
    app.include_router(workhub_clients_router)
    app.include_router(commercial_router)
    app.include_router(perfil_router)
    app.include_router(tarefas_router)
    app.include_router(financeiro_router)
    app.include_router(automacoes_router)
    app.include_router(team_chat_router)
    app.include_router(brainstorm_router)
    app.include_router(chat_router)
    app.include_router(system_router)
    app.include_router(platform_router)
    return app
