from __future__ import annotations

import asyncio
import csv
import io
import json
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.modules.auth.router import current_user
from app.core.tenant import get_user_db_path
from app.modules.operations.repository import APPROVAL_DB, AUDIT_DB, FOLLOWUP_DB, RECEIPT_DB, TEMPLATE_DB, delete_item, list_items
from app.modules.operations.schemas import (
    ApprovalCreate,
    ApprovalDecision,
    ApprovalUpdate,
    AuditCreate,
    FollowUpCreate,
    FollowUpUpdate,
    NoraMemoryCreate,
    OperationSettingsUpdate,
    OperationTemplateCreate,
    OperationTemplateUpdate,
    ReceiptCreate,
)
from app.modules.operations.panel import PanelSection, panel_section
from app.modules.operations.service import (
    create_follow_up,
    create_approval,
    create_template,
    decide_approval,
    edit_approval,
    get_operation_settings,
    global_search,
    integration_health,
    list_nora_memory,
    operations_overview,
    remove_nora_memory,
    record_audit,
    record_receipt,
    reconcile_email_send,
    save_nora_memory,
    undo_receipt,
    update_follow_up,
    update_operation_settings,
    update_template,
)


router = APIRouter(prefix="/api/operacao", tags=["Operacao e governanca"])


def _redact_sensitive(value: Any) -> Any:
    if isinstance(value, list):
        return [_redact_sensitive(item) for item in value]
    if not isinstance(value, dict):
        return value
    protected_terms = ("token", "secret", "password", "senha", "credential", "api_key", "apikey")
    sanitized: dict[str, Any] = {}
    for key, item in value.items():
        if any(term in str(key).casefold() for term in protected_terms):
            sanitized[key] = "[REMOVIDO DO BACKUP]"
        else:
            sanitized[key] = _redact_sensitive(item)
    return sanitized


@router.get("/resumo")
async def get_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await operations_overview(user)


@router.get("/painel/{section}")
async def get_panel_section(section: PanelSection, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await panel_section(user, section)


@router.get("/busca")
async def search_all(
    q: str = Query(min_length=2, max_length=120),
    limit: int = Query(default=20, ge=1, le=50),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await global_search(user, q, limit)


@router.get("/auditoria")
async def get_audit(
    limit: int = Query(default=100, ge=1, le=500),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    items = await list_items(str(user.get("id") or "lucas123"), AUDIT_DB)
    return {"items": items[:limit], "total": len(items)}


@router.get("/auditoria/exportar")
async def export_audit(user: dict[str, Any] = Depends(current_user)) -> Response:
    items = await list_items(str(user.get("id") or "lucas123"), AUDIT_DB)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=";")
    writer.writerow(["data_hora", "acao", "origem", "status", "usuario", "email", "tipo_registro", "id_registro", "descricao"])
    for item in items:
        actor = item.get("actor") if isinstance(item.get("actor"), dict) else {}
        writer.writerow([
            item.get("timestamp") or "",
            item.get("action") or "",
            item.get("source") or "",
            item.get("status") or "",
            actor.get("name") or "",
            actor.get("email") or "",
            item.get("entityType") or "",
            item.get("entityId") or "",
            item.get("description") or "",
        ])
    content = "\ufeff" + stream.getvalue()
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="norium-auditoria.csv"'},
    )


@router.post("/auditoria")
async def create_audit(payload: AuditCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await record_audit(user, payload)}


@router.get("/comprovantes")
async def get_receipts(
    limit: int = Query(default=100, ge=1, le=500),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    items = await list_items(str(user.get("id") or "lucas123"), RECEIPT_DB)
    return {"items": items[:limit], "total": len(items)}


@router.post("/comprovantes")
async def create_receipt(payload: ReceiptCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await record_receipt(user, payload)}


@router.post("/comprovantes/{receipt_id}/desfazer")
async def undo_operation(receipt_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    try:
        result = await undo_receipt(user, receipt_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Comprovante nao encontrado.")
    return result


@router.get("/aprovacoes")
async def get_approvals(
    status: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    items = await list_items(str(user.get("id") or "lucas123"), APPROVAL_DB)
    if status:
        items = [item for item in items if item.get("status") == status]
    return {"items": items, "total": len(items)}


@router.post("/aprovacoes")
async def request_approval(payload: ApprovalCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_approval(user, payload)}


@router.put("/aprovacoes/{approval_id}")
async def edit_pending_approval(
    approval_id: str,
    payload: ApprovalUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        item = await edit_approval(user, approval_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="Aprovacao pendente nao encontrada.")
    return {"item": item}


@router.patch("/aprovacoes/{approval_id}")
async def update_approval(
    approval_id: str,
    payload: ApprovalDecision,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        item = await decide_approval(user, approval_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="Aprovacao nao encontrada.")
    return {"item": item}


@router.post("/aprovacoes/{approval_id}/reconciliar")
async def reconcile_approval(
    approval_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        outcome = await reconcile_email_send(user, approval_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if outcome.get("reason") == "approval_not_found":
        raise HTTPException(status_code=404, detail="Aprovacao nao encontrada.")
    return outcome


@router.post("/integracoes/{integration_id}/testar")
async def test_integration(
    integration_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    allowed = {"gmail", "calendar", "whatsapp", "local"}
    if integration_id not in allowed:
        raise HTTPException(status_code=404, detail="Integracao nao encontrada.")
    user_id = str(user.get("id") or "lucas123")
    from app.modules.inbox.router import read_events

    events = await read_events(user_id)
    audits = await list_items(user_id, AUDIT_DB)
    integrations = await asyncio.to_thread(integration_health, user_id, events, audits)
    item = next((entry for entry in integrations if entry["id"] == integration_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Integracao nao encontrada.")
    await record_audit(
        user,
        AuditCreate(
            action="integration_health_check",
            source=integration_id,
            description=f'Teste de saude: {item["name"]}',
            status="success" if item["connected"] else "warning",
            entityType="integration",
            entityId=integration_id,
            metadata={"connected": item["connected"]},
        ),
    )
    return {"item": item, "ok": bool(item["connected"])}


@router.get("/memoria-nora")
async def get_nora_memory(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    items = await list_nora_memory(user)
    return {"items": items, "total": len(items)}


@router.post("/memoria-nora")
async def create_nora_memory(
    payload: NoraMemoryCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await save_nora_memory(user, payload)}


@router.delete("/memoria-nora/{memory_id}")
async def delete_nora_memory(
    memory_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if not await remove_nora_memory(user, memory_id):
        raise HTTPException(status_code=404, detail="Preferencia nao encontrada.")
    return {"ok": True}


@router.get("/configuracoes")
async def get_settings(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await get_operation_settings(user)}


@router.patch("/configuracoes")
async def patch_settings(
    payload: OperationSettingsUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await update_operation_settings(user, payload)}


@router.get("/modelos")
async def get_templates(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    items = await list_items(str(user.get("id") or "lucas123"), TEMPLATE_DB)
    return {"items": items, "total": len(items)}


@router.post("/modelos")
async def post_template(
    payload: OperationTemplateCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await create_template(user, payload)}


@router.patch("/modelos/{template_id}")
async def patch_template(
    template_id: str,
    payload: OperationTemplateUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_template(user, template_id, payload)
    if item is None:
        raise HTTPException(status_code=404, detail="Modelo nao encontrado.")
    return {"item": item}


@router.delete("/modelos/{template_id}")
async def remove_template(template_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    if not await delete_item(str(user.get("id") or "lucas123"), TEMPLATE_DB, template_id):
        raise HTTPException(status_code=404, detail="Modelo nao encontrado.")
    return {"ok": True}


@router.get("/acompanhamentos")
async def get_follow_ups(
    status: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    items = await list_items(str(user.get("id") or "lucas123"), FOLLOWUP_DB)
    if status:
        items = [item for item in items if item.get("status") == status]
    return {"items": items, "total": len(items)}


@router.post("/acompanhamentos")
async def post_follow_up(
    payload: FollowUpCreate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await create_follow_up(user, payload)}


@router.patch("/acompanhamentos/{follow_up_id}")
async def patch_follow_up(
    follow_up_id: str,
    payload: FollowUpUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_follow_up(user, follow_up_id, payload)
    if item is None:
        raise HTTPException(status_code=404, detail="Acompanhamento nao encontrado.")
    return {"item": item}


@router.delete("/acompanhamentos/{follow_up_id}")
async def remove_follow_up(follow_up_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    if not await delete_item(str(user.get("id") or "lucas123"), FOLLOWUP_DB, follow_up_id):
        raise HTTPException(status_code=404, detail="Acompanhamento nao encontrado.")
    return {"ok": True}


@router.get("/backup")
async def export_tenant_backup(user: dict[str, Any] = Depends(current_user)) -> Response:
    user_id = str(user.get("id") or "lucas123")
    from app.infrastructure.persistence import postgres_store
    if postgres_store.configured() or postgres_store.required():
        from app.modules.privacy.router import _build_export
        return Response(content=await asyncio.to_thread(_build_export, user), media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="norium-backup.zip"', "Cache-Control": "no-store"})
    user_dir = Path(get_user_db_path(user_id, "perfil")).parent
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if user_dir.exists():
            for path in sorted(user_dir.glob("*.json")):
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    content = json.dumps(_redact_sensitive(payload), ensure_ascii=False, indent=2)
                except (OSError, json.JSONDecodeError):
                    continue
                archive.writestr(path.name, content.encode("utf-8"))
    return Response(
        content=stream.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="norium-backup.zip"'},
    )
