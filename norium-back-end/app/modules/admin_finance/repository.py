from __future__ import annotations

import asyncio
import copy
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from app.core.tenant import get_system_db_path, read_json_file, write_json_file
from app.infrastructure.persistence.json_repository import PersistenceError
from app.shared.plan_catalog import finance_plan_catalog


DB_PATH = get_system_db_path("admin_finance")
SCHEMA_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def default_plans() -> list[dict[str, Any]]:
    return finance_plan_catalog()


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
            "jorroProviderEnabled": False, "jorroMonthlyBudgetCents": 0,
            "alertThresholds": [50, 75, 90, 100],
        },
    }
    return store


def _remove_legacy_demo_records(store: dict[str, Any]) -> bool:
    """Remove somente registros identificados explicitamente como demonstrativos."""
    changed = False
    for collection in ("subscriptions", "payments", "expenses"):
        records = store.get(collection)
        if not isinstance(records, list):
            continue

        def is_demo(record: Any) -> bool:
            if not isinstance(record, dict):
                return False
            record_id = str(record.get("id") or "")
            tags = record.get("tags")
            return (
                record_id.startswith("demo_")
                or str(record.get("provider") or "").lower() == "demo"
                or (isinstance(tags, list) and "demo" in tags)
            )

        filtered = [record for record in records if not is_demo(record)]
        if len(filtered) != len(records):
            store[collection] = filtered
            changed = True

    settings = store.get("settings")
    if (
        isinstance(settings, dict)
        and not settings.get("jorroProviderEnabled", False)
        and settings.get("jorroMonthlyBudgetCents") == 100000
    ):
        settings["jorroMonthlyBudgetCents"] = 0
        changed = True
    return changed


def ensure_store(payload: Any) -> dict[str, Any]:
    """Add absent legacy fields only; never replace invalid persisted values."""
    base = default_store()
    if not isinstance(payload, dict):
        raise PersistenceError(DB_PATH, "schema")
    if "schemaVersion" in payload and (type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != SCHEMA_VERSION):
        raise PersistenceError(DB_PATH, "schema")
    for key, fallback in base.items():
        if key not in payload:
            continue
        value = payload[key]
        if not isinstance(value, type(fallback)):
            raise PersistenceError(DB_PATH, "schema")
        if isinstance(fallback, list) and any(not isinstance(item, dict) for item in value):
            raise PersistenceError(DB_PATH, "schema")
    for grants in payload.get("adminPermissions", {}).values():
        if not isinstance(grants, dict) or any(type(grant) is not bool for grant in grants.values()):
            raise PersistenceError(DB_PATH, "schema")
    settings = payload.get("settings", {})
    for key, fallback in base["settings"].items():
        if key not in settings:
            continue
        expected = (int, float) if type(fallback) in (int, float) else type(fallback)
        if not isinstance(settings[key], expected) or (type(fallback) in (int, float) and type(settings[key]) is bool):
            raise PersistenceError(DB_PATH, "schema")
    # Validate before copying/defaulting so a failure also leaves callers intact.
    store = copy.deepcopy(payload)
    for key, fallback in base.items():
        store.setdefault(key, copy.deepcopy(fallback))
    return store


class AdminFinanceRepository:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def read(self) -> dict[str, Any]:
        async with self._lock:
            return await asyncio.to_thread(self._read_sync)

    async def permissions_for(self, user_id: str) -> dict[str, bool]:
        """Authorization reads cannot initialize or migrate financial data."""
        async with self._lock:
            payload = await asyncio.to_thread(read_json_file, DB_PATH, None)
            if payload is None:
                return {}
            return copy.deepcopy(ensure_store(payload)["adminPermissions"].get(user_id, {}))

    def _read_sync(self) -> dict[str, Any]:
        payload = read_json_file(DB_PATH, None)
        if payload is None:
            payload = default_store()
            write_json_file(DB_PATH, payload)
        store = ensure_store(payload)
        if _remove_legacy_demo_records(store):
            store["updatedAt"] = now_iso()
            write_json_file(DB_PATH, store)
        return store

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

    async def create(
        self,
        collection: str,
        payload: dict[str, Any],
        prefix: str,
        *,
        validate: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        def operation(store: dict[str, Any]) -> dict[str, Any]:
            candidate = copy.deepcopy(payload)
            if validate is not None:
                validate(store, candidate)
            now = now_iso()
            record = {"id": _id(prefix), **candidate, "createdAt": now, "updatedAt": now}
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
