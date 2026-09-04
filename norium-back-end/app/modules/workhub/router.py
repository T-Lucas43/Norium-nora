from __future__ import annotations

import csv
import io
import json
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from app.modules.auth.router import current_user
from app.modules.workhub.repository import BACKUP_DB, GOALS_DB, PUSH_DB, list_records, remove_record
from app.modules.workhub.schemas import (
    BackupRestorePayload,
    DataImportPayload,
    FocusModeUpdate,
    PushSubscriptionCreate,
    SharedInboxUpdate,
    TeamGoalCreate,
    TeamGoalUpdate,
)
from app.modules.workhub.service import (
    client_360,
    create_backup_snapshot,
    create_team_goal,
    detect_followups,
    export_data,
    get_focus_mode,
    import_data,
    list_team_goals,
    my_day,
    pending_center,
    prepare_meeting,
    register_push_subscription,
    restore_backup_snapshot,
    set_focus_mode,
    shared_inbox,
    tenant_id,
    update_shared_inbox,
    update_team_goal,
    usage_meter,
    weekly_productivity,
    weekly_summary,
)


router = APIRouter(prefix="/api/operacao", tags=["Centro de trabalho"])
clients_router = APIRouter(prefix="/api/clientes", tags=["Clientes"])


@router.get("/pendencias")
async def get_pending_center(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await pending_center(user)


@router.get("/meu-dia")
async def get_my_day(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await my_day(user)


@router.get("/inbox-compartilhada")
async def get_shared_inbox(
    status: str | None = Query(default=None),
    assigned_to: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    result = await shared_inbox(user)
    items = result["items"]
    if status:
        items = [item for item in items if item.get("status") == status]
    if assigned_to:
        items = [item for item in items if item.get("assignedToId") == assigned_to]
    return {**result, "items": items, "filtered": len(items)}


@router.patch("/inbox-compartilhada/{event_id}")
async def patch_shared_inbox(
    event_id: str,
    payload: SharedInboxUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_shared_inbox(user, event_id, payload)
    if item is None:
        raise HTTPException(status_code=404, detail="Mensagem nao encontrada.")
    return {"item": item}


@router.post("/acompanhamentos/detectar")
async def post_detect_followups(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await detect_followups(user)


@router.get("/reunioes/{event_id}/preparar")
async def get_meeting_preparation(
    event_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    result = await prepare_meeting(user, event_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Compromisso nao encontrado.")
    return result


@router.get("/metas")
async def get_goals(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await list_team_goals(user)


@router.post("/metas")
async def post_goal(
    payload: TeamGoalCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await create_team_goal(user, payload)}


@router.patch("/metas/{goal_id}")
async def patch_goal(
    goal_id: str,
    payload: TeamGoalUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_team_goal(user, goal_id, payload)
    if item is None:
        raise HTTPException(status_code=404, detail="Meta nao encontrada.")
    return {"item": item}


@router.delete("/metas/{goal_id}")
async def delete_goal(goal_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    if not await remove_record(tenant_id(user), GOALS_DB, goal_id):
        raise HTTPException(status_code=404, detail="Meta nao encontrada.")
    return {"ok": True}


@router.get("/produtividade-equipe")
async def get_team_productivity(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await weekly_productivity(user)


@router.get("/resumo-semanal")
async def get_weekly_summary(
    user: dict[str, Any] = Depends(current_user),
    include_team: bool = Query(default=True),
) -> dict[str, Any]:
    return await weekly_summary(user, include_team=include_team)


@router.get("/foco")
async def get_focus(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await get_focus_mode(user)}


@router.patch("/foco")
async def patch_focus(
    payload: FocusModeUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await set_focus_mode(user, payload)}


@router.post("/push/inscricoes")
async def post_push_subscription(
    payload: PushSubscriptionCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await register_push_subscription(
        user,
        payload.endpoint,
        payload.keys,
        payload.deviceName,
        payload.userAgent,
    )
    return {"item": {**item, "keys": {"stored": True}}}


@router.get("/push/inscricoes")
async def get_push_subscriptions(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    items = await list_records(tenant_id(user), PUSH_DB)
    sanitized = [{**item, "keys": {"stored": bool(item.get("keys"))}} for item in items]
    return {"items": sanitized, "total": len(sanitized)}


@router.delete("/push/inscricoes/{subscription_id}")
async def delete_push_subscription(
    subscription_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, bool]:
    if not await remove_record(tenant_id(user), PUSH_DB, subscription_id):
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado.")
    return {"ok": True}


@router.post("/dados/importar")
async def post_data_import(
    payload: DataImportPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await import_data(user, payload)


@router.post("/dados/importar-csv")
async def post_csv_import(
    kind: str = Query(pattern=r"^(clientes|tarefas|lancamentos)$"),
    dry_run: bool = Query(default=False),
    content: str = Body(media_type="text/csv"),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        dialect = csv.Sniffer().sniff(content[:4096], delimiters=",;")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.DictReader(io.StringIO(content), dialect=dialect))
    return await import_data(user, DataImportPayload(kind=kind, rows=rows, dryRun=dry_run))


@router.get("/dados/exportar")
async def get_data_export(
    format: str = Query(default="json", pattern=r"^(json|csv)$"),
    user: dict[str, Any] = Depends(current_user),
) -> Response:
    payload = await export_data(user)
    if format == "json":
        content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        return Response(
            content=content,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="norium-dados.json"'},
        )

    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=";")
    writer.writerow(["tipo", "id", "titulo", "status", "data", "dados"])
    collections = {
        "cliente": payload.get("clients") or [],
        "projeto": payload.get("projects") or [],
        "tarefa": payload.get("tasks") or [],
        "lancamento": (payload.get("finance") or {}).get("lancamentos") or [],
        "evento": payload.get("events") or [],
    }
    for kind, items in collections.items():
        for item in items:
            writer.writerow(
                [
                    kind,
                    item.get("id") or "",
                    item.get("title") or item.get("name") or "",
                    item.get("status") or "",
                    item.get("updatedAt") or item.get("timestamp") or item.get("createdAt") or "",
                    json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                ]
            )
    return Response(
        content=("\ufeff" + stream.getvalue()).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="norium-dados.csv"'},
    )


@router.get("/uso-plano")
async def get_usage(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await usage_meter(user)}


@router.get("/backups")
async def get_backups(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    items = await list_records(tenant_id(user), BACKUP_DB)
    return {"items": items, "total": len(items)}


@router.post("/backups")
async def post_backup(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_backup_snapshot(user)}


@router.post("/backups/{backup_id}/restaurar")
async def post_restore_backup(
    backup_id: str,
    _: BackupRestorePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await restore_backup_snapshot(user, backup_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Backup nao encontrado.")
    return {"item": item}


@clients_router.get("/{client_id}/360")
async def get_client_360(
    client_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    result = await client_360(user, client_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Cliente nao encontrado.")
    return result
