from __future__ import annotations

import csv
import io
import json
import re
from datetime import date, datetime, timezone
from typing import Annotated, Any, Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ValidationError

from app.modules.auth.router import can_manage_system, current_user, is_system_owner
from app.modules.admin_finance.repository import now_iso, repository
from app.modules.admin_finance.schemas import (
    AdminFinanceSettings,
    AdminPermissionPatch,
    BudgetInput,
    BudgetPatch,
    BulkStatusInput,
    ExpenseInput,
    ExpensePatch,
    GoalInput,
    GoalPatch,
    ImportCommitInput,
    PaymentInput,
    PaymentPatch,
    PlanInput,
    PlanPatch,
    ReferenceInput,
    ReferencePatch,
    SubscriptionInput,
    SubscriptionPatch,
)
from app.modules.admin_finance.service import build_dashboard, cash_flow_projection


router = APIRouter(prefix="/api/admin/finance", tags=["Admin Finance"])
CurrentAdmin = Annotated[dict[str, Any], Depends(current_user)]
ModelT = TypeVar("ModelT", bound=BaseModel)

COLLECTIONS = {
    "categories": ("categories", "cat"),
    "suppliers": ("suppliers", "supplier"),
    "cost-centers": ("costCenters", "cost_center"),
    "providers": ("providers", "provider"),
}


def require_owner(user: dict[str, Any]) -> dict[str, Any]:
    if not is_system_owner(user):
        raise HTTPException(status_code=403, detail="Somente o proprietario do sistema pode gerenciar permissoes financeiras.")
    return user


async def require_permissions(user: dict[str, Any], *required: str) -> dict[str, Any]:
    """Owner bypass is explicit; assistants need each persisted action grant.

    Grants always come from the authenticated identity and the server store.
    Neither account/team ownership nor payload fields confer financial access.
    Reading grants deliberately cannot initialize or migrate a store on denial.
    """
    if not required or any(key not in AdminPermissionPatch.model_fields for key in required):
        raise HTTPException(status_code=403, detail="Operacao financeira nao autorizada.")
    if is_system_owner(user):
        return user
    if not can_manage_system(user):
        raise HTTPException(status_code=403, detail="O financeiro administrativo e exclusivo do administrador do sistema.")
    permissions = await repository.permissions_for(str(user.get("id") or ""))
    if any(permissions.get(key) is not True for key in required):
        raise HTTPException(status_code=403, detail="Permissao insuficiente para esta operacao financeira.")
    return user


def model_payload(model: BaseModel, *, exclude_unset: bool = False) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_unset=exclude_unset, exclude_none=exclude_unset)


def require_record(record: dict[str, Any] | None, label: str) -> dict[str, Any]:
    if record is None:
        raise HTTPException(status_code=404, detail=f"{label} nao encontrado.")
    return record


def filtered_page(
    items: list[dict[str, Any]],
    page: int,
    page_size: int,
    search: str,
    sort_by: str,
    sort_dir: str,
    filters: dict[str, str] | None = None,
) -> dict[str, Any]:
    filters = filters or {}
    normalized = search.strip().casefold()

    def matches(item: dict[str, Any]) -> bool:
        if normalized and normalized not in json.dumps(item, ensure_ascii=False, default=str).casefold():
            return False
        for key, value in filters.items():
            if value and value != "all" and str(item.get(key) or "") != value:
                return False
        return True

    result = [item for item in items if matches(item)]
    result.sort(key=lambda item: (item.get(sort_by) is None, str(item.get(sort_by) or "").casefold()), reverse=sort_dir == "desc")
    total = len(result)
    start = (page - 1) * page_size
    return {
        "items": result[start:start + page_size],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


async def audit(user: dict[str, Any], action: str, entity: str, entity_id: str, before: dict | None, after: dict | None) -> None:
    await repository.audit(user, action, entity, entity_id, before, after)


async def create_record(collection: str, prefix: str, model: BaseModel, user: dict[str, Any]) -> dict[str, Any]:
    record = await repository.create(collection, model_payload(model), prefix)
    await audit(user, "create", collection, record["id"], None, record)
    return record


async def patch_record(collection: str, record_id: str, model: BaseModel, user: dict[str, Any], label: str) -> dict[str, Any]:
    result = await repository.update(collection, record_id, model_payload(model, exclude_unset=True))
    if not result:
        raise HTTPException(status_code=404, detail=f"{label} nao encontrado.")
    before, after = result
    await audit(user, "update", collection, record_id, before, after)
    return after


async def delete_record(collection: str, record_id: str, user: dict[str, Any], label: str) -> dict[str, Any]:
    deleted = require_record(await repository.delete(collection, record_id), label)
    await audit(user, "delete", collection, record_id, deleted, None)
    return deleted


@router.get("/dashboard")
async def dashboard(
    user: CurrentAdmin,
    preset: str = Query("month", pattern=r"^(today|7d|30d|90d|month|quarter|semester|year)$"),
    start: str | None = None,
    end: str | None = None,
    planId: str = "all",
    status: str = "all",
    categoryId: str = "all",
    providerId: str = "all",
    paymentMethod: str = "all",
    supplierId: str = "all",
    costCenterId: str = "all",
) -> dict[str, Any]:
    await require_permissions(user, "view")
    store = await repository.read()
    return build_dashboard(store, preset, start, end, {
        "planId": planId, "status": status, "categoryId": categoryId,
        "providerId": providerId, "paymentMethod": paymentMethod,
        "supplierId": supplierId, "costCenterId": costCenterId,
    })


@router.get("/cash-flow")
async def cash_flow(user: CurrentAdmin, days: int = Query(90, ge=7, le=730)) -> dict[str, Any]:
    await require_permissions(user, "view")
    store = await repository.read()
    return {"items": cash_flow_projection(store, days), "days": days}


@router.get("/plans")
async def list_plans(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    return {"items": await repository.list("plans")}


@router.post("/plans", status_code=201)
async def create_plan(payload: PlanInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePlans")
    plans = await repository.list("plans")
    if any(item.get("code") == payload.code for item in plans):
        raise HTTPException(status_code=409, detail="Ja existe um plano com este codigo.")
    return {"item": await create_record("plans", "plan", payload, user)}


@router.post("/plans/{plan_id}/duplicate", status_code=201)
async def duplicate_plan(plan_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePlans")
    plan = next((item for item in await repository.list("plans") if item.get("id") == plan_id), None)
    source = require_record(plan, "Plano")
    payload = {key: value for key, value in source.items() if key not in {"id", "createdAt", "updatedAt"}}
    payload["code"] = f"{payload['code']}-copy-{datetime.now().strftime('%H%M%S')}"
    payload["name"] = f"{payload['name']} (copia)"
    record = await repository.create("plans", payload, "plan")
    await audit(user, "duplicate", "plans", record["id"], source, record)
    return {"item": record}


@router.patch("/plans/{plan_id}")
async def update_plan(plan_id: str, payload: PlanPatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePlans")
    return {"item": await patch_record("plans", plan_id, payload, user, "Plano")}


@router.delete("/plans/{plan_id}")
async def delete_plan(plan_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePlans")
    if any(item.get("planId") == plan_id for item in await repository.list("subscriptions")):
        raise HTTPException(status_code=409, detail="Desative o plano: existem assinaturas vinculadas a ele.")
    return {"item": await delete_record("plans", plan_id, user, "Plano")}


@router.get("/subscriptions")
async def list_subscriptions(
    user: CurrentAdmin, page: int = Query(1, ge=1), pageSize: int = Query(25, ge=1, le=200),
    search: str = "", sortBy: str = "customerName", sortDir: Literal["asc", "desc"] = "asc",
    status: str = "all", planId: str = "all",
) -> dict[str, Any]:
    await require_permissions(user, "view")
    return filtered_page(await repository.list("subscriptions"), page, pageSize, search, sortBy, sortDir, {"status": status, "planId": planId})


@router.post("/subscriptions", status_code=201)
async def create_subscription(payload: SubscriptionInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSubscriptions")
    if not any(item.get("id") == payload.planId for item in await repository.list("plans")):
        raise HTTPException(status_code=422, detail="O plano selecionado nao existe.")
    return {"item": await create_record("subscriptions", "subscription", payload, user)}


@router.patch("/subscriptions/{record_id}")
async def update_subscription(record_id: str, payload: SubscriptionPatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSubscriptions")
    return {"item": await patch_record("subscriptions", record_id, payload, user, "Assinatura")}


@router.delete("/subscriptions/{record_id}")
async def delete_subscription(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSubscriptions")
    return {"item": await delete_record("subscriptions", record_id, user, "Assinatura")}


@router.get("/payments")
async def list_payments(
    user: CurrentAdmin, page: int = Query(1, ge=1), pageSize: int = Query(25, ge=1, le=200),
    search: str = "", sortBy: str = "dueAt", sortDir: Literal["asc", "desc"] = "desc",
    status: str = "all", planId: str = "all", paymentMethod: str = "all",
) -> dict[str, Any]:
    await require_permissions(user, "view")
    return filtered_page(await repository.list("payments"), page, pageSize, search, sortBy, sortDir, {"status": status, "planId": planId, "paymentMethod": paymentMethod})


@router.post("/payments", status_code=201)
async def create_payment(payload: PaymentInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePayments")
    return {"item": await create_record("payments", "payment", payload, user)}


@router.patch("/payments/{record_id}")
async def update_payment(record_id: str, payload: PaymentPatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePayments")
    return {"item": await patch_record("payments", record_id, payload, user, "Pagamento")}


@router.delete("/payments/{record_id}")
async def delete_payment(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "managePayments")
    return {"item": await delete_record("payments", record_id, user, "Pagamento")}


@router.get("/expenses")
async def list_expenses(
    user: CurrentAdmin, page: int = Query(1, ge=1), pageSize: int = Query(25, ge=1, le=200),
    search: str = "", sortBy: str = "dueAt", sortDir: Literal["asc", "desc"] = "desc",
    status: str = "all", categoryId: str = "all", providerId: str = "all",
    supplierId: str = "all", costCenterId: str = "all", paymentMethod: str = "all",
) -> dict[str, Any]:
    await require_permissions(user, "view")
    return filtered_page(await repository.list("expenses"), page, pageSize, search, sortBy, sortDir, {
        "status": status, "categoryId": categoryId, "providerId": providerId,
        "supplierId": supplierId, "costCenterId": costCenterId, "paymentMethod": paymentMethod,
    })


@router.post("/expenses", status_code=201)
async def create_expense(payload: ExpenseInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageExpenses")
    return {"item": await create_record("expenses", "expense", payload, user)}


@router.post("/expenses/bulk-status")
async def bulk_expense_status(payload: BulkStatusInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageExpenses")
    if payload.status not in {"pending", "paid", "overdue", "canceled"}:
        raise HTTPException(status_code=422, detail="Status de despesa invalido.")

    def operation(store: dict[str, Any]) -> list[dict[str, Any]]:
        changed = []
        for item in store["expenses"]:
            if item.get("id") in payload.ids:
                item["status"] = payload.status
                if payload.status == "paid" and not item.get("paidAt"):
                    item["paidAt"] = date.today().isoformat()
                item["updatedAt"] = now_iso()
                changed.append(dict(item))
        return changed

    items = await repository.mutate(operation)
    for item in items:
        await audit(user, "bulk_status", "expenses", item["id"], None, item)
    return {"items": items, "updated": len(items)}


@router.post("/expenses/{record_id}/duplicate", status_code=201)
async def duplicate_expense(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageExpenses")
    source = require_record(next((item for item in await repository.list("expenses") if item.get("id") == record_id), None), "Despesa")
    payload = {key: value for key, value in source.items() if key not in {"id", "createdAt", "updatedAt"}}
    payload["title"] = f"{payload['title']} (copia)"
    payload["status"] = "pending"
    payload["paidAt"] = None
    record = await repository.create("expenses", payload, "expense")
    await audit(user, "duplicate", "expenses", record["id"], source, record)
    return {"item": record}


@router.patch("/expenses/{record_id}")
async def update_expense(record_id: str, payload: ExpensePatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageExpenses")
    patch = model_payload(payload, exclude_unset=True)
    if patch.get("status") == "paid" and "paidAt" not in patch:
        patch["paidAt"] = date.today().isoformat()
    result = await repository.update("expenses", record_id, patch)
    if not result:
        raise HTTPException(status_code=404, detail="Despesa nao encontrada.")
    before, after = result
    await audit(user, "update", "expenses", record_id, before, after)
    return {"item": after}


@router.delete("/expenses/{record_id}")
async def delete_expense(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageExpenses")
    return {"item": await delete_record("expenses", record_id, user, "Despesa")}


@router.get("/references/{kind}")
async def list_references(kind: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    if kind not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="Cadastro auxiliar inexistente.")
    collection, _ = COLLECTIONS[kind]
    return {"items": await repository.list(collection)}


@router.post("/references/{kind}", status_code=201)
async def create_reference(kind: str, payload: ReferenceInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    if kind not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="Cadastro auxiliar inexistente.")
    collection, prefix = COLLECTIONS[kind]
    return {"item": await create_record(collection, prefix, payload, user)}


@router.patch("/references/{kind}/{record_id}")
async def update_reference(kind: str, record_id: str, payload: ReferencePatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    if kind not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="Cadastro auxiliar inexistente.")
    collection, _ = COLLECTIONS[kind]
    return {"item": await patch_record(collection, record_id, payload, user, "Cadastro")}


@router.delete("/references/{kind}/{record_id}")
async def delete_reference(kind: str, record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    if kind not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="Cadastro auxiliar inexistente.")
    collection, _ = COLLECTIONS[kind]
    return {"item": await delete_record(collection, record_id, user, "Cadastro")}


@router.get("/goals")
async def list_goals(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    return {"items": await repository.list("goals")}


@router.post("/goals", status_code=201)
async def create_goal(payload: GoalInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await create_record("goals", "goal", payload, user)}


@router.patch("/goals/{record_id}")
async def update_goal(record_id: str, payload: GoalPatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await patch_record("goals", record_id, payload, user, "Meta")}


@router.delete("/goals/{record_id}")
async def delete_goal(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await delete_record("goals", record_id, user, "Meta")}


@router.get("/budgets")
async def list_budgets(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    return {"items": await repository.list("budgets")}


@router.post("/budgets", status_code=201)
async def create_budget(payload: BudgetInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await create_record("budgets", "budget", payload, user)}


@router.patch("/budgets/{record_id}")
async def update_budget(record_id: str, payload: BudgetPatch, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await patch_record("budgets", record_id, payload, user, "Orcamento")}


@router.delete("/budgets/{record_id}")
async def delete_budget(record_id: str, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    return {"item": await delete_record("budgets", record_id, user, "Orcamento")}


@router.get("/settings")
async def get_settings(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    return {"settings": (await repository.read())["settings"]}


@router.put("/settings")
async def update_settings(payload: AdminFinanceSettings, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "manageSettings")
    before = (await repository.read())["settings"]
    settings = model_payload(payload)
    await repository.mutate(lambda store: store.update({"settings": settings}))
    await audit(user, "update", "settings", "admin_finance", before, settings)
    return {"settings": settings}


@router.get("/audit")
async def list_audit(
    user: CurrentAdmin, page: int = Query(1, ge=1), pageSize: int = Query(25, ge=1, le=200),
    search: str = "", entity: str = "all",
) -> dict[str, Any]:
    await require_permissions(user, "view")
    return filtered_page(await repository.list("auditLogs"), page, pageSize, search, "timestamp", "desc", {"entity": entity})


@router.get("/permissions/{user_id}")
async def get_permissions(user_id: str, user: CurrentAdmin) -> dict[str, Any]:
    require_owner(user)
    permissions = (await repository.read())["adminPermissions"].get(user_id, {})
    return {"userId": user_id, "permissions": permissions}


@router.put("/permissions/{user_id}")
async def update_permissions(user_id: str, payload: AdminPermissionPatch, user: CurrentAdmin) -> dict[str, Any]:
    require_owner(user)
    permissions = model_payload(payload)
    await repository.mutate(lambda store: store["adminPermissions"].update({user_id: permissions}))
    await audit(user, "update", "adminPermissions", user_id, None, permissions)
    return {"userId": user_id, "permissions": permissions}


def parse_money(value: str) -> int:
    cleaned = re.sub(r"[^0-9,.-]", "", value.strip())
    if not cleaned:
        return 0
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    return max(0, round(float(cleaned) * 100))


def suggested_mapping(headers: list[str]) -> list[dict[str, str]]:
    aliases = {
        "titulo": "title", "descricao": "description", "valor": "amountCents",
        "categoria": "categoryId", "status": "status", "vencimento": "dueAt",
        "pagamento": "paidAt", "metodo": "paymentMethod", "cliente": "customerName",
        "plano": "planId", "bruto": "grossCents", "provedor": "providerId",
    }
    result = []
    for header in headers:
        normalized = re.sub(r"[^a-z0-9]", "", header.casefold())
        target = next((field for alias, field in aliases.items() if alias in normalized), "")
        result.append({"sourceColumn": header, "targetField": target})
    return result


@router.post("/import/preview")
async def preview_import(
    request: Request,
    user: CurrentAdmin,
    fileName: str = Query(..., min_length=1, max_length=240),
) -> dict[str, Any]:
    await require_permissions(user, "importData")
    content = await request.body()
    if len(content) > 10_000_000:
        raise HTTPException(status_code=413, detail="O arquivo deve ter no maximo 10 MB.")
    suffix = fileName.lower().rsplit(".", 1)[-1]
    rows: list[dict[str, str]] = []
    if suffix in {"xlsx", "xlsm"}:
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise HTTPException(status_code=503, detail="Suporte a Excel indisponivel no servidor.") from exc
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sheet = workbook.active
        values = list(sheet.iter_rows(values_only=True))
        headers = [str(value or "").strip() for value in (values[0] if values else [])]
        for values_row in values[1:5001]:
            rows.append({headers[index]: str(value or "") for index, value in enumerate(values_row) if index < len(headers)})
    else:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
            dialect.delimiter = ";"
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        headers = [str(item or "") for item in (reader.fieldnames or [])]
        rows = [{str(key): str(value or "") for key, value in row.items()} for _, row in zip(range(5000), reader)]
    return {"fileName": fileName, "headers": headers, "rows": rows, "sample": rows[:10], "suggestedMapping": suggested_mapping(headers), "totalRows": len(rows)}


@router.post("/import/commit")
async def commit_import(payload: ImportCommitInput, user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "importData", "manageExpenses" if payload.kind in {"expenses", "jorro"} else "managePayments")
    mapping = {item.sourceColumn: item.targetField for item in payload.mapping if item.targetField}
    collection = "expenses" if payload.kind in {"expenses", "jorro"} else "payments"
    model_type: type[BaseModel] = ExpenseInput if collection == "expenses" else PaymentInput
    created: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    categories = await repository.list("categories")
    category_by_name = {str(item.get("name", "")).casefold(): item["id"] for item in categories}
    for row_index, row in enumerate(payload.rows, start=2):
        transformed: dict[str, Any] = {}
        for source, target in mapping.items():
            raw = row.get(source, "")
            if target.endswith("Cents"):
                transformed[target] = parse_money(raw)
            else:
                transformed[target] = raw
        if payload.kind == "jorro":
            transformed.update({"jorro": True, "providerId": "provider_jorro", "categoryId": "cat_jorro"})
        if collection == "expenses":
            category = transformed.get("categoryId", "")
            fallback_category = "cat_jorro" if payload.kind == "jorro" else "cat_infra"
            transformed["categoryId"] = category_by_name.get(str(category).casefold(), category or fallback_category)
            transformed.setdefault("expenseType", "variable")
            transformed.setdefault("status", "pending")
            transformed.setdefault("dueAt", date.today().isoformat())
        else:
            transformed.setdefault("status", "pending")
            transformed.setdefault("dueAt", date.today().isoformat())
            transformed.setdefault("customerId", transformed.get("customerName") or f"import-{row_index}")
        try:
            model = model_type.model_validate(transformed)
            created.append(await repository.create(collection, model_payload(model), "expense" if collection == "expenses" else "payment"))
        except ValidationError as exc:
            errors.append({"row": row_index, "errors": exc.errors(include_url=False)})
    await audit(user, "import", collection, f"batch-{datetime.now().timestamp()}", None, {"created": len(created), "errors": len(errors), "kind": payload.kind})
    return {"created": len(created), "errors": errors[:100], "items": created[:100]}


@router.get("/jorro/status")
async def jorro_status(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "view")
    store = await repository.read()
    provider = next((item for item in store["providers"] if item.get("id") == "provider_jorro"), {})
    settings = store["settings"]
    return {
        "provider": provider, "enabled": bool(settings.get("jorroProviderEnabled")),
        "mode": "manual", "lastSyncAt": provider.get("metadata", {}).get("lastSyncAt"),
        "message": "Importacao manual e CSV disponiveis. O conector de API esta preparado para credenciais futuras.",
    }


@router.post("/jorro/sync")
async def sync_jorro(user: CurrentAdmin) -> dict[str, Any]:
    await require_permissions(user, "importData", "manageExpenses", "manageSettings")
    store = await repository.read()
    if not store["settings"].get("jorroProviderEnabled"):
        return {"connected": False, "synced": 0, "message": "Ative o provedor Jorro nas configuracoes ou importe um CSV."}
    timestamp = now_iso()

    def operation(current: dict[str, Any]) -> None:
        provider = next((item for item in current["providers"] if item.get("id") == "provider_jorro"), None)
        if provider:
            provider.setdefault("metadata", {})["lastSyncAt"] = timestamp
            provider["metadata"]["integrationStatus"] = "ready_for_api"

    await repository.mutate(operation)
    await audit(user, "sync", "providers", "provider_jorro", None, {"lastSyncAt": timestamp})
    return {"connected": False, "synced": 0, "lastSyncAt": timestamp, "message": "Interface pronta; configure o endpoint e as credenciais da API Jorro para sincronizacao automatica."}


def export_rows(store: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for payment in store.get("payments", []):
        rows.append({"tipo": "receita", "id": payment.get("id"), "descricao": payment.get("customerName"), "status": payment.get("status"), "data": payment.get("paidAt") or payment.get("dueAt"), "valor_centavos": payment.get("grossCents"), "categoria": payment.get("planId"), "provedor": payment.get("provider")})
    for expense in store.get("expenses", []):
        rows.append({"tipo": "despesa", "id": expense.get("id"), "descricao": expense.get("title"), "status": expense.get("status"), "data": expense.get("paidAt") or expense.get("dueAt"), "valor_centavos": expense.get("amountCents"), "categoria": expense.get("categoryId"), "provedor": expense.get("providerId")})
    return sorted(rows, key=lambda item: str(item.get("data") or ""), reverse=True)


@router.get("/export/{file_format}")
async def export_finance(file_format: Literal["csv", "xlsx", "pdf"], user: CurrentAdmin) -> Response:
    await require_permissions(user, "exportData")
    store = await repository.read()
    rows = export_rows(store)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M")
    if file_format == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()) if rows else ["tipo", "id", "descricao", "status", "data", "valor_centavos", "categoria", "provedor"], delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
        content = ("\ufeff" + output.getvalue()).encode("utf-8")
        return Response(content, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="norium-financeiro-{timestamp}.csv"'})
    if file_format == "xlsx":
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Font, PatternFill
        except ImportError as exc:
            raise HTTPException(status_code=503, detail="Suporte a Excel indisponivel no servidor.") from exc
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Financeiro"
        headers = list(rows[0].keys()) if rows else ["tipo", "id", "descricao", "status", "data", "valor_centavos", "categoria", "provedor"]
        sheet.append(headers)
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0B1220")
        for row in rows:
            sheet.append([row.get(header) for header in headers])
        for column in sheet.columns:
            letter = column[0].column_letter
            sheet.column_dimensions[letter].width = min(45, max(12, max(len(str(cell.value or "")) for cell in column) + 2))
        output = io.BytesIO()
        workbook.save(output)
        return Response(output.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="norium-financeiro-{timestamp}.xlsx"'})

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=landscape(A4), leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm, title="Relatorio Financeiro Norium")
    styles = getSampleStyleSheet()
    story = [Paragraph("NORIUM | Relatorio financeiro administrativo", styles["Title"]), Paragraph(f"Gerado em {datetime.now().strftime('%d/%m/%Y as %H:%M')}", styles["Normal"]), Spacer(1, 8 * mm)]
    dashboard_data = build_dashboard(store, "month", None, None, {})
    metrics = dashboard_data["metrics"]
    summary = [
        ["Receita recebida", f"R$ {metrics['receivedRevenueCents'] / 100:,.2f}", "MRR", f"R$ {metrics['mrrCents'] / 100:,.2f}"],
        ["Despesas", f"R$ {metrics['expensesCents'] / 100:,.2f}", "Lucro liquido", f"R$ {metrics['netProfitCents'] / 100:,.2f}"],
    ]
    summary_table = Table(summary, colWidths=[45 * mm, 35 * mm, 45 * mm, 35 * mm])
    summary_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAF2FF")), ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9FBCEB")), ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"), ("PADDING", (0, 0), (-1, -1), 7)]))
    story.extend([summary_table, Spacer(1, 8 * mm)])
    table_data = [["Tipo", "Descricao", "Status", "Data", "Valor", "Categoria", "Provedor"]]
    for row in rows[:250]:
        table_data.append([row["tipo"], str(row["descricao"] or "")[:44], row["status"], row["data"], f"R$ {int(row['valor_centavos'] or 0) / 100:,.2f}", row["categoria"], row["provedor"]])
    report_table = Table(table_data, repeatRows=1, colWidths=[20 * mm, 62 * mm, 24 * mm, 25 * mm, 28 * mm, 33 * mm, 30 * mm])
    report_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1220")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#CBD5E1")), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F6F9FF")]), ("FONTSIZE", (0, 0), (-1, -1), 8), ("PADDING", (0, 0), (-1, -1), 5)]))
    story.append(report_table)
    document.build(story)
    await audit(user, "export", "finance", file_format, None, {"rows": len(rows)})
    return Response(output.getvalue(), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="norium-financeiro-{timestamp}.pdf"'})
