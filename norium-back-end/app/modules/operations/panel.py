"""Independent, small reads for the operational panel; integrations cannot gate it."""
from __future__ import annotations

import asyncio
from typing import Any, Literal

from app.modules.operations import service
from app.modules.operations.repository import APPROVAL_DB, AUDIT_DB, RECEIPT_DB, list_items

PanelSection = Literal["summary", "approvals", "history", "integrations", "memory"]


def _fields(item: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    return {name: item[name] for name in names if name in item}


async def panel_section(user: dict[str, Any], section: PanelSection) -> dict[str, Any]:
    user_id = str(user["id"])
    if section == "summary":
        events, tasks, finance = await asyncio.gather(
            service.read_events(user_id),
            asyncio.to_thread(service.list_tasks, user_id, status="todas"),
            asyncio.to_thread(service.list_finance, user_id),
        )
        stats = tasks.get("stats") or {}
        calendar = service._today_calendar_events(events)
        summary = {
            "activeTasks": int(stats.get("ativas") or 0),
            "overdueTasks": int(stats.get("vencidas") or 0),
            "todayEvents": len(calendar),
            "financialReminders": len(finance.get("lembretes") or []),
        }
        alerts = service._proactive_alerts(tasks.get("tasks") or [], finance, events, [], [])
        return {"generatedAt": service.now_iso(), "summary": summary,
                "briefing": service._daily_briefing(summary, alerts), "alerts": alerts}
    if section == "approvals":
        items = await list_items(user_id, APPROVAL_DB)
        pending = [item for item in items if item.get("status") == "pending"]
        fields = ("id", "title", "description", "action", "source", "status", "createdAt", "requestedBy")
        return {"approvals": [_fields(item, fields) for item in pending],
                "summary": {"pendingApprovals": len(pending)}}
    if section == "history":
        audit, receipts = await asyncio.gather(list_items(user_id, AUDIT_DB), list_items(user_id, RECEIPT_DB))
        def preview(item: dict[str, Any]) -> dict[str, Any]:
            row = _fields(item, ("id", "action", "title", "description", "status", "timestamp", "actor", "entityType", "entityId", "undoAction"))
            metadata = item.get("metadata") or {}
            row["metadata"] = {"undoneAt": metadata["undoneAt"]} if metadata.get("undoneAt") else {}
            return row
        return {"audit": [preview(item) for item in audit[:80]],
                "receipts": [preview(item) for item in receipts[:50]],
                "alerts": service._proactive_alerts([], {}, [], [], audit)}
    if section == "integrations":
        events, audits = await asyncio.gather(service.read_events(user_id), list_items(user_id, AUDIT_DB))
        integrations = await service.read_integration_health(user_id, events, audits)
        return {"integrations": integrations,
                "summary": {"unhealthyIntegrations": sum(item.get("status") != "online" for item in integrations)},
                "alerts": service._proactive_alerts([], {}, [], integrations, [])}
    return {"memory": await service.list_nora_memory(user)}
