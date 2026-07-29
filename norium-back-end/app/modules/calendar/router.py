"""Dominio de agenda extraido sem modificar contratos do Google Calendar."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.inbox_router import record_event
from app.routers.auth_router import current_user
from app.services.agenda_agent import AgendaAgent
from app.services.calendar_service import CalendarConfigError, CalendarService

router = APIRouter(prefix="/api/agenda", tags=["Agenda"])
integracoes_google_router = APIRouter(prefix="/api/integracoes/google", tags=["Agenda"])
agenda_agent = AgendaAgent()


class CriarEventoPayload(StrictModel):
    user_id: str = "lucas123"
    titulo: str = Field(min_length=1)
    inicio: str = Field(min_length=1)
    fim: str = Field(min_length=1)
    descricao: str = ""
    local: str = ""
    participantes: list[str] = []
    criar_meet: bool = False


class AtualizarEventoPayload(StrictModel):
    user_id: str = "lucas123"
    titulo: str | None = None
    inicio: str | None = None
    fim: str | None = None
    descricao: str | None = None
    local: str | None = None
    participantes: list[str] | None = None
    criar_meet: bool | None = None


class AgendaAgentPayload(StrictModel):
    user_id: str = "lucas123"
    session_id: str | None = None
    message: str = Field(min_length=1)


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def _parse_event_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{value}T00:00:00-03:00")
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone(timedelta(hours=-3)))


async def _record_calendar_events(eventos: list[dict[str, Any]], user_id: str) -> None:
    now = datetime.now(timezone.utc)
    upcoming = []
    for evento in eventos:
        if evento.get("source") != "google":
            continue
        inicio_dt = _parse_event_datetime(evento.get("inicio"))
        if inicio_dt and inicio_dt < now - timedelta(hours=2):
            continue
        upcoming.append(evento)

    for evento in upcoming[:20]:
        event_id = str(evento.get("id") or "")
        if not event_id:
            continue
        titulo = str(evento.get("titulo") or "Compromisso sem titulo")
        inicio = str(evento.get("inicio") or "")
        participantes = evento.get("participantes") if isinstance(evento.get("participantes"), list) else []
        await record_event(
            source="calendar",
            title="Compromisso no Google Agenda",
            description=f"{titulo} - {inicio}",
            metadata={
                "eventId": event_id,
                "userId": user_id,
                "inicio": evento.get("inicio"),
                "fim": evento.get("fim"),
                "calendar": evento.get("calendar"),
                "htmlLink": evento.get("htmlLink"),
                "participantes": participantes,
                "synced": True,
            },
            event_id=f"calendar_google_{user_id}_{event_id}",
        )


@router.get("/status")
async def obter_status(user: dict[str, Any] = Depends(current_user)):
    return CalendarService(tenant_id(user)).status()


@router.get("/auth-url")
async def obter_url_autorizacao(user: dict[str, Any] = Depends(current_user)):
    try:
        return CalendarService(tenant_id(user)).authorization_url()
    except CalendarConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def oauth_failure_html(exc: Exception) -> HTMLResponse:
    return HTMLResponse(
        f"""
        <html>
          <body style="font-family:system-ui;background:#0B1220;color:white;padding:32px">
            <h1>Falha ao conectar o Google Agenda</h1>
            <p>{str(exc)}</p>
          </body>
        </html>
        """,
        status_code=400,
    )


def oauth_success_html() -> str:
    return """
    <html>
      <body style="font-family:system-ui;background:#0B1220;color:white;padding:32px">
        <h1>Google Agenda conectado</h1>
        <p>Voce ja pode voltar para o Norium. A agenda sera sincronizada automaticamente.</p>
        <script>setTimeout(() => window.close(), 1200)</script>
      </body>
    </html>
    """


def finish_google_oauth(code: str, state: str | None, user_id: str) -> str | HTMLResponse:
    resolved_user_id = CalendarService.user_id_from_state(state) or user_id
    try:
        CalendarService(resolved_user_id).finish_oauth(code=code, state=state)
    except Exception as exc:
        return oauth_failure_html(exc)
    return oauth_success_html()


@router.get("/oauth2callback", response_class=HTMLResponse)
async def finalizar_oauth(
    code: str = Query(...),
    state: str | None = Query(default=None),
    user_id: str = "lucas123",
):
    return finish_google_oauth(code, state, user_id)


@integracoes_google_router.get("/callback", response_class=HTMLResponse)
async def finalizar_oauth_integracoes(
    code: str = Query(...),
    state: str | None = Query(default=None),
    user_id: str = "lucas123",
):
    return finish_google_oauth(code, state, user_id)


@router.get("/eventos")
async def listar_eventos(
    user_id: str = "lucas123",
    time_min: str | None = None,
    time_max: str | None = None,
    q: str | None = None,
    max_results: int = Query(default=2500, ge=1, le=2500),
    user: dict[str, Any] = Depends(current_user),
):
    resolved_user_id = tenant_id(user)
    if not time_min:
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(days=31)).isoformat()
    if not time_max:
        time_max = (datetime.now(timezone.utc) + timedelta(days=400)).isoformat()
    try:
        result = CalendarService(resolved_user_id).list_events(
            time_min=time_min,
            time_max=time_max,
            query=q,
            max_results=max_results,
        )
        await _record_calendar_events(result.get("eventos", []), resolved_user_id)
        return result
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao sincronizar agenda: {str(exc)}") from exc


@router.post("/eventos")
async def criar_evento(payload: CriarEventoPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        result = CalendarService(resolved_user_id).create_event(
            titulo=payload.titulo,
            inicio=payload.inicio,
            fim=payload.fim,
            descricao=payload.descricao,
            local=payload.local,
            participantes=payload.participantes,
            criar_meet=payload.criar_meet,
        )
        evento = result.get("evento", {})
        await record_event(
            source="calendar",
            title="Compromisso criado",
            description=payload.titulo,
            metadata={
                "eventId": evento.get("id"),
                "userId": resolved_user_id,
                "inicio": payload.inicio,
                "fim": payload.fim,
                "participantes": payload.participantes,
            },
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao criar evento: {str(exc)}") from exc


@router.patch("/eventos/{event_id}")
async def atualizar_evento(event_id: str, payload: AtualizarEventoPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        resolved_user_id = tenant_id(user)
        updates = {key: getattr(payload, key) for key in payload.model_fields_set if key != "user_id"}
        result = CalendarService(resolved_user_id).update_event(event_id, updates)
        evento = result.get("evento", {})
        await record_event(
            source="calendar",
            title="Compromisso atualizado",
            description=str(evento.get("titulo") or payload.titulo or event_id),
            metadata={
                "eventId": evento.get("id") or event_id,
                "userId": resolved_user_id,
                "inicio": evento.get("inicio") or payload.inicio,
                "fim": evento.get("fim") or payload.fim,
                "updates": updates,
            },
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao atualizar evento: {str(exc)}") from exc


@router.post("/sync")
async def sincronizar_agenda(user_id: str = "lucas123", payload: dict[str, Any] | None = None, user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    now = datetime.now(timezone.utc)
    result = CalendarService(resolved_user_id).list_events(
        time_min=(now - timedelta(days=31)).isoformat(),
        time_max=(now + timedelta(days=400)).isoformat(),
    )
    await _record_calendar_events(result.get("eventos", []), resolved_user_id)
    return result


@router.post("/agente/mensagem")
async def conversar_com_agente_agenda(payload: AgendaAgentPayload, user: dict[str, Any] = Depends(current_user)):
    try:
        return agenda_agent.handle(
            message=payload.message,
            session_id=payload.session_id,
            user_id=tenant_id(user),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Agente de agenda falhou: {str(exc)}") from exc
