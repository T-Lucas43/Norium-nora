from __future__ import annotations

import asyncio
from threading import Lock
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import Field

from app.core.request_context import current_workspace_id
from app.modules.auth.router import current_user, effective_permissions
from app.modules.scheduling.schemas import AvailabilityPayload, BookingPayload, CancelPayload, HoldPayload, LogoPayload, PagePayload, ReschedulePayload, ServicePayload
from app.modules.scheduling.service import SchedulingService, scope_from_user
from app.services.calendar_service import CalendarService
from app.shared.schemas import StrictModel

router = APIRouter(prefix="/api/scheduling", tags=["Agendamentos"])
public_router = APIRouter(prefix="/api/public/scheduling", tags=["Agendamentos publicos"])

_service_instance: SchedulingService | None = None
_service_lock = Lock()


def service() -> SchedulingService:
    global _service_instance
    if _service_instance is None:
        with _service_lock:
            if _service_instance is None:
                _service_instance = SchedulingService()
    return _service_instance


async def calendar_busy(owner_id: str, start_at: str, end_at: str) -> list[tuple[datetime, datetime]]:
    start = datetime.fromisoformat(start_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    end = datetime.fromisoformat(end_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    try:
        result = await asyncio.to_thread(CalendarService(owner_id).list_events, time_min=start.isoformat(), time_max=end.isoformat(), max_results=250)
    except Exception as exc:
        raise HTTPException(503, "Nao foi possivel validar conflitos do calendario conectado.") from exc
    busy: list[tuple[datetime, datetime]] = []
    for event in result.get("eventos", []):
        try:
            event_start = datetime.fromisoformat(str(event.get("inicio") or "").replace("Z", "+00:00"))
            event_end = datetime.fromisoformat(str(event.get("fim") or "").replace("Z", "+00:00"))
            if event_start.tzinfo is None: event_start = event_start.replace(tzinfo=timezone.utc)
            if event_end.tzinfo is None: event_end = event_end.replace(tzinfo=timezone.utc)
            event_start = event_start.astimezone(timezone.utc); event_end = event_end.astimezone(timezone.utc)
            if start < event_end and end > event_start: busy.append((event_start, event_end))
        except (TypeError, ValueError):
            continue
    return busy


async def calendar_conflicts(owner_id: str, start_at: str, end_at: str) -> bool:
    return bool(await calendar_busy(owner_id, start_at, end_at))


def authorized_scope(user: dict[str, Any]) -> tuple[str, str, str]:
    permissions = effective_permissions(user)
    if not (user.get("systemAdmin") or user.get("role") == "owner" or permissions.get("agenda")):
        raise HTTPException(403, "Sem permissao para gerenciar agendamentos.")
    return scope_from_user(user, current_workspace_id())


@router.get("/services")
def list_services(user: dict[str, Any] = Depends(current_user)):
    return {"services": service().list_services(authorized_scope(user))}


@router.post("/services", status_code=201)
def create_service(payload: ServicePayload, user: dict[str, Any] = Depends(current_user)):
    return service().create_service(authorized_scope(user), payload)


@router.put("/services/{service_id}")
def update_service(service_id: str, payload: ServicePayload, user: dict[str, Any] = Depends(current_user)):
    return service().update_service(authorized_scope(user), service_id, payload)


@router.get("/availability")
def get_availability(serviceId: str | None = None, user: dict[str, Any] = Depends(current_user)):
    return service().get_availability(authorized_scope(user), serviceId)


@router.put("/availability")
def set_availability(payload: AvailabilityPayload, user: dict[str, Any] = Depends(current_user)):
    return service().set_availability(authorized_scope(user), payload)


@router.get("/pages")
def list_pages(user: dict[str, Any] = Depends(current_user)):
    return {"pages": service().list_pages(authorized_scope(user))}


@router.post("/pages", status_code=201)
def create_page(payload: PagePayload, user: dict[str, Any] = Depends(current_user)):
    return service().create_page(authorized_scope(user), payload)


@router.put("/pages/{page_id}")
def update_page(page_id: str, payload: PagePayload, user: dict[str, Any] = Depends(current_user)):
    return service().update_page(authorized_scope(user), page_id, payload)


@router.delete("/pages/{page_id}", status_code=204)
def archive_page(page_id: str, user: dict[str, Any] = Depends(current_user)):
    service().archive_page(authorized_scope(user), page_id)
    return Response(status_code=204)


@router.post("/pages/{page_id}/logo")
def upload_page_logo(page_id: str, payload: LogoPayload, user: dict[str, Any] = Depends(current_user)):
    return service().upload_logo(authorized_scope(user), page_id, payload.dataBase64)


@router.get("/bookings")
def list_bookings(user: dict[str, Any] = Depends(current_user)):
    return {"bookings": service().list_bookings(authorized_scope(user))}


class BookingStatusPayload(StrictModel):
    status: str = Field(min_length=1, max_length=20)


@router.patch("/bookings/{booking_id}/status")
def update_booking_status(booking_id: str, payload: BookingStatusPayload, user: dict[str, Any] = Depends(current_user)):
    return service().update_booking_status(authorized_scope(user), booking_id, payload.status)


@public_router.get("/pages/{identifier}")
def get_public_page(identifier: str):
    return service().public_page(identifier)


@public_router.get("/pages/{identifier}/logo")
def get_public_logo(identifier: str):
    path, mime = service().logo_asset(identifier)
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})


@public_router.get("/pages/{identifier}/slots")
async def get_slots(identifier: str, day: date = Query(), duration: int = Query(ge=5, le=1440)):
    scheduling = service(); result = scheduling.available_slots(identifier, day, duration)
    owner_id = scheduling.public_page(identifier)["page"]["owner_id"]
    if result["slots"]:
        busy = await calendar_busy(owner_id, result["slots"][0]["startAt"], result["slots"][-1]["endAt"])
        result["slots"] = [slot for slot in result["slots"] if not any(datetime.fromisoformat(slot["startAt"]) < end and datetime.fromisoformat(slot["endAt"]) > start for start, end in busy)]
    return result


@public_router.post("/pages/{identifier}/holds", status_code=201)
async def create_hold(identifier: str, payload: HoldPayload):
    scheduling = service(); bundle = scheduling.public_page(identifier)
    start = datetime.fromisoformat(payload.startAt.replace("Z", "+00:00")); end = start + timedelta(minutes=payload.duration)
    if await calendar_conflicts(bundle["page"]["owner_id"], start.isoformat(), end.isoformat()): raise HTTPException(409, "Horario ocupado no calendario conectado.")
    return scheduling.create_hold(identifier, payload)


@public_router.post("/pages/{identifier}/bookings", status_code=201)
async def create_booking(identifier: str, payload: BookingPayload):
    scheduling = service()
    bundle = scheduling.public_page(identifier)
    start = datetime.fromisoformat(payload.startAt.replace("Z", "+00:00")); end = start + timedelta(minutes=payload.duration)
    if await calendar_conflicts(bundle["page"]["owner_id"], start.isoformat(), end.isoformat()): raise HTTPException(409, "Horario ocupado no calendario conectado.")
    result = scheduling.create_booking(identifier, payload)
    booking = result.get("booking", {})
    if not result.get("idempotentReplay") and booking:
        try:
            calendar_result = await asyncio.to_thread(
                CalendarService(bundle["page"]["owner_id"]).create_event,
                titulo=bundle["service"]["name"], inicio=booking["start_at"], fim=booking["end_at"],
                descricao="Agendamento criado pela pagina publica do Norium.", participantes=[payload.email],
                operation_id=f"scheduling:{booking['public_id']}",
            )
            event_id = str(calendar_result.get("evento", {}).get("id") or "")
            if event_id: scheduling.attach_external_event(booking["public_id"], event_id)
        except Exception:
            # A reserva local e a fonte de verdade. A sincronizacao pode ser
            # conciliada posteriormente sem criar outro booking.
            pass
    return result


@public_router.post("/bookings/cancel")
def cancel_booking(payload: CancelPayload):
    return service().cancel(payload.token)


@public_router.post("/bookings/reschedule")
def reschedule_booking(payload: ReschedulePayload):
    return service().reschedule(payload.token, payload.startAt, payload.duration)
