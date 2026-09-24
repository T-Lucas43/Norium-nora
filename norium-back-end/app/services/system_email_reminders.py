"""Due reminders from local account data; no API/model calls and no global task scans."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from app.core.request_context import normalize_workspace_id, set_request_context, reset_request_context
from app.core.tenant import read_account_db, read_user_db, read_profile_db
from app.services import system_email as mail


def parse_date(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone(timedelta(hours=-3)))
    except (ValueError, TypeError):
        return None


def workspaces(user: dict) -> list[str]:
    account = str(user.get("teamOwnerId") or user["id"])
    platform = read_account_db(account, "plataforma", {})
    return ["primary", *sorted({str(item["id"]) for item in platform.get("workspaces", []) if isinstance(item, dict) and item.get("active", True) and item.get("id") and normalize_workspace_id(str(item["id"])) == str(item["id"]) and item["id"] != "primary"})]


def queue_due(user: dict, workspace: str, now: datetime) -> int:
    context = set_request_context("email-reminder", workspace)
    try:
        user_id = user["id"]
        tasks = read_user_db(user_id, "tarefas", {})
        tasks = tasks.get(user_id, tasks)
        finance = read_user_db(user_id, "financeiro", {})
        finance = finance.get(user_id, finance)
        from app.modules.clients.repository import list_clients
        clients = list_clients(user_id)
        local_events = read_profile_db(user_id).get("calendarLocalEvents", [])
        queued = 0
        today = now.astimezone(timezone(timedelta(hours=-3))).date()
        for task in tasks.get("tasks", []):
            if not isinstance(task, dict) or task.get("status") == "concluida" or task.get("archived") or not task.get("id"):
                continue
            due = parse_date(task.get("dueDate"))
            days = (due.date() - today).days if due else -1
            if days in {0, 1}:
                when = "hoje" if days == 0 else "amanhã"
                queued += mail.queue_notification(
                    user,
                    {
                        "id": f'email_due_{task["id"]}_{due.date()}',
                        "source": "kanban",
                        "title": f"Você tem uma tarefa com vencimento {when}",
                        "metadata": {"userId": user_id, "emailCategory": "task_due"},
                    },
                    workspace,
                    2 * 86400,
                )
        for event in local_events:
            if not isinstance(event, dict) or not event.get("id"):
                continue
            start = parse_date(event.get("inicio"))
            if start and 0 <= (start - now).total_seconds() <= 600:
                queued += mail.queue_notification(user, {"id": f'email_agenda_{event["id"]}_{start.isoformat()}', "source": "calendar", "title": "Seu compromisso começa em até 10 minutos", "metadata": {"userId": user_id, "emailCategory": "meeting_reminder"}}, workspace, max(1, (start - now).total_seconds()))
        for entry in finance.get("lancamentos", []) if isinstance(finance, dict) else []:
            if not isinstance(entry, dict) or entry.get("type") != "saida" or entry.get("status") != "pendente" or not entry.get("id"):
                continue
            due = parse_date(entry.get("dueDate"))
            days = (due.date() - today).days if due else -1
            if days in {0, 1}:
                when = "hoje" if days == 0 else "amanhã"
                queued += mail.queue_notification(
                    user,
                    {
                        "id": f'email_finance_due_{entry["id"]}_{due.date()}',
                        "source": "financeiro",
                        "title": f"Você tem uma conta a pagar com vencimento {when}",
                        "metadata": {"userId": user_id, "emailCategory": "finance_due"},
                    },
                    workspace,
                    2 * 86400,
                )
        for client in clients:
            if not isinstance(client, dict) or not client.get("id"):
                continue
            follow_up = parse_date(client.get("nextActionAt"))
            if follow_up and 0 <= (follow_up - now).total_seconds() <= 86400:
                queued += mail.queue_notification(
                    user,
                    {
                        "id": f'email_client_follow_up_{client["id"]}_{follow_up.isoformat()}',
                        "source": "clientes",
                        "title": "Você tem um acompanhamento de cliente nas próximas 24 horas",
                        "metadata": {"userId": user_id, "emailCategory": "client_follow_up"},
                    },
                    workspace,
                    max(1, (follow_up - now).total_seconds()),
                )
        return queued
    finally:
        reset_request_context(context)


async def scan() -> None:
    if not await asyncio.to_thread(mail.ready):
        return
    from app.modules.auth.router import read_user_store
    from app.modules.team.router import emit_due_meeting_reminders
    users = (await read_user_store()).get("users", [])
    teams = set()
    now = datetime.now(timezone.utc)
    for user in users:
        if user.get("status") != "ativo":
            continue
        for workspace in await asyncio.to_thread(workspaces, user):
            if user.get("emailVerifiedAt") and mail.preferences(user)["enabled"]:
                await asyncio.to_thread(queue_due, user, workspace, now)
            team = (str(user.get("teamOwnerId") or user["id"]), workspace)
            if team not in teams:
                teams.add(team)
                context = set_request_context("email-meeting-reminder", workspace)
                try:
                    await emit_due_meeting_reminders(team[0], now)
                finally:
                    reset_request_context(context)


async def worker() -> None:
    while True:
        try:
            await scan()
        except Exception:
            mail.logger.warning("system_email_reminder_scan_failed")
        await asyncio.sleep(60)
