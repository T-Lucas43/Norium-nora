from __future__ import annotations

import asyncio
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field, field_validator

from app.modules.auth.router import assert_can_touch_user, can_manage_system, current_user, find_user, read_user_store
from app.services import ai_costs
from app.shared.schemas import StrictModel

router = APIRouter(prefix="/api/auth/admin/ai-costs", tags=["Custos de IA"])
Money = Annotated[float, Field(ge=0, le=1_000_000, allow_inf_nan=False)]


class TariffPayload(StrictModel):
    provider: Literal["groq", "google", "openai", "openai-compatible", "anthropic", "unknown"]
    model: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=120)
    baseUrl: str = Field(default="", max_length=500)
    unitTokens: int = Field(ge=1, le=1_000_000_000)
    inputUsd: Money
    outputUsd: Money
    cachedInputUsd: Money | None = None
    cacheWriteUsd: Money | None = None
    source: str = Field(default="Cadastro administrativo", max_length=500)
    validUntil: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("model", "name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Informe um valor.")
        return value.strip()

    @field_validator("baseUrl")
    @classmethod
    def no_secret_url(cls, value):
        if value:
            parts = urlsplit(value)
            if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
                raise ValueError("Use uma URL HTTPS sem credenciais, consulta ou fragmento.")
        return value.rstrip("/")


class LimitPayload(StrictModel):
    monthlyBudgetUsd: Money | None = None
    monthlyTokenLimit: int | None = Field(default=None, ge=0, le=1_000_000_000_000)


async def administrator(user=Depends(current_user)):
    if not can_manage_system(user):
        raise HTTPException(403, "Acesso admin restrito.")
    return user


@router.get("")
async def overview(month: str | None = Query(default=None, pattern=r"^(all|\d{4}-(0[1-9]|1[0-2]))$"), userId: str = "", modelId: str = "", _=Depends(administrator)):
    store = await read_user_store()
    return await asyncio.to_thread(ai_costs.overview, store.get("users", []), month or ai_costs.month_for(), userId, modelId)


@router.post("/tariffs")
async def save_tariff(payload: TariffPayload, user=Depends(administrator)):
    return {"tariff": await asyncio.to_thread(ai_costs.save_rate, payload.model_dump(), user["id"])}


@router.put("/users/{user_id}/limits")
async def save_limits(user_id: str, payload: LimitPayload, user=Depends(administrator)):
    store = await read_user_store()
    target = find_user(store, user_id)
    if not target:
        raise HTTPException(404, "Usuário não encontrado.")
    assert_can_touch_user(user, target)
    return {"limits": await asyncio.to_thread(ai_costs.save_limit, user_id, payload.model_dump(), user["id"])}
