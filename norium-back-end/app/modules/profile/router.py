"""Dominio de perfil extraido para isolar preferencias do operador."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field

from app.shared.schemas import StrictModel

from app.core.tenant import get_user_db_path, read_json_file, write_json_file
from app.routers.auth_router import auth_lock, current_user, find_user, now_iso, read_user_store, write_user_store

BASE_DIR = Path(__file__).resolve().parents[3]
PROFILE_DB_PATH = BASE_DIR / "perfil_db.json"

TemaPerfil = Literal["escuro", "claro"]

router = APIRouter(prefix="/api/perfil", tags=["Perfil"])
profile_lock = asyncio.Lock()


class ConfiguracoesNora(StrictModel):
    sarcasmo: int = Field(default=65, ge=0, le=100)


class TemaCores(StrictModel):
    primary: str = Field(default="#2563EB", pattern=r"^#[0-9A-Fa-f]{6}$")
    primaryStrong: str = Field(default="#0284C7", pattern=r"^#[0-9A-Fa-f]{6}$")
    primaryDeep: str = Field(default="#1D4ED8", pattern=r"^#[0-9A-Fa-f]{6}$")
    onPrimary: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    gradientStart: str = Field(default="#944AF7", pattern=r"^#[0-9A-Fa-f]{6}$")
    gradientMiddle: str = Field(default="#2563EB", pattern=r"^#[0-9A-Fa-f]{6}$")
    gradientEnd: str = Field(default="#0EA5E9", pattern=r"^#[0-9A-Fa-f]{6}$")
    background: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    surface: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    surfaceHover: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    border: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    text: str = Field(default="#0B234A", pattern=r"^#[0-9A-Fa-f]{6}$")
    textSecondary: str = Field(default="#46607F", pattern=r"^#[0-9A-Fa-f]{6}$")
    success: str = Field(default="#10B981", pattern=r"^#[0-9A-Fa-f]{6}$")
    warning: str = Field(default="#F59E0B", pattern=r"^#[0-9A-Fa-f]{6}$")
    danger: str = Field(default="#EF4444", pattern=r"^#[0-9A-Fa-f]{6}$")


class TemaPersonalizado(StrictModel):
    enabled: bool = False
    claro: TemaCores = Field(default_factory=TemaCores)
    escuro: TemaCores = Field(
        default_factory=lambda: TemaCores(
            primary="#BAE6FD",
            primaryStrong="#67E8F9",
            primaryDeep="#1D4ED8",
            onPrimary="#FFFFFF",
            gradientStart="#2A0B5E",
            gradientMiddle="#1D1B83",
            gradientEnd="#0284C7",
            background="#04123A",
            surface="#082360",
            surfaceHover="#124E9C",
            border="#BAE6FD",
            text="#FFFFFF",
            textSecondary="#E2F2FF",
            success="#34D399",
            warning="#FBBF24",
            danger="#FB7185",
        )
    )


class InterfacePreferences(StrictModel):
    textSize: Literal["normal", "large", "extra"] = "normal"
    reducedMotion: bool = False
    strongFocus: bool = False
    underlineLinks: bool = False
    showGuides: bool = True
    showToasts: bool = True
    toastPreview: bool = True
    toastPosition: Literal["top", "bottom"] = "top"


class PerfilOperador(StrictModel):
    interface_preferences: InterfacePreferences = Field(default_factory=InterfacePreferences)
    fotoUrl: str = ""
    nome: str = Field(default="Operador", min_length=1, max_length=120)
    cep: str = Field(default="", max_length=12)
    idioma: str = Field(default="pt-BR", min_length=2, max_length=12)
    tema: TemaPerfil = "escuro"
    tema_personalizado: TemaPersonalizado = Field(default_factory=TemaPersonalizado)
    configuracoes_nora: ConfiguracoesNora = Field(default_factory=ConfiguracoesNora)


DEFAULT_PROFILE = PerfilOperador().model_dump()
PROFILE_FIELDS = set(DEFAULT_PROFILE.keys())


def public_profile_payload(raw_profile: dict[str, Any]) -> dict[str, Any]:
    profile_data = dict(DEFAULT_PROFILE)
    for key in PROFILE_FIELDS:
        if key in raw_profile:
            profile_data[key] = raw_profile[key]
    return profile_data


def can_customize_theme(user: dict[str, Any]) -> bool:
    return bool(user.get("systemAdmin") or user.get("plan") == "enterprise")


def enforce_theme_plan(profile_payload: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    if can_customize_theme(user):
        return profile_payload
    return {**profile_payload, "tema_personalizado": DEFAULT_PROFILE["tema_personalizado"]}


async def read_profile_store() -> dict[str, Any]:
    def load() -> dict[str, Any]:
        payload = read_json_file(PROFILE_DB_PATH, None)
        if payload is None:
            payload = {"lucas123": DEFAULT_PROFILE}
            write_json_file(PROFILE_DB_PATH, payload)

        if not isinstance(payload, dict):
            return {"lucas123": DEFAULT_PROFILE}

        if "nome" in payload:
            return {"lucas123": {**DEFAULT_PROFILE, **payload}}
        return payload

    return await asyncio.to_thread(load)


async def write_profile_store(store: dict[str, Any]) -> None:
    def save() -> None:
        write_json_file(PROFILE_DB_PATH, store)

    await asyncio.to_thread(save)


def read_user_profile_sync(user_id: str) -> dict[str, Any]:
    path = get_user_db_path(user_id, "perfil")
    payload = read_json_file(path, None)
    if isinstance(payload, dict) and payload:
        return payload

    legacy_store = read_json_file(PROFILE_DB_PATH, {})
    if isinstance(legacy_store, dict):
        if "nome" in legacy_store and user_id == "lucas123":
            return {**DEFAULT_PROFILE, **legacy_store}
        if isinstance(legacy_store.get(user_id), dict):
            return {**DEFAULT_PROFILE, **legacy_store[user_id]}
    return dict(DEFAULT_PROFILE)


def write_user_profile_sync(user_id: str, profile_payload: dict[str, Any]) -> None:
    write_json_file(get_user_db_path(user_id, "perfil"), profile_payload)


@router.get("")
async def get_profile(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    raw_profile = await asyncio.to_thread(read_user_profile_sync, user["id"])
    authenticated_name = str(user.get("nome") or "").strip()
    if authenticated_name:
        raw_profile = {**raw_profile, "nome": authenticated_name}
    profile_payload = enforce_theme_plan(public_profile_payload(raw_profile), user)
    profile = PerfilOperador.model_validate(profile_payload)
    return profile.model_dump()


@router.put("")
async def save_profile(profile: PerfilOperador, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    profile_payload = enforce_theme_plan(profile.model_dump(), user)
    async with auth_lock:
        store = await read_user_store()
        account = find_user(store, user["id"])
        if account:
            account["nome"] = profile.nome.strip()
            account["updatedAt"] = now_iso()
            await write_user_store(store)
    async with profile_lock:
        existing = await asyncio.to_thread(read_user_profile_sync, user["id"])
        preserved = {
            key: value
            for key, value in existing.items()
            if key not in DEFAULT_PROFILE
        }
        await asyncio.to_thread(write_user_profile_sync, user["id"], {**profile_payload, **preserved})
    return PerfilOperador.model_validate(profile_payload).model_dump()
