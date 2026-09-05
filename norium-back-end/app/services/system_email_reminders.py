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
        local_events = read_profile_db(user_id).get("calendarLocalEvents", [])
        queued = 0
        today = now.astimezone(timezone(timedelta(hours=-3))).date()
        for task in tasks.get("tasks", []):
            if not isinstance(task, dict) or task.get("status") == "concluida" or task.get("archived") or not task.get("id"):
                continue
            due = parse_date(task.get("dueDate"))
            if due and due.date() == today:
                queued += mail.queue_notification(user, {"id": f'email_due_{task["id"]}_{today}', "source": "kanban", "title": "Você tem uma tarefa com vencimento hoje", "metadata": {"userId": user_id}}, workspace)
        for event in local_events:
            if not isinstance(event, dict) or not event.get("id"):
                continue
            start = parse_date(event.get("inicio"))
            if start and 0 <= (start - now).total_seconds() <= 600:
                queued += mail.queue_notification(user, {"id": f'email_agenda_{event["id"]}_{start.isoformat()}', "source": "calendar", "title": "Seu compromisso começa em até 10 minutos", "metadata": {"userId": user_id}}, workspace, max(1, (start - now).total_seconds()))
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
