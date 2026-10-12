from __future__ import annotations

import asyncio
import logging
import re
from threading import Lock
from time import monotonic
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import Field

from app.core.request_context import current_workspace_id
from app.modules.auth.router import current_user, effective_permissions
from app.modules.inbox.router import record_event
from app.modules.scheduling.schemas import AdminReschedulePayload, AvailabilityPayload, BookingPayload, CancelPayload, HoldPayload, LogoPayload, PagePayload, ReschedulePayload, ServicePayload, TeamSettingsPayload
from app.modules.scheduling.service import SchedulingService, parse_utc, scope_from_user
from app.services.calendar_service import CalendarService
from app.services.gmail_service import GmailConfigError, GmailService
from app.services.wapi_client import WapiError
from app.services.wapi_connect import WapiConnectService
from app.services.wapi_messaging import MessagingUnavailable, WapiMessagingService
from app.shared.schemas import StrictModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scheduling", tags=["Agendamentos"])
public_router = APIRouter(prefix="/api/public/scheduling", tags=["Agendamentos publicos"])

_service_instance: SchedulingService | None = None
_service_lock = Lock()

CALENDAR_BUSY_CACHE_TTL_SECONDS = 45.0
INTERACTIVE_CALENDAR_TIMEOUT_SECONDS = 0.75
_calendar_busy_cache: dict[
    tuple[str, str, str, str],
    tuple[float, list[tuple[datetime, datetime]]],
] = {}
_calendar_busy_refreshing: set[tuple[str, str, str, str]] = set()


def service() -> SchedulingService:
    global _service_instance
    if _service_instance is None:
        with _service_lock:
            if _service_instance is None:
                _service_instance = SchedulingService()
    return _service_instance


async def calendar_busy(owner_id: str, start_at: str, end_at: str, *, exclude_event_id: str | None = None) -> list[tuple[datetime, datetime]]:
    start = datetime.fromisoformat(start_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    end = datetime.fromisoformat(end_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    try:
        result = await asyncio.to_thread(CalendarService(owner_id).list_events, time_min=start.isoformat(), time_max=end.isoformat(), max_results=250)
    except Exception as exc:
        raise HTTPException(503, "Nao foi possivel validar conflitos do calendario conectado.") from exc
    busy: list[tuple[datetime, datetime]] = []
    for event in result.get("eventos", []):
        if exclude_event_id and str(event.get("id") or "") == exclude_event_id:
            continue
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


async def calendar_conflicts(owner_id: str, start_at: str, end_at: str, *, exclude_event_id: str | None = None) -> bool:
    return bool(await calendar_busy(owner_id, start_at, end_at, exclude_event_id=exclude_event_id))


def _calendar_cache_key(owner_id: str, start_at: str, end_at: str, exclude_event_id: str | None = None) -> tuple[str, str, str, str]:
    return owner_id, start_at, end_at, exclude_event_id or ""


def _cached_calendar_busy(owner_id: str, start_at: str, end_at: str, *, exclude_event_id: str | None = None) -> list[tuple[datetime, datetime]] | None:
    key = _calendar_cache_key(owner_id, start_at, end_at, exclude_event_id)
    cached = _calendar_busy_cache.get(key)
    if not cached:
        return None
    stored_at, busy = cached
    if monotonic() - stored_at > CALENDAR_BUSY_CACHE_TTL_SECONDS:
        _calendar_busy_cache.pop(key, None)
        return None
    return list(busy)


def _cache_calendar_busy(owner_id: str, start_at: str, end_at: str, busy: list[tuple[datetime, datetime]], *, exclude_event_id: str | None = None) -> None:
    if len(_calendar_busy_cache) > 256:
        cutoff = monotonic() - CALENDAR_BUSY_CACHE_TTL_SECONDS
        for key, (stored_at, _items) in list(_calendar_busy_cache.items()):
            if stored_at < cutoff:
                _calendar_busy_cache.pop(key, None)
    _calendar_busy_cache[_calendar_cache_key(owner_id, start_at, end_at, exclude_event_id)] = (monotonic(), list(busy))


async def _refresh_calendar_busy_cache(owner_id: str, start_at: str, end_at: str, exclude_event_id: str | None = None) -> None:
    key = _calendar_cache_key(owner_id, start_at, end_at, exclude_event_id)
    if key in _calendar_busy_refreshing:
        return
    _calendar_busy_refreshing.add(key)
    try:
        busy = await calendar_busy(owner_id, start_at, end_at, exclude_event_id=exclude_event_id)
        _cache_calendar_busy(owner_id, start_at, end_at, busy, exclude_event_id=exclude_event_id)
    except HTTPException:
        logger.info("Calendario externo indisponivel para atualizar cache de horarios.")
    finally:
        _calendar_busy_refreshing.discard(key)


async def _calendar_conflict_fast(owner_id: str, start_at: str, end_at: str, *, exclude_event_id: str | None = None) -> tuple[bool, bool]:
    cached = _cached_calendar_busy(owner_id, start_at, end_at, exclude_event_id=exclude_event_id)
    if cached is not None:
        return bool(cached), True
    try:
        busy = await asyncio.wait_for(
            calendar_busy(owner_id, start_at, end_at, exclude_event_id=exclude_event_id),
            timeout=INTERACTIVE_CALENDAR_TIMEOUT_SECONDS,
        )
    except (HTTPException, TimeoutError):
        return False, False
    _cache_calendar_busy(owner_id, start_at, end_at, busy, exclude_event_id=exclude_event_id)
    return bool(busy), True


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


@router.delete("/services/{service_id}")
def archive_service(service_id: str, user: dict[str, Any] = Depends(current_user)):
    # Arquivamento recuperavel: paginas e agendamentos sao preservados e a
    # resposta informa quantos ficam indisponiveis para novas reservas.
    return service().archive_service(authorized_scope(user), service_id)


@router.get("/availability")
def get_availability(serviceId: str | None = None, responsibleId: str | None = None, user: dict[str, Any] = Depends(current_user)):
    return service().get_availability(authorized_scope(user), serviceId, responsibleId)


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


@router.get("/team-settings")
async def get_team_settings(user: dict[str, Any] = Depends(current_user)):
    from app.modules.team.router import visible_team_members
    settings = service().team_settings(authorized_scope(user))
    members = {str(item.get("id") or ""): item for item in await visible_team_members(user)}
    configured = {str(item.get("user_id") or ""): item for item in settings["professionals"]}
    settings["professionals"] = [
        {
            "userId": member_id, "name": member.get("nome") or member.get("email") or "Membro",
            "email": member.get("email") or "", "avatarUrl": member.get("fotoUrl") or "",
            "jobTitle": member.get("jobTitle") or "Membro",
            "active": bool(configured.get(member_id, {}).get("active")),
            "profession": configured.get(member_id, {}).get("profession") or "",
            "position": configured.get(member_id, {}).get("position") or member.get("jobTitle") or "Membro",
            "color": configured.get(member_id, {}).get("color") or "#6d5dfc",
        }
        for member_id, member in members.items()
    ]
    return settings


@router.put("/team-settings")
async def update_team_settings(payload: TeamSettingsPayload, user: dict[str, Any] = Depends(current_user)):
    from app.modules.team.router import visible_team_members
    members = {str(item.get("id") or ""): item for item in await visible_team_members(user)}
    service().save_team_settings(authorized_scope(user), payload, members)
    return await get_team_settings(user)


@router.get("/team-calendar")
def team_calendar(startAt: str | None = None, endAt: str | None = None, user: dict[str, Any] = Depends(current_user)):
    return {"events": service().team_calendar(authorized_scope(user), startAt, endAt)}


class BookingStatusPayload(StrictModel):
    status: str = Field(min_length=1, max_length=20)
    completionType: Literal["service", "meeting"] | None = None


@router.patch("/bookings/{booking_id}/status")
def update_booking_status(booking_id: str, payload: BookingStatusPayload, user: dict[str, Any] = Depends(current_user)):
    return service().update_booking_status(authorized_scope(user), booking_id, payload.status, payload.completionType)


def _gmail_connected(owner_id: str) -> bool:
    try:
        return bool(GmailService(owner_id).connection_snapshot().get("connected"))
    except Exception:
        return False


def _whatsapp_connected(owner_id: str) -> bool:
    try:
        return WapiConnectService().cached_status(owner_id).get("status") == "conectado"
    except Exception:
        return False


async def _channel_connections(owner_id: str) -> tuple[bool, bool]:
    """Channel probes never block rendering the actual message preview."""
    async def probe(callable_) -> bool:
        try:
            return bool(await asyncio.wait_for(asyncio.to_thread(callable_, owner_id), timeout=0.8))
        except (TimeoutError, Exception):
            return False

    gmail, whatsapp = await asyncio.gather(probe(_gmail_connected), probe(_whatsapp_connected))
    return gmail, whatsapp


def _whatsapp_target(phone: str | None) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if not 8 <= len(digits) <= 15:
        raise HTTPException(422, "O telefone do agendamento e invalido para WhatsApp.")
    return digits


@router.get("/bookings/{booking_id}/notify-preview")
async def reschedule_notify_preview(
    booking_id: str,
    startAt: str,
    duration: int = Query(ge=5, le=1440),
    responsibleId: str | None = Query(default=None, max_length=80),
    signoff: Literal["team", "professional"] = Query(default="team"),
    user: dict[str, Any] = Depends(current_user),
):
    scope = authorized_scope(user)
    scheduling = service()
    context = scheduling.booking_context(scope, booking_id)
    booking, svc = context["booking"], context["service"]
    if duration not in (svc.get("durations") or []):
        raise HTTPException(422, "Duracao nao permitida.")
    start = parse_utc(startAt)
    end = start + timedelta(minutes=duration)
    timezone_name = str(booking.get("timezone") or "America/Sao_Paulo")
    professionals = scheduling.team_settings(scope).get("professionals") or []
    names = {str(item.get("user_id") or ""): str(item.get("display_name") or "Profissional") for item in professionals}
    previous_professional_id = str(booking.get("responsible_id") or booking.get("owner_id") or "")
    new_professional_id = str(responsibleId or previous_professional_id)
    previous_professional_name = names.get(previous_professional_id, "")
    new_professional_name = names.get(new_professional_id, previous_professional_name)
    signature = new_professional_name if signoff == "professional" and new_professional_name else "Equipe Norium"
    email = scheduling.render_reschedule_email(
        service_name=str(svc.get("name") or "Agendamento"),
        attendee_name=str(booking.get("attendee_name") or ""),
        old_start=str(booking.get("start_at") or ""),
        new_start=start.isoformat(),
        timezone_name=timezone_name,
        previous_professional_name=previous_professional_name,
        new_professional_name=new_professional_name,
        signature=signature,
    )
    whatsapp_message = scheduling.render_reschedule_whatsapp(
        service_name=str(svc.get("name") or "Agendamento"),
        attendee_name=str(booking.get("attendee_name") or ""),
        old_start=str(booking.get("start_at") or ""),
        new_start=start.isoformat(),
        timezone_name=timezone_name,
        previous_professional_name=previous_professional_name,
        new_professional_name=new_professional_name,
        signature=signature,
    )
    owner_id = str(booking.get("owner_id") or scope[2])
    gmail_ok, whatsapp_ok = await _channel_connections(owner_id)
    phone_digits = re.sub(r"\D", "", str(booking.get("attendee_phone") or ""))
    return {
        "bookingId": booking["id"],
        "serviceName": svc.get("name"),
        "timezone": timezone_name,
        "oldStartAt": booking.get("start_at"),
        "oldEndAt": booking.get("end_at"),
        "newStartAt": start.isoformat(),
        "newEndAt": end.isoformat(),
        "attendeeName": booking.get("attendee_name"),
        "attendeeEmail": booking.get("attendee_email"),
        "attendeePhone": booking.get("attendee_phone"),
        "phoneValid": 8 <= len(phone_digits) <= 15,
        "gmailConnected": gmail_ok,
        "whatsappConnected": whatsapp_ok,
        "gmailSubject": email["subject"],
        "gmailBody": email["body"],
        "whatsappMessage": whatsapp_message,
        "professionalChanged": previous_professional_id != new_professional_id,
        "previousProfessionalName": previous_professional_name,
        "newProfessionalName": new_professional_name,
        "signature": signature,
    }


async def _send_reschedule_gmail(
    scheduling: SchedulingService,
    scope: tuple[str, str, str],
    user: dict[str, Any],
    booking: dict[str, Any],
    service_name: str,
    operation_key: str,
    subject: str,
    body: str,
) -> dict[str, Any]:
    claim = scheduling.begin_notification_attempt(scope, operation_key, "gmail", booking["id"])
    prior = claim["attempt"]
    if not claim["claimed"]:
        if prior.get("status") == "sent":
            return {"sent": True, "replay": True, "receipt": prior.get("receipt")}
        return {"sent": False, "uncertain": True, "error": "Um envio anterior ficou sem confirmação. Confira o Gmail antes de tentar novamente."}
    owner_id = str(booking.get("owner_id") or scope[2])
    try:
        sent = await asyncio.to_thread(
            GmailService(owner_id).send_message,
            to=[str(booking.get("attendee_email") or "")],
            subject=subject,
            body=body,
        )
        message = sent.get("message", {}) if isinstance(sent, dict) else {}
        message_id = str(message.get("id") or "")
        if not message_id:
            raise RuntimeError("O Gmail nao devolveu um recibo verificavel.")
        receipt = {"messageId": message_id, "threadId": str(message.get("threadId") or "")}
        scheduling.save_notification_attempt(scope, operation_key, "gmail", booking["id"], "sent", receipt)
        from app.modules.operations.schemas import ReceiptCreate
        from app.modules.operations.service import record_receipt
        await record_receipt(
            user,
            ReceiptCreate(
                action="scheduling_reschedule_gmail",
                title="Aviso de reagendamento enviado",
                description=f"E-mail de reagendamento de {service_name} enviado para {booking.get('attendee_email')}.",
                entityType="booking",
                entityId=str(booking.get("id")),
                metadata={"operationKey": operation_key, "messageId": message_id},
            ),
        )
        return {"sent": True, "receipt": receipt}
    except GmailConfigError as exc:
        scheduling.save_notification_attempt(scope, operation_key, "gmail", booking["id"], "failed", error=str(exc))
        return {"sent": False, "error": str(exc), "needsConnection": True}
    except Exception:
        logger.exception("Falha ao notificar reagendamento por e-mail.")
        return {"sent": False, "uncertain": True, "error": "O resultado do Gmail e incerto. Confira a caixa de enviados antes de tentar novamente."}


async def _send_reschedule_whatsapp(
    scheduling: SchedulingService,
    scope: tuple[str, str, str],
    user: dict[str, Any],
    booking: dict[str, Any],
    service_name: str,
    operation_key: str,
    text: str,
) -> dict[str, Any]:
    claim = scheduling.begin_notification_attempt(scope, operation_key, "whatsapp", booking["id"])
    prior = claim["attempt"]
    if not claim["claimed"]:
        if prior.get("status") == "sent":
            return {"sent": True, "replay": True, "receipt": prior.get("receipt")}
        return {"sent": False, "uncertain": True, "error": "Um envio anterior ficou sem confirmação. Confira o WhatsApp antes de tentar novamente."}
    try:
        target = _whatsapp_target(booking.get("attendee_phone"))
    except HTTPException as exc:
        detail = str(exc.detail)
        scheduling.save_notification_attempt(scope, operation_key, "whatsapp", booking["id"], "failed", error=detail)
        return {"sent": False, "error": detail}
    owner_id = str(booking.get("owner_id") or scope[2])
    try:
        result = await WapiMessagingService().send_text(owner_id, target, text)
        message_id = str(result.get("messageId") or "")
        if not result.get("sent") or not message_id:
            raise RuntimeError("O WhatsApp nao devolveu um recibo verificavel.")
        receipt = {"messageId": message_id}
        scheduling.save_notification_attempt(scope, operation_key, "whatsapp", booking["id"], "sent", receipt)
        from app.modules.operations.schemas import ReceiptCreate
        from app.modules.operations.service import record_receipt
        await record_receipt(
            user,
            ReceiptCreate(
                action="scheduling_reschedule_whatsapp",
                title="Aviso de reagendamento enviado",
                description=f"WhatsApp de reagendamento de {service_name} enviado para o telefone do agendamento.",
                entityType="booking",
                entityId=str(booking.get("id")),
                metadata={"operationKey": operation_key, "messageId": message_id},
            ),
        )
        return {"sent": True, "receipt": receipt}
    except MessagingUnavailable as exc:
        scheduling.save_notification_attempt(scope, operation_key, "whatsapp", booking["id"], "failed", error=str(exc))
        return {"sent": False, "error": str(exc), "needsConnection": True}
    except WapiError as exc:
        deterministic = exc.status is not None and 400 <= exc.status < 500 and exc.status not in {408, 409, 425, 429}
        if deterministic:
            scheduling.save_notification_attempt(scope, operation_key, "whatsapp", booking["id"], "failed", error=exc.message)
            return {"sent": False, "error": exc.message}
        return {"sent": False, "uncertain": True, "error": "O resultado do WhatsApp e incerto. Confira a conversa antes de tentar novamente."}
    except Exception:
        logger.exception("Falha ao notificar reagendamento por WhatsApp.")
        return {"sent": False, "uncertain": True, "error": "O resultado do WhatsApp e incerto. Confira a conversa antes de tentar novamente."}


def _sync_reschedule_calendar(previous_owner_id: str, owner_id: str, service_name: str, booking_before: dict[str, Any], booking: dict[str, Any]) -> None:
    try:
        calendar_service = CalendarService(owner_id)
        external_event_id = str(booking_before.get("external_event_id") or "")
        if external_event_id and previous_owner_id == owner_id:
            calendar_service.update_event(
                external_event_id,
                {"inicio": booking["start_at"], "fim": booking["end_at"]},
            )
            return
        if external_event_id and previous_owner_id != owner_id:
            try:
                CalendarService(previous_owner_id).delete_event(external_event_id)
            except Exception:
                logger.warning("Nao foi possivel remover o evento do profissional anterior; criando no novo calendario para conciliacao.", exc_info=True)
        created = calendar_service.create_event(
            titulo=service_name,
            inicio=booking["start_at"],
            fim=booking["end_at"],
            descricao="Agendamento reagendado pelo Norium.",
            participantes=[str(booking.get("attendee_email") or "")],
            operation_id=f"scheduling:{booking.get('public_id')}",
        )
        event_id = str(created.get("evento", {}).get("id") or "")
        if event_id:
            service().attach_external_event(str(booking.get("public_id") or ""), event_id)
    except Exception:
        logger.exception("Falha ao sincronizar reagendamento no calendario externo.")


async def _deliver_reschedule_notifications(
    scheduling: SchedulingService,
    scope: tuple[str, str, str],
    user: dict[str, Any],
    booking: dict[str, Any],
    service_name: str,
    operation_key: str,
    *,
    notify_gmail: bool,
    notify_whatsapp: bool,
    gmail_subject: str,
    gmail_body: str,
    whatsapp_message: str,
) -> None:
    jobs = []
    if notify_gmail:
        jobs.append(_send_reschedule_gmail(
            scheduling, scope, user, booking, service_name, operation_key,
            gmail_subject, gmail_body,
        ))
    if notify_whatsapp:
        jobs.append(_send_reschedule_whatsapp(
            scheduling, scope, user, booking, service_name, operation_key,
            whatsapp_message,
        ))
    if jobs:
        await asyncio.gather(*jobs, return_exceptions=True)


@router.post("/bookings/{booking_id}/reschedule")
async def reschedule_booking_admin(
    booking_id: str,
    payload: AdminReschedulePayload,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
):
    scope = authorized_scope(user)
    scheduling = service()
    context = scheduling.booking_context(scope, booking_id)
    booking_before, svc = context["booking"], context["service"]
    service_name = str(svc.get("name") or "Agendamento")
    new_start = parse_utc(payload.startAt)
    new_end = new_start + timedelta(minutes=payload.duration)
    previous_owner_id = str(booking_before.get("responsible_id") or booking_before.get("owner_id") or scope[2])
    owner_id = str(payload.responsibleId or previous_owner_id)
    conflict, calendar_verified = await _calendar_conflict_fast(
        owner_id,
        new_start.isoformat(),
        new_end.isoformat(),
        exclude_event_id=(str(booking_before.get("external_event_id") or "") or None) if owner_id == previous_owner_id else None,
    )
    if conflict:
        raise HTTPException(409, "Novo horario ocupado no calendario conectado.")
    if not calendar_verified:
        logger.info("Calendario externo nao respondeu a tempo; reagendamento segue com validacao local.")
    result = scheduling.admin_reschedule(scope, booking_id, payload.startAt, payload.duration, payload.responsibleId)
    booking = result["booking"]
    background_tasks.add_task(
        _sync_reschedule_calendar,
        previous_owner_id,
        owner_id,
        service_name,
        dict(booking_before),
        dict(booking),
    )
    timezone_name = str(booking.get("timezone") or "America/Sao_Paulo")
    attendee_name = str(booking.get("attendee_name") or "")
    professionals = scheduling.team_settings(scope).get("professionals") or []
    names = {str(item.get("user_id") or ""): str(item.get("display_name") or "Profissional") for item in professionals}
    previous_professional_name = names.get(previous_owner_id, "")
    new_professional_name = names.get(owner_id, previous_professional_name)
    signature = new_professional_name if payload.signoff == "professional" and new_professional_name else "Equipe Norium"
    receipts: dict[str, Any] = {"gmail": None, "whatsapp": None}
    if payload.notifyGmail or payload.notifyWhatsapp:
        operation_key = str(payload.operationKey or "")
        defaults_email = scheduling.render_reschedule_email(
            service_name=service_name,
            attendee_name=attendee_name,
            old_start=str(booking_before.get("start_at") or ""),
            new_start=str(booking.get("start_at") or ""),
            timezone_name=timezone_name,
            previous_professional_name=previous_professional_name,
            new_professional_name=new_professional_name,
            signature=signature,
        )
        defaults_whatsapp = scheduling.render_reschedule_whatsapp(
            service_name=service_name,
            attendee_name=attendee_name,
            old_start=str(booking_before.get("start_at") or ""),
            new_start=str(booking.get("start_at") or ""),
            timezone_name=timezone_name,
            previous_professional_name=previous_professional_name,
            new_professional_name=new_professional_name,
            signature=signature,
        )
        background_tasks.add_task(
            _deliver_reschedule_notifications,
            scheduling,
            scope,
            dict(user),
            dict(booking),
            service_name,
            operation_key,
            notify_gmail=payload.notifyGmail,
            notify_whatsapp=payload.notifyWhatsapp,
            gmail_subject=payload.gmailSubject.strip() or defaults_email["subject"],
            gmail_body=payload.gmailBody.strip() or defaults_email["body"],
            whatsapp_message=payload.whatsappMessage.strip() or defaults_whatsapp,
        )
        if payload.notifyGmail:
            receipts["gmail"] = {"sent": False, "queued": True}
        if payload.notifyWhatsapp:
            receipts["whatsapp"] = {"sent": False, "queued": True}
    return {
        "booking": booking,
        "replay": result["replay"],
        "calendarSync": {"synced": False, "queued": True, "verifiedBeforeSave": calendar_verified},
        "receipts": receipts,
    }


@public_router.get("/pages/{identifier}")
def get_public_page(identifier: str):
    return service().public_page(identifier)


@public_router.get("/pages/{identifier}/logo")
def get_public_logo(identifier: str):
    asset, mime = service().logo_asset(identifier)
    if isinstance(asset, bytes):
        return Response(asset, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})
    return FileResponse(asset, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})


@public_router.get("/pages/{identifier}/slots")
async def get_slots(
    identifier: str,
    background_tasks: BackgroundTasks,
    day: date = Query(),
    duration: int = Query(ge=5, le=1440),
    responsibleId: str | None = Query(default=None, max_length=80),
    serviceId: str | None = Query(default=None, max_length=80),
):
    scheduling = service()
    bundle = scheduling.public_page(identifier)
    result = scheduling.available_slots(identifier, day, duration, bundle=bundle, responsible_id=responsibleId, service_id=serviceId)
    calendar_verified = True
    if result["slots"]:
        owner_id = str(result.get("responsibleId") or bundle["page"]["owner_id"])
        start_at = result["slots"][0]["startAt"]
        end_at = result["slots"][-1]["endAt"]
        busy = _cached_calendar_busy(owner_id, start_at, end_at)
        if busy is None:
            calendar_verified = False
            background_tasks.add_task(_refresh_calendar_busy_cache, owner_id, start_at, end_at)
            busy = []
        else:
            result["slots"] = [
                slot for slot in result["slots"]
                if not any(
                    datetime.fromisoformat(slot["startAt"]) < end
                    and datetime.fromisoformat(slot["endAt"]) > start
                    for start, end in busy
                )
            ]
    result["calendarVerified"] = calendar_verified
    return result


@public_router.post("/pages/{identifier}/holds", status_code=201)
async def create_hold(identifier: str, payload: HoldPayload):
    scheduling = service()
    bundle = scheduling.public_page(identifier)
    start = datetime.fromisoformat(payload.startAt.replace("Z", "+00:00"))
    end = start + timedelta(minutes=payload.duration)
    _selected_service, responsible = scheduling._resolve_public_selection(bundle["page"], payload.serviceId, payload.responsibleId)
    conflict, verified = await _calendar_conflict_fast(responsible, start.isoformat(), end.isoformat())
    if not verified:
        logger.info("Calendario externo nao respondeu a tempo ao criar hold; validacao local preservada.")
    if conflict:
        raise HTTPException(409, "Horario ocupado no calendario conectado.")
    return scheduling.create_hold(identifier, payload)


def _format_booking_value(value: Any) -> str:
    if isinstance(value, bool):
        return "Sim" if value else "Não"
    if isinstance(value, list):
        return ", ".join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip()


def _booking_calendar_details(payload: BookingPayload, fields: list[dict[str, Any]], service_data: dict[str, Any]) -> tuple[str, str]:
    lines = [
        "Agendamento criado pela página pública do Norium.",
        "",
        f"Nome: {payload.name.strip()}",
        f"E-mail: {payload.email}",
    ]
    if payload.phone:
        lines.append(f"Telefone: {payload.phone}")

    fields_by_id = {str(field.get("id") or ""): field for field in fields if isinstance(field, dict)}
    address = ""
    for key, value in payload.responses.items():
        formatted = _format_booking_value(value)
        if not formatted:
            continue
        field = fields_by_id.get(str(key), {})
        label = str(field.get("label") or key).strip()
        lines.append(f"{label}: {formatted}")
        if not address and field.get("type") == "address":
            address = formatted

    if not address and service_data.get("location_type") == "in_person":
        address = str(service_data.get("location") or "").strip()

    return "\n".join(lines), address


def _sync_public_booking_calendar(
    owner_id: str,
    service_name: str,
    booking: dict[str, Any],
    attendee_email: str,
    description: str,
    location: str,
) -> None:
    try:
        calendar_result = CalendarService(owner_id).create_event(
            titulo=service_name,
            inicio=booking["start_at"],
            fim=booking["end_at"],
            descricao=description,
            local=location,
            participantes=[attendee_email],
            operation_id=f"scheduling:{booking['public_id']}",
        )
        event_id = str(calendar_result.get("evento", {}).get("id") or "")
        if event_id:
            service().attach_external_event(booking["public_id"], event_id)
    except Exception:
        logger.exception("Falha ao sincronizar agendamento publico no calendario externo.")


@public_router.post("/pages/{identifier}/bookings", status_code=201)
async def create_booking(identifier: str, payload: BookingPayload, background_tasks: BackgroundTasks):
    scheduling = service()
    bundle = scheduling.public_page(identifier)
    start = datetime.fromisoformat(payload.startAt.replace("Z", "+00:00"))
    end = start + timedelta(minutes=payload.duration)
    selected_service, responsible = scheduling._resolve_public_selection(bundle["page"], payload.serviceId, payload.responsibleId)
    conflict, verified = await _calendar_conflict_fast(responsible, start.isoformat(), end.isoformat())
    if not verified:
        logger.info("Calendario externo nao respondeu a tempo na confirmacao; validacao local preservada.")
    if conflict:
        raise HTTPException(409, "Horario ocupado no calendario conectado.")
    result = scheduling.create_booking(identifier, payload)
    booking = result.get("booking", {})
    if not result.get("idempotentReplay") and booking:
        await record_event(
            source="calendar",
            title="Novo agendamento recebido",
            description=str(selected_service.get("name") or "Reunião agendada"),
            event_id=f"scheduling_{booking['id']}_created",
            metadata={
                "userId": str(booking.get("responsible_id") or booking.get("owner_id") or ""),
                "bookingId": booking.get("id"),
                "inicio": booking.get("start_at"),
                "fim": booking.get("end_at"),
                "emailCategory": "meeting_scheduled",
            },
        )
        description, location = _booking_calendar_details(
            payload,
            list(bundle["page"].get("fields") or []),
            dict(selected_service),
        )
        background_tasks.add_task(
            _sync_public_booking_calendar,
            responsible,
            str(selected_service["name"]),
            dict(booking),
            payload.email,
            description,
            location,
        )
    return result


@public_router.post("/bookings/cancel")
def cancel_booking(payload: CancelPayload):
    return service().cancel(payload.token)


@public_router.post("/bookings/reschedule")
def reschedule_booking(payload: ReschedulePayload):
    return service().reschedule(payload.token, payload.startAt, payload.duration)
