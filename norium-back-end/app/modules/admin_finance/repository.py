from __future__ import annotations

import asyncio
import copy
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from app.core.tenant import get_system_db_path, is_production, read_json_file, write_json_file


DB_PATH = get_system_db_path("admin_finance")
SCHEMA_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def default_plans() -> list[dict[str, Any]]:
    return [
        {
            "id": "plan_free", "code": "free", "name": "Free", "description": "Para conhecer o Norium.",
            "monthlyPriceCents": 0, "quarterlyPriceCents": 0, "semiannualPriceCents": 0,
            "annualPriceCents": 0, "lifetimePriceCents": 0, "setupFeeCents": 0,
            "cancellationFeeCents": 0, "lateFeePercentage": 0, "trialDays": 0,
            "active": True, "popular": False, "features": ["Dashboard", "Tarefas basicas"],
            "limits": {"users": 1, "noraCalls": 20, "storageMb": 100}, "internalNotes": "",
        },
        {
            "id": "plan_individual", "code": "individual", "name": "Individual", "description": "Operacao completa para uma pessoa.",
            "monthlyPriceCents": 12900, "quarterlyPriceCents": 34800, "semiannualPriceCents": 65800,
            "annualPriceCents": 118800, "lifetimePriceCents": 0, "setupFeeCents": 0,
            "cancellationFeeCents": 0, "lateFeePercentage": 2, "trialDays": 7,
            "active": True, "popular": True, "features": ["Nora", "Gmail", "Agenda", "Chat", "Tarefas", "Relatorios"],
            "limits": {"users": 1, "noraCalls": 1000, "storageMb": 5000}, "internalNotes": "",
        },
        {
            "id": "plan_equipe", "code": "equipe", "name": "Equipe", "description": "Colaboracao, permissoes e automacoes.",
            "monthlyPriceCents": 29900, "quarterlyPriceCents": 80700, "semiannualPriceCents": 152500,
            "annualPriceCents": 274800, "lifetimePriceCents": 0, "setupFeeCents": 0,
            "cancellationFeeCents": 0, "lateFeePercentage": 2, "trialDays": 14,
            "active": True, "popular": False, "features": ["Tudo do Individual", "Equipe", "Automacoes", "Brainstorm"],
            "limits": {"users": 10, "noraCalls": 5000, "storageMb": 20000}, "internalNotes": "",
        },
        {
            "id": "plan_enterprise", "code": "enterprise", "name": "Enterprise", "description": "Governanca e operacao em escala.",
            "monthlyPriceCents": 89900, "quarterlyPriceCents": 242700, "semiannualPriceCents": 458500,
            "annualPriceCents": 826800, "lifetimePriceCents": 0, "setupFeeCents": 149900,
            "cancellationFeeCents": 0, "lateFeePercentage": 2, "trialDays": 14,
            "active": True, "popular": False, "features": ["Tudo do Equipe", "White-label", "Aprovacoes", "Suporte prioritario"],
            "limits": {"users": 100, "noraCalls": 25000, "storageMb": 100000}, "internalNotes": "",
        },
    ]


def default_store() -> dict[str, Any]:
    created = now_iso()
    categories = [
        {"id": "cat_infra", "name": "Infraestrutura", "description": "Cloud, hospedagem e infraestrutura.", "active": True, "parentId": None, "color": "#3b82f6", "metadata": {}},
        {"id": "cat_marketing", "name": "Marketing", "description": "Aquisicao e comunicacao.", "active": True, "parentId": None, "color": "#8b5cf6", "metadata": {}},
        {"id": "cat_people", "name": "Pessoas", "description": "Equipe e prestadores.", "active": True, "parentId": None, "color": "#10b981", "metadata": {}},
        {"id": "cat_jorro", "name": "Jorro", "description": "Custos operacionais do provedor Jorro.", "active": True, "parentId": None, "color": "#06b6d4", "metadata": {"provider": "jorro"}},
    ]
    store: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": created,
        "updatedAt": created,
        "plans": default_plans(),
        "subscriptions": [], "payments": [], "expenses": [],
        "categories": categories,
        "suppliers": [],
        "costCenters": [{"id": "cc_admin", "name": "Administrativo", "description": "Operacao administrativa.", "active": True, "parentId": None, "color": "#64748b", "metadata": {}}],
        "providers": [{"id": "provider_jorro", "name": "Jorro", "description": "Provedor de infraestrutura e IA.", "active": True, "parentId": None, "color": "#06b6d4", "metadata": {"integrationStatus": "manual"}}],
        "goals": [], "budgets": [], "alerts": [], "auditLogs": [],
        "adminPermissions": {},
        "settings": {
            "currency": "BRL", "locale": "pt-BR", "dateFormat": "dd/MM/yyyy",
            "timezone": "America/Sao_Paulo", "defaultTaxPercentage": 0,
            "defaultPaymentFeePercentage": 0, "revenueRecognition": "cash",
            "defaultPaymentMethod": "pix", "closingDay": 1, "fiscalYearStartMonth": 1,
            "jorroProviderEnabled": False, "jorroMonthlyBudgetCents": 100000,
            "alertThresholds": [50, 75, 90, 100],
        },
    }
    if not is_production() and os.getenv("NORIUM_ADMIN_FINANCE_DEMO", "1").strip().lower() not in {"0", "false", "no"}:
        _seed_development_data(store)
    return store


def _seed_development_data(store: dict[str, Any]) -> None:
    today = date.today()
    plan_ids = ["plan_individual", "plan_equipe", "plan_enterprise"]
    customers = [("Acme Studio", "acme@example.com"), ("Orbita Consultoria", "orbita@example.com"), ("Vetor Labs", "vetor@example.com")]
    for index, ((name, email), plan_id) in enumerate(zip(customers, plan_ids, strict=True), start=1):
        subscription_id = f"demo_sub_{index}"
        store["subscriptions"].append({
            "id": subscription_id, "customerId": f"demo_customer_{index}", "customerName": name,
            "customerEmail": email, "planId": plan_id, "status": "active", "billingCycle": "monthly",
            "startedAt": (today - timedelta(days=120 - index * 10)).isoformat(),
            "currentPeriodStart": today.replace(day=1).isoformat(),
            "currentPeriodEnd": (today.replace(day=28) + timedelta(days=4)).replace(day=1).isoformat(),
            "trialEndsAt": None, "canceledAt": None, "nextBillingAt": (today + timedelta(days=10 + index)).isoformat(),
            "discountCents": 0, "discountPercentage": 0, "taxPercentage": 0,
            "paymentFeePercentage": 3.49, "notes": "Registro demonstrativo de desenvolvimento.",
        })
        gross = [12900, 29900, 89900][index - 1]
        store["payments"].append({
            "id": f"demo_payment_{index}", "subscriptionId": subscription_id,
            "customerId": f"demo_customer_{index}", "customerName": name, "planId": plan_id,
            "status": "paid", "grossCents": gross, "discountCents": 0, "refundCents": 0,
            "taxCents": 0, "feeCents": round(gross * 0.0349), "dueAt": today.isoformat(),
            "paidAt": today.isoformat(), "provider": "demo", "paymentMethod": "pix",
            "externalId": f"demo-{index}", "notes": "Pagamento demonstrativo.",
        })
    store["expenses"].extend([
        {
            "id": "demo_expense_jorro", "title": "Consumo Jorro", "description": "Custo mensal demonstrativo.",
            "amountCents": 42500, "categoryId": "cat_jorro", "subcategoryId": None,
            "supplierId": None, "costCenterId": "cc_admin", "providerId": "provider_jorro",
            "status": "paid", "expenseType": "recurring", "dueAt": today.isoformat(), "paidAt": today.isoformat(),
            "recurrence": "monthly", "recurrenceEndsAt": None, "installmentNumber": 1, "installmentCount": 1,
            "paymentMethod": "credit_card", "jorro": True, "tags": ["demo"], "attachments": [],
            "notes": "Registro demonstrativo de desenvolvimento.",
        },
        {
            "id": "demo_expense_marketing", "title": "Campanha institucional", "description": "Midia de aquisicao.",
            "amountCents": 18000, "categoryId": "cat_marketing", "subcategoryId": None,
            "supplierId": None, "costCenterId": "cc_admin", "providerId": None,
            "status": "paid", "expenseType": "variable", "dueAt": today.isoformat(), "paidAt": today.isoformat(),
            "recurrence": "none", "recurrenceEndsAt": None, "installmentNumber": 1, "installmentCount": 1,
            "paymentMethod": "pix", "jorro": False, "tags": ["demo"], "attachments": [],
            "notes": "Registro demonstrativo de desenvolvimento.",
        },
    ])


def ensure_store(payload: Any) -> dict[str, Any]:
    base = default_store()
    if not isinstance(payload, dict):
        return base
    for key, fallback in base.items():
        if key not in payload or (isinstance(fallback, list) and not isinstance(payload[key], list)):
            payload[key] = copy.deepcopy(fallback)
    payload["schemaVersion"] = SCHEMA_VERSION
    return payload


class AdminFinanceRepository:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def read(self) -> dict[str, Any]:
        async with self._lock:
            return await asyncio.to_thread(self._read_sync)

    def _read_sync(self) -> dict[str, Any]:
        payload = read_json_file(DB_PATH, None)
        if payload is None:
            payload = default_store()
            write_json_file(DB_PATH, payload)
        return ensure_store(payload)

    async def mutate(self, callback: Callable[[dict[str, Any]], Any]) -> Any:
        async with self._lock:
            def run() -> Any:
                store = self._read_sync()
                result = callback(store)
                store["updatedAt"] = now_iso()
                write_json_file(DB_PATH, store)
                return result

            return await asyncio.to_thread(run)

    async def list(self, collection: str) -> list[dict[str, Any]]:
        store = await self.read()
        return copy.deepcopy(store.get(collection, []))

    async def create(self, collection: str, payload: dict[str, Any], prefix: str) -> dict[str, Any]:
        def operation(store: dict[str, Any]) -> dict[str, Any]:
            now = now_iso()
            record = {"id": _id(prefix), **payload, "createdAt": now, "updatedAt": now}
            store[collection].append(record)
            return copy.deepcopy(record)
        return await self.mutate(operation)

    async def update(self, collection: str, record_id: str, patch: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
        def operation(store: dict[str, Any]):
            for record in store[collection]:
                if record.get("id") == record_id:
                    before = copy.deepcopy(record)
                    record.update(patch)
                    record["updatedAt"] = now_iso()
                    return before, copy.deepcopy(record)
            return None
        return await self.mutate(operation)

    async def delete(self, collection: str, record_id: str) -> dict[str, Any] | None:
        def operation(store: dict[str, Any]):
            for index, record in enumerate(store[collection]):
                if record.get("id") == record_id:
                    return copy.deepcopy(store[collection].pop(index))
            return None
        return await self.mutate(operation)

    async def audit(self, user: dict[str, Any], action: str, entity: str, entity_id: str, before: dict | None, after: dict | None) -> None:
        def operation(store: dict[str, Any]) -> None:
            store["auditLogs"].insert(0, {
                "id": _id("audit"), "timestamp": now_iso(), "userId": str(user.get("id") or ""),
                "userName": str(user.get("nome") or user.get("email") or "Administrador"),
                "action": action, "entity": entity, "entityId": entity_id,
                "before": before, "after": after,
            })
            del store["auditLogs"][1000:]
        await self.mutate(operation)


repository = AdminFinanceRepository()
