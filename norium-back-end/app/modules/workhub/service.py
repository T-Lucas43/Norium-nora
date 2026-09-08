from __future__ import annotations

import asyncio
import json
import uuid
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from app.core.tenant import get_user_dir, read_user_db, write_user_db
from app.modules.auth.router import read_user_store, sanitize_user
from app.modules.clients.repository import list_clients, save_clients
from app.modules.inbox.router import read_events
from app.modules.operations.repository import (
    APPROVAL_DB,
    AUDIT_DB,
    FOLLOWUP_DB,
    RECEIPT_DB,
    TEMPLATE_DB,
    list_items,
    prepend_item,
)
from app.modules.operations.schemas import FollowUpCreate
from app.modules.operations.service import (
    actor_payload,
    create_follow_up,
    now_iso,
    record_audit,
)
from app.modules.operations.schemas import AuditCreate
from app.modules.workhub.repository import (
    BACKUP_DB,
    FOCUS_DB,
    GOALS_DB,
    PUSH_DB,
    SHARED_INBOX_DB,
    USAGE_DB,
    list_records,
    remove_record,
    upsert_record,
)
from app.modules.workhub.schemas import (
    DataImportPayload,
    FocusModeUpdate,
    SharedInboxUpdate,
    TeamGoalCreate,
    TeamGoalUpdate,
)
from app.services.finance_store import create_lancamento, list_finance
from app.services.task_store import create_task, list_projects, list_tasks
from app.services.wapi_binding import (
    migrate_account_binding_credentials,
    migrate_binding_file,
    restore_binding_snapshot,
)


LOCAL_TZ = timezone(timedelta(hours=-3))
ATTENTION_SOURCES = {"gmail", "whatsapp"}
DONE_TASK_STATUSES = {"concluida", "concluido"}


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def _text(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(character for character in normalized if not unicodedata.combining(character)).casefold()


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


def _metadata(item: dict[str, Any]) -> dict[str, Any]:
    value = item.get("metadata")
    return value if isinstance(value, dict) else {}


def _sort_desc(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        items,
        key=lambda item: str(
            item.get("timestamp")
            or item.get("updatedAt")
            or item.get("createdAt")
            or item.get("dueAt")
            or ""
        ),
        reverse=True,
    )


def _event_link(event: dict[str, Any]) -> dict[str, Any]:
    metadata = _metadata(event)
    source = str(event.get("source") or "")
    entity_id = (
        metadata.get("emailId")
        or metadata.get("messageId")
        or metadata.get("conversationId")
        or metadata.get("taskId")
        or metadata.get("eventId")
        or metadata.get("lancamentoId")
        or event.get("id")
    )
    tab_by_source = {
        "gmail": "E-mails",
        "whatsapp": "Chat",
        "calendar": "Agenda",
        "kanban": "Tarefas",
        "financeiro": "Gastos",
        "equipe": "Equipe",
        "automacoes": "Automações",
        "relatorios": "Relatorios",
        "clientes": "Clientes",
    }
    return {
        "tab": tab_by_source.get(source, "Central"),
        "entityType": source,
        "entityId": str(entity_id or ""),
        "metadata": metadata,
    }


async def shared_inbox(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    events, overrides = await asyncio.gather(
        read_events(user_id),
        list_records(user_id, SHARED_INBOX_DB),
    )
    return _shared_inbox_from_events(events, overrides)


def _shared_inbox_from_events(
    events: Sequence[dict[str, Any]], overrides: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    overrides_by_id = {str(item.get("eventId") or item.get("id")): item for item in overrides}
    items: list[dict[str, Any]] = []
    for event in events:
        if str(event.get("source") or "") not in ATTENTION_SOURCES:
            continue
        event_id = str(event.get("id") or "")
        metadata = _metadata(event)
        override = overrides_by_id.get(event_id, {})
        items.append(
            {
                "id": event_id,
                "eventId": event_id,
                "source": event.get("source"),
                "title": event.get("title"),
                "description": event.get("description"),
                "timestamp": event.get("timestamp"),
                "counterpart": (
                    metadata.get("from")
                    or metadata.get("sender")
                    or metadata.get("contactName")
                    or metadata.get("conversationName")
                    or ""
                ),
                "status": override.get("status") or ("novo" if metadata.get("unread", True) else "aguardando"),
                "priority": override.get("priority") or ("alta" if metadata.get("important") else "media"),
                "assignedToId": override.get("assignedToId"),
                "assignedToName": override.get("assignedToName"),
                "dueAt": override.get("dueAt"),
                "internalNotes": override.get("internalNotes") or [],
                "deepLink": _event_link(event),
                "metadata": metadata,
                "updatedAt": override.get("updatedAt") or event.get("timestamp"),
            }
        )
    status_counts: dict[str, int] = {}
    for item in items:
        status = str(item.get("status") or "novo")
        status_counts[status] = status_counts.get(status, 0) + 1
    return {"items": _sort_desc(items), "total": len(items), "statusCounts": status_counts}


async def update_shared_inbox(
    user: dict[str, Any],
    event_id: str,
    payload: SharedInboxUpdate,
) -> dict[str, Any] | None:
    user_id = tenant_id(user)
    events = await read_events(user_id)
    event = next((item for item in events if str(item.get("id") or "") == event_id), None)
    if event is None:
        return None
    records = await list_records(user_id, SHARED_INBOX_DB)
    current = next((item for item in records if str(item.get("eventId") or "") == event_id), {})
    update = payload.model_dump(exclude_none=True)
    notes = list(current.get("internalNotes") or [])
    note = update.pop("internalNote", None)
    if note:
        notes.append(
            {
                "id": f"note_{uuid.uuid4().hex}",
                "text": note,
                "createdAt": now_iso(),
                "author": actor_payload(user),
            }
        )
    record = {
        **current,
        **update,
        "id": str(current.get("id") or f"inbox_{uuid.uuid4().hex}"),
        "eventId": event_id,
        "internalNotes": notes,
        "updatedAt": now_iso(),
        "updatedBy": actor_payload(user),
    }
    await upsert_record(user_id, SHARED_INBOX_DB, record)
    await record_audit(
        user,
        AuditCreate(
            action="shared_inbox_updated",
            source=str(event.get("source") or "inbox"),
            description=f'Atendimento atualizado: {event.get("title") or event_id}.',
            status="info",
            entityType="shared_inbox",
            entityId=event_id,
            metadata={"status": record.get("status"), "assignedToId": record.get("assignedToId")},
        ),
    )
    return record


async def pending_center(user: dict[str, Any]) -> dict[str, Any]:
    from app.modules.workhub.pending import pending_overview

    return await pending_overview(user)


def pending_from_records(
    *,
    events: Sequence[dict[str, Any]] = (),
    approvals: Sequence[dict[str, Any]] = (),
    followups: Sequence[dict[str, Any]] = (),
    audits: Sequence[dict[str, Any]] = (),
    overrides: Sequence[dict[str, Any]] = (),
    tasks_payload: dict[str, Any] | None = None,
    finance: dict[str, Any] | None = None,
    integrations: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    tasks_payload = tasks_payload or {}
    finance = finance or {}
    shared = _shared_inbox_from_events(events, overrides)
    today = datetime.now(LOCAL_TZ).date()
    items: list[dict[str, Any]] = []

    def add(
        item_id: str,
        kind: str,
        title: str,
        description: str,
        severity: str,
        tab: str,
        entity_id: str = "",
        timestamp: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        items.append(
            {
                "id": item_id,
                "kind": kind,
                "title": title,
                "description": description,
                "severity": severity,
                "timestamp": timestamp or now_iso(),
                "deepLink": {
                    "tab": tab,
                    "entityType": kind,
                    "entityId": entity_id,
                    "metadata": metadata or {},
                },
            }
        )

    for approval in approvals:
        if approval.get("status") != "pending":
            continue
        add(
            str(approval.get("id")),
            "approval",
            str(approval.get("title") or "Aprovação pendente"),
            str(approval.get("description") or approval.get("action") or ""),
            "warning",
            "Controle",
            str(approval.get("id") or ""),
            approval.get("createdAt"),
        )

    for task in tasks_payload.get("tasks") or []:
        due = str(task.get("dueDate") or "")[:10]
        if not due or str(task.get("status")) in DONE_TASK_STATUSES:
            continue
        try:
            due_date = date.fromisoformat(due)
        except ValueError:
            continue
        if due_date <= today:
            overdue = due_date < today
            add(
                f'pending_{task.get("id")}',
                "task",
                str(task.get("title") or "Tarefa"),
                "Tarefa vencida." if overdue else "Tarefa vence hoje.",
                "error" if overdue else "warning",
                "Tarefas",
                str(task.get("id") or ""),
                task.get("updatedAt") or task.get("dueDate"),
                {"projectId": task.get("projectId")},
            )

    for reminder in finance.get("lembretes") or []:
        days = int(reminder.get("daysUntil") or 0)
        if days > 7:
            continue
        add(
            f'pending_finance_{reminder.get("id") or uuid.uuid4().hex}',
            "finance",
            str(reminder.get("title") or "Pagamento"),
            "Pagamento vencido." if days < 0 else f"Pagamento vence em {days} dia(s).",
            "error" if days < 0 else "warning",
            "Gastos",
            str(reminder.get("id") or ""),
            reminder.get("dueDate"),
        )

    for followup in followups:
        if followup.get("status") not in {None, "open", "snoozed"}:
            continue
        due = _parse_datetime(followup.get("dueAt"))
        if due and due.astimezone(LOCAL_TZ).date() > today + timedelta(days=2):
            continue
        add(
            f'pending_{followup.get("id")}',
            "followup",
            str(followup.get("title") or "Acompanhamento"),
            str(followup.get("description") or "Ação de acompanhamento sugerida pela Nora."),
            "warning",
            "Controle",
            str(followup.get("referenceId") or followup.get("id") or ""),
            followup.get("dueAt") or followup.get("createdAt"),
            {"channel": followup.get("channel")},
        )

    for inbox_item in shared.get("items") or []:
        if inbox_item.get("status") in {"resolvido", "arquivado"}:
            continue
        if inbox_item.get("status") == "novo" or inbox_item.get("dueAt"):
            items.append(
                {
                    "id": f'inbox_{inbox_item.get("id")}',
                    "kind": "message",
                    "title": str(inbox_item.get("title") or "Mensagem sem atendimento"),
                    "description": str(inbox_item.get("counterpart") or inbox_item.get("description") or ""),
                    "severity": "info",
                    "timestamp": inbox_item.get("updatedAt"),
                    "deepLink": inbox_item.get("deepLink"),
                }
            )

    for integration in integrations:
        if integration.get("connected"):
            continue
        add(
            f'integration_{integration.get("id")}',
            "integration",
            f'{integration.get("name")} precisa de atenção',
            str(integration.get("detail") or "Reconecte a integração."),
            "error",
            "Controle",
            str(integration.get("id") or ""),
            integration.get("lastSync"),
        )

    automation_errors = [
        item
        for item in audits
        if str(item.get("source") or "").casefold() in {"automacao", "automacoes", "automation"}
        and item.get("status") == "error"
    ]
    for error in automation_errors[:20]:
        add(
            f'automation_{error.get("id")}',
            "automation",
            "Automação com erro",
            str(error.get("description") or "Revise a execução do fluxo."),
            "error",
            "Automações",
            str(error.get("entityId") or ""),
            error.get("timestamp"),
        )

    kind_counts: dict[str, int] = {}
    for item in items:
        kind = str(item.get("kind") or "other")
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
    ordered = _sort_desc(items)
    return {
        "items": ordered,
        "total": len(ordered),
        "counts": kind_counts,
        "inboxOpen": sum(
            count for status, count in shared["statusCounts"].items()
            if status not in {"resolvido", "arquivado"}
        ),
        "generatedAt": now_iso(),
        "firstRecommended": ordered[0] if ordered else None,
    }


async def detect_followups(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    events, existing = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, FOLLOWUP_DB),
    )
    settings = read_user_db(user_id, "operacao_configuracoes", [])
    preferences = next(
        (item for item in settings if isinstance(item, dict) and item.get("id") == "preferences"),
        {},
    ) if isinstance(settings, list) else {}
    threshold = int(preferences.get("followUpHours") or 48)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=threshold)
    known = {str(item.get("referenceId") or "") for item in existing}
    candidates: list[FollowUpCreate] = []

    for event in events:
        event_id = str(event.get("id") or "")
        if not event_id or event_id in known:
            continue
        source = str(event.get("source") or "")
        metadata = _metadata(event)
        timestamp = _parse_datetime(event.get("timestamp"))
        if timestamp is None or timestamp > cutoff:
            continue
        direction = _text(metadata.get("direction") or metadata.get("folder"))
        requires_response = bool(
            metadata.get("requiresResponse")
            or metadata.get("unread")
            or "sent" in direction
            or "enviado" in direction
        )
        if source in {"gmail", "whatsapp"} and requires_response:
            candidates.append(
                FollowUpCreate(
                    title=f'Acompanhar: {event.get("title") or "conversa sem retorno"}',
                    channel=source,
                    counterpart=str(
                        metadata.get("from")
                        or metadata.get("to")
                        or metadata.get("contactName")
                        or ""
                    ),
                    dueAt=now_iso(),
                    referenceId=event_id,
                    description="A Nora identificou uma conversa parada e recomenda confirmar o próximo passo.",
                    metadata={"detectedBy": "nora", "deepLink": _event_link(event)},
                )
            )

    tasks = list_tasks(user_id, status="todas").get("tasks") or []
    today = datetime.now(LOCAL_TZ).date()
    for task in tasks:
        task_id = str(task.get("id") or "")
        if not task_id or task_id in known or str(task.get("status")) in DONE_TASK_STATUSES:
            continue
        due = str(task.get("dueDate") or "")[:10]
        if not due:
            continue
        try:
            due_date = date.fromisoformat(due)
        except ValueError:
            continue
        if due_date <= today + timedelta(days=1):
            candidates.append(
                FollowUpCreate(
                    title=f'Revisar tarefa: {task.get("title") or "sem título"}',
                    channel="task",
                    dueAt=datetime.combine(due_date, datetime.min.time(), tzinfo=LOCAL_TZ).isoformat(),
                    referenceId=task_id,
                    description="Tarefa vencida ou próxima do vencimento. A Nora recomenda revisar responsável e prazo.",
                    metadata={"projectId": task.get("projectId"), "detectedBy": "nora"},
                )
            )

    created = [await create_follow_up(user, candidate) for candidate in candidates[:100]]
    return {"items": created, "created": len(created), "checkedAt": now_iso()}


def _client_matches(client: dict[str, Any], item: dict[str, Any]) -> bool:
    terms = {
        _text(client.get("email")),
        _text(client.get("phone")),
        _text(client.get("name")),
        _text(client.get("company")),
    } - {""}
    haystack = _text(json.dumps(item, ensure_ascii=False, default=str))
    return any(term in haystack for term in terms)


async def client_360(user: dict[str, Any], client_id: str) -> dict[str, Any] | None:
    user_id = tenant_id(user)
    clients = list_clients(user_id)
    client = next((item for item in clients if str(item.get("id") or "") == client_id), None)
    if client is None:
        return None
    events, followups, receipts, audits = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, FOLLOWUP_DB),
        list_items(user_id, RECEIPT_DB),
        list_items(user_id, AUDIT_DB),
    )
    tasks = list_tasks(user_id, status="todas").get("tasks") or []
    finance_payload = list_finance(user_id)
    finance = finance_payload.get("lancamentos") or []

    channels: dict[str, list[dict[str, Any]]] = {
        "emails": [],
        "messages": [],
        "tasks": [],
        "finance": [],
        "calendar": [],
        "attachments": list(client.get("attachments") or []),
        "followUps": [],
    }
    timeline: list[dict[str, Any]] = []

    for event in events:
        if not _client_matches(client, event):
            continue
        source = str(event.get("source") or "")
        bucket = "emails" if source == "gmail" else "messages" if source == "whatsapp" else "calendar" if source == "calendar" else ""
        if bucket:
            channels[bucket].append(event)
        timeline.append(
            {
                "id": str(event.get("id") or ""),
                "type": source,
                "title": event.get("title"),
                "description": event.get("description"),
                "timestamp": event.get("timestamp"),
                "deepLink": _event_link(event),
            }
        )

    for task in tasks:
        if not _client_matches(client, task):
            continue
        channels["tasks"].append(task)
        channels["attachments"].extend(task.get("attachments") or [])
        timeline.append(
            {
                "id": str(task.get("id") or ""),
                "type": "task",
                "title": task.get("title"),
                "description": task.get("description") or task.get("status"),
                "timestamp": task.get("updatedAt") or task.get("createdAt"),
                "deepLink": {"tab": "Tarefas", "entityType": "task", "entityId": task.get("id"), "metadata": {"projectId": task.get("projectId")}},
            }
        )

    for entry in finance:
        if not _client_matches(client, entry):
            continue
        channels["finance"].append(entry)
        channels["attachments"].extend(entry.get("attachments") or [])
        timeline.append(
            {
                "id": str(entry.get("id") or ""),
                "type": "finance",
                "title": entry.get("title"),
                "description": entry.get("description") or entry.get("category"),
                "timestamp": entry.get("updatedAt") or entry.get("createdAt"),
                "deepLink": {"tab": "Gastos", "entityType": "finance", "entityId": entry.get("id"), "metadata": {}},
            }
        )

    for followup in followups:
        if not _client_matches(client, followup):
            continue
        channels["followUps"].append(followup)
        timeline.append(
            {
                "id": str(followup.get("id") or ""),
                "type": "followup",
                "title": followup.get("title"),
                "description": followup.get("description"),
                "timestamp": followup.get("updatedAt") or followup.get("createdAt"),
                "deepLink": {"tab": "Controle", "entityType": "followup", "entityId": followup.get("id"), "metadata": {}},
            }
        )

    client_audits = [
        item
        for item in audits
        if str(item.get("entityId") or "") == client_id or _client_matches(client, item)
    ]
    for item in client_audits:
        timeline.append(
            {
                "id": str(item.get("id") or ""),
                "type": "audit",
                "title": item.get("action"),
                "description": item.get("description"),
                "timestamp": item.get("timestamp"),
                "deepLink": {"tab": "Clientes", "entityType": "client", "entityId": client_id, "metadata": {}},
            }
        )

    return {
        "client": client,
        "summary": {key: len(value) for key, value in channels.items()},
        "channels": {key: _sort_desc(value) for key, value in channels.items()},
        "timeline": _sort_desc(timeline),
        "lastContactAt": (_sort_desc(timeline)[0].get("timestamp") if timeline else None),
        "generatedAt": now_iso(),
    }


async def prepare_meeting(user: dict[str, Any], event_id: str) -> dict[str, Any] | None:
    user_id = tenant_id(user)
    events = await read_events(user_id)
    meeting = next(
        (
            event
            for event in events
            if event.get("source") == "calendar"
            and (
                str(event.get("id") or "") == event_id
                or str(_metadata(event).get("eventId") or "") == event_id
            )
        ),
        None,
    )
    if meeting is None:
        return None
    metadata = _metadata(meeting)
    participant_values = metadata.get("attendees") or metadata.get("participants") or []
    participants = participant_values if isinstance(participant_values, list) else [participant_values]
    search_terms = {_text(value.get("email") if isinstance(value, dict) else value) for value in participants}
    search_terms.add(_text(meeting.get("title")))
    search_terms.discard("")

    def related(item: dict[str, Any]) -> bool:
        haystack = _text(json.dumps(item, ensure_ascii=False, default=str))
        return any(term and term in haystack for term in search_terms)

    tasks = [item for item in list_tasks(user_id, status="todas").get("tasks") or [] if related(item)]
    conversations = [item for item in events if item.get("source") in ATTENTION_SOURCES and related(item)]
    clients = [item for item in list_clients(user_id) if related(item)]
    attachments: list[dict[str, Any]] = []
    for task in tasks:
        attachments.extend(task.get("attachments") or [])
    return {
        "meeting": meeting,
        "participants": participants,
        "clients": clients[:10],
        "recentConversations": _sort_desc(conversations)[:20],
        "openTasks": [item for item in tasks if item.get("status") not in DONE_TASK_STATUSES][:20],
        "attachments": attachments[:30],
        "suggestedAgenda": [
            "Confirmar objetivo e resultado esperado.",
            "Revisar pendências anteriores.",
            "Definir responsáveis, prazos e próximo contato.",
        ],
        "generatedAt": now_iso(),
    }


async def list_team_goals(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    goals = await list_records(user_id, GOALS_DB)
    productivity = await weekly_productivity(user)
    by_user = {str(item.get("userId") or ""): item for item in productivity.get("members") or []}
    totals = productivity.get("totals") or {}
    for goal in goals:
        owner_id = str(goal.get("assignedToId") or "")
        source = by_user.get(owner_id, totals)
        metric = str(goal.get("metric") or "")
        value_by_metric = {
            "tarefas_concluidas": source.get("completedTasks", 0),
            "tempo_resposta": source.get("averageResponseMinutes", 0),
            "compromissos_realizados": source.get("calendarEvents", 0),
            "followups_concluidos": source.get("completedFollowUps", 0),
            "automacoes_executadas": source.get("automationExecutions", 0),
        }
        current = float(value_by_metric.get(metric, 0) or 0)
        target = float(goal.get("target") or 1)
        goal["current"] = current
        goal["progress"] = min(100, round((current / target) * 100, 1))
    return {"items": goals, "total": len(goals)}


async def create_team_goal(user: dict[str, Any], payload: TeamGoalCreate) -> dict[str, Any]:
    item = {
        "id": f"goal_{uuid.uuid4().hex}",
        **payload.model_dump(),
        "status": "ativa",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "createdBy": actor_payload(user),
    }
    return await upsert_record(tenant_id(user), GOALS_DB, item)


async def update_team_goal(
    user: dict[str, Any],
    goal_id: str,
    payload: TeamGoalUpdate,
) -> dict[str, Any] | None:
    records = await list_records(tenant_id(user), GOALS_DB)
    current = next((item for item in records if str(item.get("id") or "") == goal_id), None)
    if current is None:
        return None
    return await upsert_record(
        tenant_id(user),
        GOALS_DB,
        {**current, **payload.model_dump(exclude_none=True), "updatedAt": now_iso()},
    )


async def weekly_productivity(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    owner_id = str(user.get("teamOwnerId") or user_id)
    store = await read_user_store()
    members = [
        sanitize_user(item)
        for item in store.get("users", [])
        if item.get("id") == owner_id or item.get("teamOwnerId") == owner_id
    ]
    tasks = list_tasks(user_id, status="todas").get("tasks") or []
    events = await read_events(user_id)
    followups = await list_items(user_id, FOLLOWUP_DB)
    audits = await list_items(user_id, AUDIT_DB)
    start = datetime.now(timezone.utc) - timedelta(days=7)

    def recent(item: dict[str, Any]) -> bool:
        parsed = _parse_datetime(
            item.get("completedAt")
            or item.get("updatedAt")
            or item.get("timestamp")
            or item.get("createdAt")
        )
        return parsed is not None and parsed >= start

    result_members: list[dict[str, Any]] = []
    for member in members:
        member_id = str(member.get("id") or "")
        member_name = _text(member.get("nome"))
        member_tasks = [
            item for item in tasks
            if str(item.get("assigneeId") or "") == member_id
            or _text(item.get("assigneeName")) == member_name
        ]
        completed = [item for item in member_tasks if item.get("status") in DONE_TASK_STATUSES and recent(item)]
        active = [item for item in member_tasks if item.get("status") not in DONE_TASK_STATUSES]
        member_audits = [
            item for item in audits
            if str((item.get("actor") or {}).get("id") or "") == member_id and recent(item)
        ]
        messages = [
            item for item in events
            if recent(item)
            and str(_metadata(item).get("userId") or "") in {"", member_id}
            and item.get("source") in ATTENTION_SOURCES
        ]
        response_samples = [
            float(_metadata(item).get("responseMinutes"))
            for item in messages
            if str(_metadata(item).get("responseMinutes") or "").replace(".", "", 1).isdigit()
        ]
        result_members.append(
            {
                "userId": member_id,
                "name": member.get("nome"),
                "email": member.get("email"),
                "completedTasks": len(completed),
                "pendingTasks": len([item for item in active if item.get("status") == "pendente"]),
                "inProgressTasks": len([item for item in active if item.get("status") == "andamento"]),
                "reviewTasks": len([item for item in active if item.get("status") == "revisao"]),
                "overdueTasks": sum(
                    1
                    for item in active
                    if item.get("dueDate") and str(item.get("dueDate"))[:10] < datetime.now(LOCAL_TZ).date().isoformat()
                ),
                "messagesHandled": len(messages),
                "averageResponseMinutes": round(sum(response_samples) / len(response_samples), 1) if response_samples else 0,
                "calendarEvents": len([item for item in events if item.get("source") == "calendar" and recent(item)]),
                "completedFollowUps": len(
                    [
                        item
                        for item in followups
                        if item.get("status") == "done"
                        and (
                            str((item.get("completedBy") or {}).get("id") or "") in {"", member_id}
                        )
                        and recent(item)
                    ]
                ),
                "automationExecutions": len(
                    [
                        item
                        for item in member_audits
                        if str(item.get("source") or "").casefold() in {"automacao", "automacoes", "automation"}
                        and item.get("status") == "success"
                    ]
                ),
                "recentTasks": _sort_desc(member_tasks)[:8],
            }
        )

    numeric_keys = (
        "completedTasks",
        "pendingTasks",
        "inProgressTasks",
        "reviewTasks",
        "overdueTasks",
        "messagesHandled",
        "calendarEvents",
        "completedFollowUps",
        "automationExecutions",
    )
    totals = {key: sum(int(item.get(key) or 0) for item in result_members) for key in numeric_keys}
    totals["averageResponseMinutes"] = round(
        sum(float(item.get("averageResponseMinutes") or 0) for item in result_members) / max(len(result_members), 1),
        1,
    )
    return {
        "period": {"start": start.isoformat(), "end": now_iso()},
        "members": result_members,
        "totals": totals,
        "generatedAt": now_iso(),
    }


async def weekly_summary(user: dict[str, Any], *, include_team: bool = True) -> dict[str, Any]:
    # The Central header only needs aggregate activity, not every member's metrics.
    productivity = await weekly_productivity(user) if include_team else {}
    user_id = tenant_id(user)
    events, receipts, audits = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, RECEIPT_DB),
        list_items(user_id, AUDIT_DB),
    )
    period_start = _parse_datetime(productivity.get("period", {}).get("start")) or datetime.now(timezone.utc) - timedelta(days=7)
    recent_events = [item for item in events if (_parse_datetime(item.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)) >= period_start]
    recent_receipts = [item for item in receipts if (_parse_datetime(item.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)) >= period_start]
    saved_minutes = 0
    by_channel: dict[str, int] = {}
    for event in recent_events:
        source = str(event.get("source") or "sistema")
        by_channel[source] = by_channel.get(source, 0) + 1
        saved_minutes += int(_metadata(event).get("savedMinutes") or 0)
    for receipt in recent_receipts:
        saved_minutes += int(_metadata(receipt).get("savedMinutes") or 0)
    failures = [
        item
        for item in audits
        if item.get("status") == "error"
        and (_parse_datetime(item.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)) >= period_start
    ]
    return {
        **productivity,
        "eventsByChannel": by_channel,
        "actionsExecuted": len([item for item in recent_receipts if item.get("status") == "executed"]),
        "estimatedMinutesSaved": saved_minutes,
        "estimatedHoursSaved": round(saved_minutes / 60, 1),
        "failures": failures[:20],
        "headline": f"O Norium acompanhou {len(recent_events)} eventos e devolveu cerca de {saved_minutes} minutos para a equipe.",
    }


async def my_day(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    pending, events, approvals = await asyncio.gather(
        pending_center(user),
        read_events(user_id),
        list_items(user_id, APPROVAL_DB),
    )
    today = datetime.now(LOCAL_TZ).date()
    tasks = list_tasks(user_id, status="todas").get("tasks") or []
    finance = list_finance(user_id)

    calendar_items: list[dict[str, Any]] = []
    important_messages: list[dict[str, Any]] = []
    for event in events:
        timestamp = _parse_datetime(event.get("timestamp"))
        metadata = _metadata(event)
        source = str(event.get("source") or "")
        event_date = str(
            metadata.get("start")
            or metadata.get("startAt")
            or metadata.get("date")
            or (timestamp.astimezone(LOCAL_TZ).date().isoformat() if timestamp else "")
        )[:10]
        if source == "calendar" and event_date == today.isoformat():
            calendar_items.append({**event, "deepLink": _event_link(event)})
        if source in ATTENTION_SOURCES and (
            metadata.get("important")
            or metadata.get("requiresResponse")
            or metadata.get("unread")
        ):
            important_messages.append({**event, "deepLink": _event_link(event)})

    priority_tasks = [
        item
        for item in tasks
        if str(item.get("status") or "") not in DONE_TASK_STATUSES
        and (
            str(item.get("priority") or "").casefold() in {"alta", "urgente"}
            or (item.get("dueDate") and str(item.get("dueDate"))[:10] <= today.isoformat())
        )
    ]
    payment_items = [
        item
        for item in (finance.get("lembretes") or [])
        if int(item.get("daysUntil") or 0) <= 7
    ]
    pending_approvals = [item for item in approvals if item.get("status") == "pending"]
    first_step = pending.get("firstRecommended")
    if first_step is None:
        if priority_tasks:
            first_step = {
                "title": f"Comece pela tarefa: {priority_tasks[0].get('title') or 'prioritaria'}",
                "deepLink": {
                    "tab": "Tarefas",
                    "entityType": "task",
                    "entityId": str(priority_tasks[0].get("id") or ""),
                    "metadata": {"projectId": priority_tasks[0].get("projectId")},
                },
            }
        elif calendar_items:
            first_step = {
                "title": f"Prepare-se para: {calendar_items[0].get('title') or 'proximo compromisso'}",
                "deepLink": calendar_items[0]["deepLink"],
            }

    return {
        "generatedAt": now_iso(),
        "greetingName": str(user.get("nome") or "Operador").split()[0],
        "calendar": _sort_desc(calendar_items),
        "importantMessages": _sort_desc(important_messages)[:20],
        "priorityTasks": _sort_desc(priority_tasks)[:20],
        "payments": payment_items[:20],
        "approvals": pending_approvals[:20],
        "pending": pending,
        "firstRecommended": first_step,
        "counts": {
            "calendar": len(calendar_items),
            "messages": len(important_messages),
            "tasks": len(priority_tasks),
            "payments": len(payment_items),
            "approvals": len(pending_approvals),
            "pending": int(pending.get("total") or 0),
        },
    }


async def get_focus_mode(user: dict[str, Any]) -> dict[str, Any]:
    records = await list_records(tenant_id(user), FOCUS_DB)
    return next(
        (item for item in records if item.get("id") == "focus"),
        {
            "id": "focus",
            "enabled": False,
            "objective": "personalizado",
            "label": "",
            "sources": [],
            "updatedAt": None,
        },
    )


async def set_focus_mode(user: dict[str, Any], payload: FocusModeUpdate) -> dict[str, Any]:
    item = {
        "id": "focus",
        **payload.model_dump(),
        "updatedAt": now_iso(),
    }
    return await upsert_record(tenant_id(user), FOCUS_DB, item, max_items=1)


async def register_push_subscription(
    user: dict[str, Any],
    endpoint: str,
    keys: dict[str, str],
    device_name: str,
    user_agent: str,
) -> dict[str, Any]:
    item = {
        "id": f"push_{uuid.uuid5(uuid.NAMESPACE_URL, endpoint).hex}",
        "endpoint": endpoint,
        "keys": keys,
        "deviceName": device_name,
        "userAgent": user_agent,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    return await upsert_record(tenant_id(user), PUSH_DB, item)


async def import_data(user: dict[str, Any], payload: DataImportPayload) -> dict[str, Any]:
    user_id = tenant_id(user)
    validated: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, row in enumerate(payload.rows):
        try:
            if payload.kind == "clientes":
                name = str(row.get("name") or row.get("nome") or "").strip()
                if len(name) < 2:
                    raise ValueError("nome obrigatorio")
                validated.append(
                    {
                        "name": name,
                        "company": str(row.get("company") or row.get("empresa") or ""),
                        "email": str(row.get("email") or ""),
                        "phone": str(row.get("phone") or row.get("telefone") or ""),
                        "segment": str(row.get("segment") or row.get("segmento") or ""),
                        "status": str(row.get("status") or "lead"),
                        "stage": str(row.get("stage") or row.get("etapa") or "new"),
                        "tags": row.get("tags") if isinstance(row.get("tags"), list) else [],
                        "notes": str(row.get("notes") or row.get("observacoes") or ""),
                    }
                )
            elif payload.kind == "tarefas":
                title = str(row.get("title") or row.get("titulo") or "").strip()
                if len(title) < 2:
                    raise ValueError("titulo obrigatorio")
                validated.append(
                    {
                        "title": title,
                        "description": str(row.get("description") or row.get("descricao") or ""),
                        "projectId": str(row.get("projectId") or "default"),
                        "category": str(row.get("category") or row.get("categoria") or "geral"),
                        "priority": str(row.get("priority") or row.get("prioridade") or "media"),
                        "status": str(row.get("status") or "pendente"),
                        "dueDate": row.get("dueDate") or row.get("vencimento"),
                    }
                )
            else:
                title = str(row.get("title") or row.get("titulo") or "").strip()
                amount = float(row.get("amount") or row.get("valor") or 0)
                if len(title) < 2 or amount <= 0:
                    raise ValueError("titulo e valor positivo sao obrigatorios")
                validated.append(
                    {
                        "title": title,
                        "description": str(row.get("description") or row.get("descricao") or ""),
                        "type": str(row.get("type") or row.get("tipo") or "saida"),
                        "amount": amount,
                        "category": str(row.get("category") or row.get("categoria") or "geral"),
                        "status": str(row.get("status") or "pendente"),
                        "dueDate": row.get("dueDate") or row.get("vencimento"),
                    }
                )
        except (TypeError, ValueError) as exc:
            errors.append({"row": index + 1, "error": str(exc)})

    created: list[dict[str, Any]] = []
    if not payload.dryRun and not errors:
        if payload.kind == "clientes":
            clients = list_clients(user_id)
            timestamp = now_iso()
            for item in validated:
                created.append(
                    {
                        "id": f"client_{uuid.uuid4().hex}",
                        **item,
                        "ownerId": user_id,
                        "ownerName": str(user.get("nome") or ""),
                        "nextActionAt": None,
                        "createdAt": timestamp,
                        "updatedAt": timestamp,
                    }
                )
            await save_clients(user_id, [*created, *clients])
        elif payload.kind == "tarefas":
            created = [create_task(user_id, item) for item in validated]
        else:
            created = [create_lancamento(user_id, item) for item in validated]
        await record_audit(
            user,
            AuditCreate(
                action="data_imported",
                source="workhub",
                description=f"{len(created)} registro(s) importado(s) em {payload.kind}.",
                status="success",
                entityType="data_import",
                metadata={"kind": payload.kind, "count": len(created)},
            ),
        )
    return {
        "kind": payload.kind,
        "dryRun": payload.dryRun,
        "valid": len(validated),
        "created": len(created),
        "errors": errors,
        "preview": validated[:20],
    }


async def export_data(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    events, approvals, receipts, followups, templates, goals, shared = await asyncio.gather(
        read_events(user_id),
        list_items(user_id, APPROVAL_DB),
        list_items(user_id, RECEIPT_DB),
        list_items(user_id, FOLLOWUP_DB),
        list_items(user_id, TEMPLATE_DB),
        list_records(user_id, GOALS_DB),
        list_records(user_id, SHARED_INBOX_DB),
    )
    return {
        "exportedAt": now_iso(),
        "tenantId": user_id,
        "clients": list_clients(user_id),
        "projects": list_projects(user_id).get("projects") or [],
        "tasks": list_tasks(user_id, status="todas").get("tasks") or [],
        "finance": list_finance(user_id),
        "events": events,
        "approvals": approvals,
        "receipts": receipts,
        "followUps": followups,
        "templates": templates,
        "goals": goals,
        "sharedInbox": shared,
    }


async def usage_meter(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    events, receipts = await asyncio.gather(read_events(user_id), list_items(user_id, RECEIPT_DB))
    user_dir = get_user_dir(user_id)
    storage_bytes = await asyncio.to_thread(
        lambda: sum(path.stat().st_size for path in user_dir.rglob("*") if path.is_file())
    )
    try:
        from app.routers.automacoes_router import read_store

        automations = read_store(user_id).get("automations") or []
    except Exception:
        automations = []
    profile = read_user_db(user_id, "perfil", {})
    integrations = sum(
        1
        for key in ("gmailToken", "calendarToken")
        if isinstance(profile, dict) and profile.get(key)
    )
    def actor_id(item: dict[str, Any]) -> str:
        actor = item.get("actor")
        return str(actor.get("id") or "") if isinstance(actor, dict) else ""

    result = {
        "id": "current",
        "period": datetime.now(LOCAL_TZ).strftime("%Y-%m"),
        "noraActions": len([item for item in receipts if actor_id(item) == user_id]),
        "events": len(events),
        "automations": len(automations),
        "automationExecutions": sum(int(item.get("executions") or 0) for item in automations),
        "integrations": integrations,
        "storageBytes": storage_bytes,
        "storageMb": round(storage_bytes / (1024 * 1024), 2),
        "updatedAt": now_iso(),
    }
    await upsert_record(user_id, USAGE_DB, result, max_items=24)
    return result


async def create_backup_snapshot(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    source_dir = get_user_dir(user_id)
    # Nunca replique um binding legado: saneia o arquivo ativo e snapshots
    # históricos antes que qualquer byte seja copiado para um novo backup.
    migrate_account_binding_credentials(user_id, include_backups=True)
    backup_id = f"backup_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    backup_dir = source_dir / "backups" / backup_id
    backup_dir.mkdir(parents=True, exist_ok=True)
    files: list[str] = []
    for source in source_dir.glob("*.json"):
        target = backup_dir / source.name
        target.write_bytes(source.read_bytes())
        files.append(source.name)
    item = {
        "id": backup_id,
        "createdAt": now_iso(),
        "files": files,
        "sizeBytes": sum((backup_dir / name).stat().st_size for name in files),
        "status": "ready",
    }
    await upsert_record(user_id, BACKUP_DB, item, max_items=30)
    return item


async def restore_backup_snapshot(user: dict[str, Any], backup_id: str) -> dict[str, Any] | None:
    user_id = tenant_id(user)
    backups = await list_records(user_id, BACKUP_DB)
    backup = next((item for item in backups if str(item.get("id") or "") == backup_id), None)
    if backup is None:
        return None
    user_dir = get_user_dir(user_id)
    backup_dir = user_dir / "backups" / backup_id
    if not backup_dir.exists():
        return None
    # Um snapshot criado por versão antiga pode conter o formato legado. Migre
    # a origem primeiro para que nem mesmo a janela de restauração grave texto puro.
    migrate_binding_file(backup_dir / "wapi_instance_db.json")
    restored: list[str] = []
    for source in backup_dir.glob("*.json"):
        target = user_dir / source.name
        if source.name == "wapi_instance_db.json":
            restore_binding_snapshot(user_id, source)
        else:
            target.write_bytes(source.read_bytes())
        restored.append(source.name)
    migrate_account_binding_credentials(user_id, include_backups=False)
    await record_audit(
        user,
        AuditCreate(
            action="backup_restored",
            source="workhub",
            description=f"Backup {backup_id} restaurado.",
            status="warning",
            entityType="backup",
            entityId=backup_id,
            metadata={"files": restored},
        ),
    )
    return {**backup, "restoredAt": now_iso(), "restoredFiles": restored}
