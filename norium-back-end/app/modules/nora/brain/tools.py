"""Business adapters: explicit projections, versions, effects and evidence."""
from __future__ import annotations

import hashlib
from datetime import date, datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .contracts import BrainError, InformationRequired, Outcome, Strict, fingerprint
from .policy import Registry, Tool
from . import task_bridge


class Query(Strict):
    query: str = Field(default="", max_length=160)
    cursor: int = Field(default=0, ge=0, le=100_000)
    fields: list[str] = Field(default_factory=list, max_length=8)


class TaskQuery(Query):
    dueDate: str | None = None
    status: str | None = Field(default=None, max_length=40)

    @field_validator("dueDate")
    @classmethod
    def query_iso_date(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value


class CreateTask(Strict):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    dueDate: str | None = None

    @field_validator("dueDate")
    @classmethod
    def iso_date(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value


class SchedulingQuery(Strict):
    kind: Literal["services", "pages", "bookings"] = "bookings"
    query: str = Field(default="", max_length=160)


class SchedulingCreate(Strict):
    serviceName: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    durationMinutes: int = Field(ge=5, le=1440)
    weekdays: list[int] = Field(min_length=1, max_length=7)
    startTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    endTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    breakStart: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    breakEnd: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    capacity: int = Field(default=1, ge=1, le=500)
    timezone: str = Field(default="America/Sao_Paulo", max_length=80)
    slug: str | None = Field(default=None, max_length=64)
    collectCpf: bool = False

    @model_validator(mode="after")
    def valid_schedule(self):
        if self.startTime >= self.endTime:
            raise ValueError("startTime must precede endTime")
        if (self.breakStart is None) != (self.breakEnd is None):
            raise ValueError("breakStart and breakEnd must be provided together")
        if self.breakStart and not (self.startTime < self.breakStart < self.breakEnd < self.endTime):
            raise ValueError("break must be inside availability")
        if any(day < 0 or day > 6 for day in self.weekdays):
            raise ValueError("weekdays must use 0=Monday through 6=Sunday")
        return self

class ChangeTask(Strict):
    id: str = Field(min_length=1, max_length=100)
    action: Literal["deadline", "complete", "delete"]
    dueDate: str | None = None

    @field_validator("dueDate")
    @classmethod
    def iso_date(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value


def private_tasks(user):
    from app.core.tenant import read_user_db, get_user_db_path
    from app.services.task_store import _validate_workspace
    payload = read_user_db(user["id"], "tarefas", {})
    if payload:
        _validate_workspace(payload, get_user_db_path(user["id"], "tarefas"))
    return payload


async def prepare_query(user, args, job):
    return {**args.model_dump(), "effects": []}


def page(items, prepared, fields, *, defaults=None):
    query = prepared["query"].casefold()
    filtered = [item for item in items if not query or query in " ".join(str(item.get(k) or "") for k in fields).casefold()]
    if prepared.get("dueDate"):
        filtered = [item for item in filtered if item.get("dueDate") == prepared["dueDate"]]
    if prepared.get("status"):
        filtered = [item for item in filtered if str(item.get("status") or "").casefold() == prepared["status"].casefold()]
    offset = prepared["cursor"]
    selected = [field for field in prepared.get("fields", []) if field in fields] or list(defaults or fields)
    if "id" in fields and "id" not in selected:
        selected.insert(0, "id")
    records = [{k: row.get(k) for k in selected} for row in filtered[offset:offset + 20]]
    return {"records": records, "total": len(filtered), "nextCursor": offset + 20 if offset + 20 < len(filtered) else None,
            "coverage": "registros privados do usuário neste workspace"}


async def query_tasks(user, prepared, job):
    items = private_tasks(user).get("tasks", [])
    data = page(items, prepared, ("id", "title", "status", "dueDate", "updatedAt"),
                defaults=("id", "title", "status", "dueDate"))
    return Outcome("succeeded", data, {"read": "tasks", "total": data["total"]})


async def prepare_create(user, args, job):
    return {**args.model_dump(), "action": "create", "effects": ["private_task"]}


async def prepare_change(user, args, job):
    workspace = private_tasks(user)
    task = next((item for item in workspace.get("tasks", []) if item.get("id") == args.id), None)
    if task is None:
        raise BrainError("task_not_found", 404)
    project = next((p for p in workspace.get("projects", []) if p.get("id") == task.get("projectId", "default")), None)
    if not project or project.get("sharedUserIds"):
        raise BrainError("shared_task_adapter_required")
    if args.action == "deadline" and not args.dueDate:
        raise BrainError("date_required", 422)
    changes = {"dueDate": args.dueDate} if args.action == "deadline" else {"status": "concluida"}
    return {"id": args.id, "title": task["title"], "version": fingerprint(task), "action": args.action,
            "before": {"dueDate": task.get("dueDate"), "status": task.get("status")},
            "changes": changes if args.action != "delete" else {}, "effects": ["delete" if args.action == "delete" else "private_task"]}


async def execute_task(user, prepared, job):
    result = task_bridge.execute(user["id"], prepared, job["operationId"])
    return Outcome("succeeded", result, {"operationId": job["operationId"], **result})


async def reconcile_task(user, prepared, job):
    result = task_bridge.receipt(user["id"], job["operationId"])
    return (Outcome("succeeded", result, result) if result else
            Outcome("rejected", {}, {"confirmedNotApplied": True, "reason": "atomic_receipt_absent"}))


async def query_clients(user, prepared, job):
    from app.modules.clients.repository import read_clients
    items = await read_clients(user["id"])
    data = page(items, prepared, ("id", "name", "nome", "email", "phone", "updatedAt"),
                defaults=("id", "name", "nome"))
    return Outcome("succeeded", data, {"read": "clients", "total": data["total"]})


async def query_finance(user, prepared, job):
    from app.services.finance_store import list_finance
    payload = list_finance(user["id"])
    data = page(payload.get("lancamentos", []), prepared, ("id", "descricao", "valor", "tipo", "data", "status"))
    return Outcome("succeeded", data, {"read": "finance", "total": data["total"]})


async def prepare_scheduling(user, args, job):
    return {**args.model_dump(), "effects": []}


async def query_scheduling(user, prepared, job):
    from app.core.request_context import current_workspace_id
    from app.modules.scheduling.service import SchedulingService, scope_from_user
    scheduling = SchedulingService()
    scope = scope_from_user(user, current_workspace_id())
    records = {"services": scheduling.list_services, "pages": scheduling.list_pages, "bookings": scheduling.list_bookings}[prepared["kind"]](scope)
    query = prepared["query"].casefold()
    if query:
        records = [item for item in records if query in " ".join(str(value) for value in item.values() if not isinstance(value, (dict, list))).casefold()]
    safe = [{key: value for key, value in item.items() if key not in {"responses", "cancel_token_hash", "reschedule_token_hash", "attendee_phone"}} for item in records[:20]]
    return Outcome("succeeded", {"records": safe, "total": len(records)}, {"read": f"scheduling_{prepared['kind']}", "total": len(records)})


async def prepare_scheduling_create(user, args, job):
    return {**args.model_dump(), "effects": ["scheduling_page"], "summary": {"service": args.serviceName, "duration": args.durationMinutes, "weekdays": args.weekdays, "hours": f"{args.startTime}-{args.endTime}", "capacity": args.capacity}}


async def create_scheduling_page(user, prepared, job):
    from app.core.request_context import current_workspace_id
    from app.modules.scheduling.schemas import AvailabilityPayload, BookingField, PagePayload, Period, ServicePayload
    from app.modules.scheduling.service import SchedulingService, scope_from_user
    scheduling = SchedulingService(); scope = scope_from_user(user, current_workspace_id())
    item = scheduling.create_service(scope, ServicePayload(name=prepared["serviceName"], description=prepared["description"], durations=[prepared["durationMinutes"]], capacity=prepared["capacity"]))
    periods = ([Period(start=prepared["startTime"], end=prepared["breakStart"]), Period(start=prepared["breakEnd"], end=prepared["endTime"])] if prepared.get("breakStart") else [Period(start=prepared["startTime"], end=prepared["endTime"])])
    scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], timezone=prepared["timezone"], weekly={str(day): periods for day in sorted(set(prepared["weekdays"]))}))
    fields = [BookingField(id="full_name", type="full_name", label="Nome completo", required=True, maxLength=160), BookingField(id="email", type="email", label="E-mail", required=True, maxLength=254), BookingField(id="phone", type="phone", label="WhatsApp", maxLength=32)]
    if prepared["collectCpf"]: fields.append(BookingField(id="cpf", type="cpf", label="CPF", required=True, maxLength=14))
    page = scheduling.create_page(scope, PagePayload(serviceId=item["id"], title=prepared["serviceName"], description=prepared["description"], slug=prepared.get("slug"), fields=fields))
    return Outcome("succeeded", {"serviceId": item["id"], "pageId": page["id"], "publicId": page["public_id"], "slug": page.get("slug")}, {"operationId": job["operationId"], "created": "scheduling_page", "pageId": page["id"]})


class Email(Strict):
    to: list[str] = Field(min_length=1, max_length=20)
    cc: list[str] = Field(default_factory=list, max_length=20)
    bcc: list[str] = Field(default_factory=list, max_length=20)
    subject: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=12000)
    attachmentIds: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("to", "cc", "bcc")
    @classmethod
    def addresses(cls, value):
        import re
        if any(not re.fullmatch(r"[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+", item) for item in value):
            raise ValueError("Use exact email addresses")
        return value


async def prepare_email(user, args, job):
    from app.services.gmail_service import GmailService
    status = GmailService(user["id"]).status()
    if not status.get("connected") or not status.get("email"):
        raise BrainError("email_connection_required")
    from app.services.nora_files import owned_file
    attachments, total = [], 0
    for file_id in args.attachmentIds:
        record, path = owned_file(user["id"], file_id)
        size = path.stat().st_size
        total += size
        if total > 18 * 1024 * 1024:
            raise BrainError("email_attachment_limit", 413)
        attachments.append({
            "id": file_id,
            "name": str(record.get("name") or record.get("fileName") or path.name),
            "mimeType": str(record.get("mimeType") or "application/octet-stream"),
            "size": size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    payload = args.model_dump(exclude={"attachmentIds"})
    return {**payload, "sender": status["email"], "attachments": attachments, "effects": ["send"]}


async def send_email(user, prepared, job):
    from app.services.gmail_service import GmailService
    service = GmailService(user["id"])
    if service.status().get("email") != prepared["sender"]:
        return Outcome("rejected", {}, {"reason": "sender_changed"})
    from app.services.nora_files import owned_file
    import base64
    attachments = []
    for item in prepared["attachments"]:
        _, path = owned_file(user["id"], item["id"])
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            return Outcome("rejected", {}, {"reason": "attachment_changed", "attachment": item["id"]})
        attachments.append({"fileName": item["name"], "mimeType": item["mimeType"],
                            "dataUrl": "data:" + item["mimeType"] + ";base64," + base64.b64encode(content).decode()})
    result = service.send_message(
        **{k: prepared[k] for k in ("to", "cc", "bcc", "subject", "body")},
        attachments=attachments,
    )
    message_id = (result.get("message") or {}).get("id")
    if not result.get("sent") or not message_id:
        return Outcome("unknown", {}, {"reason": "provider_not_confirmed"})
    return Outcome("succeeded", {"messageId": message_id}, {"messageId": message_id, "sender": prepared["sender"]})


class WhatsAppText(Strict):
    recipient: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=4000)


async def prepare_whatsapp(user, args, job):
    from app.services.nora_whatsapp_action import resolve_whatsapp_recipient
    from app.modules.chat.router import wapi_connect
    resolved = await resolve_whatsapp_recipient(user["id"], args.recipient)
    if resolved["status"] == "not_found":
        raise InformationRequired(
            "whatsapp_recipient_not_found",
            "Não encontrei esse destinatário. Informe o nome salvo completo ou o número com DDI e DDD.",
        )
    if resolved["status"] == "ambiguous":
        raise InformationRequired(
            "whatsapp_recipient_ambiguous",
            "Encontrei mais de um destinatário. Escolha um antes de preparar o envio.",
            {"candidates": resolved["candidates"]},
        )
    status = await wapi_connect.status(user["id"])
    sender = str(status.get("numero") or "").strip()
    if status.get("status") != "conectado" or not sender:
        raise BrainError("whatsapp_sender_identity_unavailable")
    return {
        "sender": sender,
        "conversationId": resolved["conversation_id"],
        "recipient": resolved["display_name"],
        "isGroup": bool(resolved["is_group"]),
        "text": args.text,
        "attachments": [],
        "effects": ["send"],
    }


async def send_whatsapp(user, prepared, job):
    from app.modules.chat.router import whatsapp_integration, wapi_connect
    from app.modules.whatsapp import RemoteOutcomeUnknown, RemoteRejected, SendText, WhatsAppIntegrationError
    current = await wapi_connect.status(user["id"])
    if current.get("status") != "conectado" or str(current.get("numero") or "").strip() != prepared["sender"]:
        return Outcome("rejected", {}, {"reason": "sender_changed"})
    try:
        result = await whatsapp_integration.send(
            user["id"], SendText(conversation_id=prepared["conversationId"], text=prepared["text"]),
        )
    except RemoteOutcomeUnknown:
        return Outcome("unknown", {}, {"reason": "provider_outcome_unknown"})
    except RemoteRejected:
        return Outcome("rejected", {}, {"reason": "provider_rejected"})
    except WhatsAppIntegrationError:
        return Outcome("unknown", {}, {"reason": "provider_state_unavailable"})
    if not result.message_id:
        return Outcome("unknown", {}, {"reason": "provider_receipt_missing"})
    return Outcome("succeeded", {"messageId": result.message_id}, {
        "messageId": result.message_id, "sender": prepared["sender"],
        "recipient": prepared["recipient"], "conversationId": prepared["conversationId"],
    })


class CalendarQuery(Strict):
    timeMin: str
    timeMax: str
    query: str = Field(default="", max_length=160)

    @model_validator(mode="after")
    def valid_window(self):
        start, end = aware_datetime(self.timeMin), aware_datetime(self.timeMax)
        if end <= start:
            raise ValueError("timeMax must be after timeMin")
        return self


class CalendarCreate(Strict):
    title: str = Field(min_length=1, max_length=240)
    start: str
    end: str
    description: str = Field(default="", max_length=4000)
    location: str = Field(default="", max_length=300)
    participants: list[str] = Field(default_factory=list, max_length=30)
    createMeet: bool = False

    @model_validator(mode="after")
    def valid_event(self):
        if aware_datetime(self.end) <= aware_datetime(self.start):
            raise ValueError("end must be after start")
        return self

    @field_validator("participants")
    @classmethod
    def participant_addresses(cls, values):
        import re
        if any(not re.fullmatch(r"[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+", value) for value in values):
            raise ValueError("Use exact participant email addresses")
        return values


def aware_datetime(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("An explicit timezone is required")
    return parsed


async def prepare_calendar_query(user, args, job):
    return {**args.model_dump(), "effects": []}


async def query_calendar(user, prepared, job):
    from app.services.calendar_service import CalendarService
    result = CalendarService(user["id"]).list_events(
        time_min=prepared["timeMin"], time_max=prepared["timeMax"],
        query=prepared["query"] or None, max_results=21,
    )
    events = result.get("eventos", [])
    records = [{key: event.get(key) for key in ("id", "titulo", "inicio", "fim", "local", "participantes", "source")}
               for event in events[:20]]
    data = {"records": records, "nextCursor": "more" if len(events) > 20 else None,
            "coverage": {"timeMin": prepared["timeMin"], "timeMax": prepared["timeMax"], "returned": len(records)}}
    return Outcome("succeeded", data, {"read": "calendar", **data["coverage"]})


async def prepare_calendar_create(user, args, job):
    from app.services.calendar_service import CalendarService
    status = CalendarService(user["id"]).status()
    return {**args.model_dump(), "calendar": status.get("calendar") or "primary",
            "timezone": status.get("timezone") or "America/Sao_Paulo",
            "effects": ["invite"] if args.participants else ["private_calendar_event"]}


async def create_calendar_event(user, prepared, job):
    from app.services.calendar_service import CalendarService
    service = CalendarService(user["id"])
    result = service.create_event(
        titulo=prepared["title"], inicio=prepared["start"], fim=prepared["end"],
        descricao=prepared["description"], local=prepared["location"],
        participantes=prepared["participants"], criar_meet=prepared["createMeet"],
        operation_id=job["operationId"],
    )
    event = result.get("evento") or {}
    if not event.get("id"):
        return Outcome("unknown", {}, {"reason": "calendar_receipt_missing"})
    return Outcome("succeeded", {"event": event}, {
        "operationId": job["operationId"], "eventId": event["id"],
        "calendar": prepared["calendar"], "start": prepared["start"], "end": prepared["end"],
        "participants": prepared["participants"], "idempotentReplay": bool(result.get("idempotentReplay")),
    })


async def reconcile_calendar_event(user, prepared, job):
    from app.services.calendar_service import CalendarService
    event = CalendarService(user["id"]).find_event_by_operation(job["operationId"])
    if event is None:
        return Outcome("rejected", {}, {"confirmedNotApplied": True, "operationId": job["operationId"]})
    return Outcome("succeeded", {"event": event}, {
        "operationId": job["operationId"], "eventId": event.get("id"), "confirmedApplied": True,
    })


class Preference(Strict):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    value: str = Field(min_length=1, max_length=500)


def preference_tools(repo):
    async def prepare(user, args, job):
        # A model-generated boolean never establishes the user's memory request.
        import re
        if not re.search(r"(?i)\b(guarde|lembre|memorize|salve).*(prefer[eê]ncia|sempre|de agora|daqui|meu nome)", job["message"]):
            raise BrainError("explicit_preference_request_required")
        return {**args.model_dump(), "effects": ["preference"]}

    async def save(user, prepared, job):
        scope = job["scope"]
        with repo.transaction() as connection:
            repo.sql(connection, """INSERT INTO nora_preferences VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(tenant,actor,workspace,name) DO UPDATE SET value=excluded.value,source=excluded.source,updated=excluded.updated""",
                (scope["tenant"], scope["user"], scope["workspace"], prepared["name"], prepared["value"], job["operationId"], repo.clock()))
        return Outcome("succeeded", {"name": prepared["name"]}, {"saved": prepared["name"], "source": job["operationId"]})

    async def reconcile(user, prepared, job):
        scope = job["scope"]
        with repo.transaction() as connection:
            row = repo.sql(connection, """SELECT value,source FROM nora_preferences
                WHERE tenant=? AND actor=? AND workspace=? AND name=?""",
                (scope["tenant"], scope["user"], scope["workspace"], prepared["name"])).fetchone()
        if row is None:
            return Outcome("rejected", {}, {"confirmedNotApplied": True, "reason": "preference_absent"})
        if row["source"] == job["operationId"] and row["value"] == prepared["value"]:
            return Outcome("succeeded", {"name": prepared["name"]}, {"confirmedApplied": True, "source": row["source"]})
        return Outcome("unknown", {}, {"reason": "preference_changed_after_operation"})

    return Tool("memory_save", "Guardar preferência pessoal apenas quando solicitado explicitamente.", "nora", "D", Preference, prepare, save, reconcile=reconcile)


def preference_delete_tool(repo):
    async def prepare(user, args, job):
        import re
        if not re.search(r"(?i)\b(apague|delete|exclua|esqueça|remova).*(prefer[eê]ncia|mem[oó]ria|lembrete)", job["message"]):
            raise BrainError("explicit_preference_deletion_required")
        scope = job["scope"]
        with repo.transaction() as connection:
            row = repo.sql(connection, """SELECT value,source,updated FROM nora_preferences
                WHERE tenant=? AND actor=? AND workspace=? AND name=?""",
                (scope["tenant"], scope["user"], scope["workspace"], args.name)).fetchone()
        version = fingerprint(dict(row)) if row is not None else None
        return {"name": args.name, "exists": row is not None, "version": version, "effects": ["delete"]}

    async def delete(user, prepared, job):
        scope = job["scope"]
        with repo.transaction() as connection:
            query = """SELECT value,source,updated FROM nora_preferences
                WHERE tenant=? AND actor=? AND workspace=? AND name=?"""
            if repo.postgres:
                query += " FOR UPDATE"
            row = repo.sql(connection, query,
                (scope["tenant"], scope["user"], scope["workspace"], prepared["name"])).fetchone()
            if (row is not None) != prepared["exists"] or (row is not None and fingerprint(dict(row)) != prepared["version"]):
                return Outcome("rejected", {}, {"reason": "preference_version_changed"})
            cursor = repo.sql(connection, "DELETE FROM nora_preferences WHERE tenant=? AND actor=? AND workspace=? AND name=?",
                              (scope["tenant"], scope["user"], scope["workspace"], prepared["name"]))
            receipt_id = "preference-delete:" + job["operationId"]
            repo.sql(connection, "INSERT INTO nora_tombstones VALUES (?,?,?) ON CONFLICT DO NOTHING",
                     (receipt_id, "preference_delete_receipt", repo.clock()))
        return Outcome("succeeded", {"name": prepared["name"], "deleted": cursor.rowcount == 1},
                       {"preference": prepared["name"], "deleted": cursor.rowcount == 1,
                        "operationId": job["operationId"]})

    async def reconcile(user, prepared, job):
        with repo.transaction() as connection:
            receipt = repo.sql(connection, "SELECT id FROM nora_tombstones WHERE id=? AND kind=?",
                ("preference-delete:" + job["operationId"], "preference_delete_receipt")).fetchone()
        if receipt is not None:
            return Outcome("succeeded", {"name": prepared["name"]}, {
                "confirmedApplied": True, "operationId": job["operationId"],
            })
        return Outcome("rejected", {}, {"confirmedNotApplied": True, "reason": "delete_receipt_absent"})

    return Tool("memory_delete", "Excluir uma preferência pessoal somente após pedido explícito e revisão.",
                "nora", "R", Preference, prepare, delete, reconcile=reconcile)


def registry(repository):
    from .documents import document_tools
    from .dispatcher import web_tool
    legacy_tools = [
        Tool("tasks_query", "Buscar tarefas privadas por título, data e estado. Retorna IDs e paginação.", "tarefas", "C", TaskQuery, prepare_query, query_tasks),
        Tool("tasks_create", "Criar tarefa privada; prazo YYYY-MM-DD. Sem envio ou automação derivada.", "tarefas", "D", CreateTask, prepare_create, execute_task, reconcile=reconcile_task),
        Tool("tasks_change", "Alterar prazo, concluir ou excluir tarefa privada pelo ID. Exclusão exige revisão.", "tarefas", "D", ChangeTask, prepare_change, execute_task, reconcile=reconcile_task),
        Tool("clients_query", "Buscar cadastro de clientes por nome e somente os campos pedidos; não inclui histórico amplo.", "central", "C", Query, prepare_query, query_clients),
        Tool("finance_query", "Consultar lançamentos financeiros autorizados por descrição, com paginação.", "gastos", "C", Query, prepare_query, query_finance),
        Tool("scheduling_query", "Consultar serviços, páginas e agendamentos reais, sempre no tenant e workspace autenticados.", "agenda", "C", SchedulingQuery, prepare_scheduling, query_scheduling),
        Tool("scheduling_create_page", "Criar serviço, disponibilidade e página pública de agendamento após revisão do resumo exato.", "agenda", "R", SchedulingCreate, prepare_scheduling_create, create_scheduling_page),
        Tool("calendar_query", "Consultar eventos no intervalo absoluto informado, com cobertura explícita.", "agenda", "C", CalendarQuery, prepare_calendar_query, query_calendar),
        Tool("calendar_create", "Criar compromisso. Participantes transformam a operação em revisão de convite.", "agenda", "D", CalendarCreate, prepare_calendar_create, create_calendar_event, reconcile=reconcile_calendar_event),
        Tool("email_send", "Preparar e enviar email após revisão exata de remetente, destinatários, conteúdo e anexos.", ("emails", "integracao_gmail"), "R", Email, prepare_email, send_email),
        Tool("whatsapp_send", "Preparar e enviar texto após revisão exata de conta, destinatário e conteúdo.", ("chat", "integracao_whatsapp"), "R", WhatsAppText, prepare_whatsapp, send_whatsapp),
        *document_tools(),
    ]
    return Registry([
        *[web_tool(tool) for tool in legacy_tools],
        preference_tools(repository),
        preference_delete_tool(repository),
    ])
