"""Catalogo comercial versionado compartilhado por autenticacao e financeiro."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


PLAN_CATALOG_VERSION = 1
_PLANS: tuple[dict[str, Any], ...] = (
    {
        "id": "plan_free", "code": "free", "name": "Free", "description": "Para conhecer o Norium.",
        "monthlyPriceCents": 0, "quarterlyPriceCents": 0, "semiannualPriceCents": 0,
        "annualPriceCents": 0, "lifetimePriceCents": 0, "setupFeeCents": 0,
        "cancellationFeeCents": 0, "lateFeePercentage": 0, "trialDays": 0,
        "active": True, "popular": False, "features": ["Dashboard", "Central", "Tarefas", "Perfil"],
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
)


def finance_plan_catalog() -> list[dict[str, Any]]:
    return deepcopy(list(_PLANS))


def public_plan_catalog() -> list[dict[str, Any]]:
    return [
        {
            "code": plan["code"],
            "name": plan["name"],
            "description": plan["description"],
            "teamSeats": plan["limits"]["users"],
            "monthlyPrice": plan["monthlyPriceCents"] // 100,
            "features": deepcopy(plan["features"]),
            "catalogVersion": PLAN_CATALOG_VERSION,
        }
        for plan in _PLANS
    ]


def seat_limit(plan_code: str) -> int:
    plan = next((item for item in _PLANS if item["code"] == plan_code), None)
    return int(plan["limits"]["users"]) if plan else 1
