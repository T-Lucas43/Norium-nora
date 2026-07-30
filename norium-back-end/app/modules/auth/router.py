"""Dominio de autenticacao extraido sem alterar as rotas publicas existentes."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import Field, field_validator

from app.shared.schemas import StrictModel

from app.core.security import (
    TokenValidationError,
    auth_secret,
    create_signed_token,
    decode_signed_token,
    hash_password,
    password_needs_rehash,
    verify_password,
)
from app.core.tenant import get_system_db_path, read_json_file, write_json_file

BASE_DIR = Path(__file__).resolve().parents[3]
USERS_DB_PATH = Path(get_system_db_path("usuarios"))
AUTH_SECRET = auth_secret()
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7
logger = logging.getLogger(__name__)

OWNER_EMAIL = "tarcisiolucas43@gmail.com"
OWNER_USER_ID = "lucas123"
OWNER_BOOTSTRAP_PASSWORD = os.getenv("NORIUM_OWNER_PASSWORD", "").strip()

router = APIRouter(prefix="/api/auth", tags=["Usuarios"])
auth_lock = asyncio.Lock()
bearer_scheme = HTTPBearer(auto_error=False)

Role = Literal["owner", "member"]
PlanCode = Literal["free", "individual", "equipe", "enterprise"]
UserStatus = Literal["ativo", "inativo"]

PERMISSION_KEYS = (
    "dashboard",
    "central",
    "emails",
    "agenda",
    "chat",
    "tarefas",
    "gastos",
    "automacoes",
    "relatorios",
    "propostas",
    "nora",
    "perfil",
    "equipe",
    "admin",
    "integracao_gmail",
    "integracao_whatsapp",
    "integracao_agenda",
    "integracao_financeiro",
)

DEFAULT_MEMBER_PERMISSIONS = {
    "dashboard": True,
    "central": True,
    "emails": False,
    "agenda": False,
    "chat": False,
    "tarefas": True,
    "gastos": False,
    "automacoes": False,
    "relatorios": False,
    "propostas": False,
    "nora": False,
    "perfil": True,
    "equipe": False,
    "admin": False,
    "integracao_gmail": False,
    "integracao_whatsapp": False,
    "integracao_agenda": False,
    "integracao_financeiro": False,
}

OWNER_PERMISSIONS = {key: True for key in PERMISSION_KEYS}

FREE_PERMISSIONS = {
    **DEFAULT_MEMBER_PERMISSIONS,
    "dashboard": True,
    "central": True,
    "tarefas": True,
    "perfil": True,
}

INDIVIDUAL_PERMISSIONS = {
    **OWNER_PERMISSIONS,
    "equipe": False,
    "admin": False,
}

EQUIPE_PERMISSIONS = {
    **OWNER_PERMISSIONS,
    "admin": False,
}

PLAN_PERMISSION_PRESETS: dict[str, dict[str, bool]] = {
    "free": FREE_PERMISSIONS,
    "individual": INDIVIDUAL_PERMISSIONS,
    "equipe": EQUIPE_PERMISSIONS,
    "enterprise": EQUIPE_PERMISSIONS,
}

PLAN_CATALOG = [
    {
        "code": "free",
        "name": "Free",
        "description": "Comece com Dashboard, Central, Perfil e Tarefas locais.",
        "teamSeats": 1,
        "monthlyPrice": 0,
        "features": ["Dashboard", "Central", "Tarefas", "Perfil"],
    },
    {
        "code": "individual",
        "name": "Individual",
        "description": "Uso proprio do Norium com modulos principais.",
        "teamSeats": 1,
        "monthlyPrice": 79,
        "features": ["Dashboard", "Nora", "E-mails", "Agenda", "Chat", "Tarefas", "Gastos", "Automacoes", "Relatorios"],
    },
    {
        "code": "equipe",
        "name": "Equipe",
        "description": "Permite criar usuarios menores e controlar acessos por modulo.",
        "teamSeats": 8,
        "monthlyPrice": 179,
        "features": ["Tudo do individual", "Modo equipe", "Permissoes por integracao", "Gestao de membros"],
    },
    {
        "code": "enterprise",
        "name": "Enterprise",
        "description": "Administracao avancada, auditoria e liberacao granular.",
        "teamSeats": 50,
        "monthlyPrice": 399,
        "features": ["Tudo do equipe", "Tema personalizado", "Admin do sistema", "Planos", "Governanca"],
    },
]


class LoginPayload(StrictModel):
    email: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=1, max_length=180)

    @field_validator("email")
    @classmethod
    def normalize_email_field(cls, value: str) -> str:
        return normalize_email(value)


class RegisterPayload(StrictModel):
    nome: str = Field(min_length=2, max_length=140)
    email: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=6, max_length=180)

    @field_validator("email")
    @classmethod
    def normalize_email_field(cls, value: str) -> str:
        return normalize_email(value)


class CreateUserPayload(StrictModel):
    nome: str = Field(min_length=2, max_length=140)
    email: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=6, max_length=180)
    role: Role = "member"
    plan: PlanCode = "individual"
    permissions: dict[str, bool] = Field(default_factory=dict)

    @field_validator("email")
    @classmethod
    def normalize_email_field(cls, value: str) -> str:
        return normalize_email(value)


class UpdateUserPayload(StrictModel):
    nome: str | None = Field(default=None, min_length=2, max_length=140)
    password: str | None = Field(default=None, min_length=6, max_length=180)
    status: UserStatus | None = None
    role: Role | None = None
    plan: PlanCode | None = None
    permissions: dict[str, bool] | None = None
    systemAdmin: bool | None = None


class SelectPlanPayload(StrictModel):
    plan: PlanCode


def normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", normalized):
        raise ValueError("E-mail invalido.")
    return normalized


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_token(user: dict[str, Any]) -> str:
    return create_signed_token(user, secret=AUTH_SECRET, ttl_seconds=TOKEN_TTL_SECONDS)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return decode_signed_token(token, secret=AUTH_SECRET)
    except TokenValidationError as exc:
        raise HTTPException(status_code=401, detail="Sessao invalida. Entre novamente.") from exc


def sanitize_permissions(permissions: dict[str, Any] | None, fallback: dict[str, bool] | None = None) -> dict[str, bool]:
    base = dict(fallback or DEFAULT_MEMBER_PERMISSIONS)
    for key, value in (permissions or {}).items():
        if key in PERMISSION_KEYS:
            base[key] = bool(value)
    return base


def is_system_owner(user: dict[str, Any]) -> bool:
    return str(user.get("email", "")).strip().lower() == OWNER_EMAIL


def sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    safe = {key: value for key, value in user.items() if key != "passwordHash"}
    safe["permissions"] = sanitize_permissions(safe.get("permissions"), OWNER_PERMISSIONS if safe.get("role") == "owner" else DEFAULT_MEMBER_PERMISSIONS)
    if is_system_owner(safe):
        safe["systemAdmin"] = True
    else:
        safe["systemAdmin"] = False
        safe["permissions"]["admin"] = False
    safe["status"] = safe.get("status", "ativo")
    safe["requiresPlanSelection"] = bool(safe.get("requiresPlanSelection", False))
    return safe


def can_manage_team(user: dict[str, Any]) -> bool:
    permissions = sanitize_permissions(user.get("permissions"), OWNER_PERMISSIONS if user.get("role") == "owner" else DEFAULT_MEMBER_PERMISSIONS)
    return bool(user.get("systemAdmin") or user.get("role") == "owner" or permissions.get("equipe") or permissions.get("admin"))


def can_manage_system(user: dict[str, Any]) -> bool:
    return is_system_owner(user)


def assert_team_plan(user: dict[str, Any]) -> None:
    if can_manage_system(user):
        return
    if user.get("plan") not in {"equipe", "enterprise"}:
        raise HTTPException(status_code=403, detail="Modo equipe exige assinatura Equipe.")


def permissions_for_plan(plan: str, *, is_owner: bool = True) -> dict[str, bool]:
    preset = PLAN_PERMISSION_PRESETS.get(plan, FREE_PERMISSIONS)
    permissions = sanitize_permissions(preset, DEFAULT_MEMBER_PERMISSIONS)
    if is_owner and plan in {"individual", "equipe", "enterprise"}:
        permissions = sanitize_permissions(preset, OWNER_PERMISSIONS)
    if plan != "equipe" and plan != "enterprise":
        permissions["equipe"] = False
    permissions["admin"] = False
    return permissions


def default_store() -> dict[str, Any]:
    created = now_iso()
    bootstrap_password = OWNER_BOOTSTRAP_PASSWORD or secrets.token_urlsafe(48)
    if not OWNER_BOOTSTRAP_PASSWORD:
        logger.warning(
            "NORIUM_OWNER_PASSWORD não configurada. A conta inicial somente poderá "
            "ser acessada após definição explícita de senha."
        )
    owner = {
        "id": OWNER_USER_ID,
        "nome": "Tarcisio Lucas",
        "email": OWNER_EMAIL,
        "passwordHash": hash_password(bootstrap_password),
        "role": "owner",
        "plan": "equipe",
        "status": "ativo",
        "systemAdmin": True,
        "teamOwnerId": None,
        "createdBy": None,
        "createdAt": created,
        "updatedAt": created,
        "lastLoginAt": None,
        "permissions": OWNER_PERMISSIONS,
        "requiresPlanSelection": False,
    }
    return {"users": [owner], "plans": PLAN_CATALOG}


def ensure_seed_user(store: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(store.get("users"), list):
        store["users"] = []
    users = store["users"]
    owner = next((user for user in users if stored_email(user) == OWNER_EMAIL), None)
    if owner is None:
        users.insert(0, default_store()["users"][0])
        return store

    owner["id"] = owner.get("id") or OWNER_USER_ID
    owner["nome"] = owner.get("nome") or "Tarcisio Lucas"
    owner["role"] = "owner"
    owner["plan"] = owner.get("plan") or "equipe"
    owner["status"] = owner.get("status") or "ativo"
    owner["systemAdmin"] = True
    owner["permissions"] = sanitize_permissions(owner.get("permissions"), OWNER_PERMISSIONS)
    owner["updatedAt"] = owner.get("updatedAt") or now_iso()
    if not owner.get("passwordHash"):
        bootstrap_password = OWNER_BOOTSTRAP_PASSWORD or secrets.token_urlsafe(48)
        owner["passwordHash"] = hash_password(bootstrap_password)
    if "plans" not in store:
        store["plans"] = PLAN_CATALOG
    return store


async def read_user_store() -> dict[str, Any]:
    def load() -> dict[str, Any]:
        if not USERS_DB_PATH.exists():
            legacy_users = BASE_DIR / "usuarios_db.json"
            if legacy_users.exists():
                payload = read_json_file(legacy_users, {})
                if isinstance(payload, dict):
                    store = ensure_seed_user(payload)
                    write_json_file(USERS_DB_PATH, store)
                    return store
            store = default_store()
            write_json_file(USERS_DB_PATH, store)
            return store
        payload = read_json_file(USERS_DB_PATH, {})
        if not isinstance(payload, dict):
            payload = default_store()
        original = copy.deepcopy(payload)
        store = ensure_seed_user(payload)
        if store != original:
            write_json_file(USERS_DB_PATH, store)
        return store

    return await asyncio.to_thread(load)


async def write_user_store(store: dict[str, Any]) -> None:
    def save() -> None:
        write_json_file(USERS_DB_PATH, ensure_seed_user(store))

    await asyncio.to_thread(save)


def find_user(store: dict[str, Any], user_id: str) -> dict[str, Any] | None:
    return next((user for user in store.get("users", []) if user.get("id") == user_id), None)


def stored_email(user: dict[str, Any]) -> str:
    try:
        return normalize_email(str(user.get("email", "")))
    except ValueError:
        return ""


def find_user_by_email(store: dict[str, Any], email: str) -> dict[str, Any] | None:
    normalized = normalize_email(email)
    return next((user for user in store.get("users", []) if stored_email(user) == normalized), None)


async def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Login necessario.")
    return await user_from_token(credentials.credentials)


async def user_from_token(token: str) -> dict[str, Any]:
    payload = decode_token(token)
    store = await read_user_store()
    user = find_user(store, str(payload.get("sub")))
    if not user or user.get("status") != "ativo":
        raise HTTPException(status_code=401, detail="Usuario inativo ou inexistente.")
    return user


def visible_users_for(current: dict[str, Any], users: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if can_manage_system(current):
        return [sanitize_user(user) for user in users]
    current_id = current["id"]
    return [
        sanitize_user(user)
        for user in users
        if user.get("id") == current_id or user.get("teamOwnerId") == current_id or user.get("createdBy") == current_id
    ]


def assert_can_touch_user(current: dict[str, Any], target: dict[str, Any]) -> None:
    if can_manage_system(current):
        return
    if target.get("teamOwnerId") == current.get("id") or target.get("createdBy") == current.get("id"):
        return
    if target.get("id") == current.get("id"):
        return
    raise HTTPException(status_code=403, detail="Voce nao pode gerenciar este usuario.")


@router.post("/login")
async def login(payload: LoginPayload) -> dict[str, Any]:
    async with auth_lock:
        store = await read_user_store()
        user = find_user_by_email(store, payload.email)
        if not user or user.get("status") != "ativo" or not verify_password(payload.password, str(user.get("passwordHash", ""))):
            raise HTTPException(status_code=401, detail="E-mail ou senha invalidos.")
        if password_needs_rehash(str(user.get("passwordHash", ""))):
            user["passwordHash"] = hash_password(payload.password)
        user["lastLoginAt"] = now_iso()
        user["updatedAt"] = now_iso()
        await write_user_store(store)
    safe_user = sanitize_user(user)
    return {
        "token": create_token(user),
        "user": safe_user,
        "availableModes": ["app", "admin"] if can_manage_system(user) else ["app"],
    }


@router.post("/register")
async def register(payload: RegisterPayload) -> dict[str, Any]:
    async with auth_lock:
        store = await read_user_store()
        if find_user_by_email(store, payload.email):
            raise HTTPException(status_code=409, detail="Ja existe usuario com este e-mail.")
        created = now_iso()
        user = {
            "id": f"usr_{secrets.token_hex(8)}",
            "nome": payload.nome.strip(),
            "email": payload.email,
            "passwordHash": hash_password(payload.password),
            "role": "owner",
            "plan": "free",
            "status": "ativo",
            "systemAdmin": False,
            "teamOwnerId": None,
            "createdBy": None,
            "createdAt": created,
            "updatedAt": created,
            "lastLoginAt": created,
            "permissions": permissions_for_plan("free"),
            "requiresPlanSelection": True,
        }
        store.setdefault("users", []).append(user)
        await write_user_store(store)
    return {
        "token": create_token(user),
        "user": sanitize_user(user),
        "availableModes": ["app"],
        "requiresPlanSelection": True,
    }


@router.post("/select-plan")
async def select_plan(payload: SelectPlanPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if is_system_owner(user):
        selected_permissions = OWNER_PERMISSIONS
    else:
        selected_permissions = permissions_for_plan(payload.plan, is_owner=user.get("role") == "owner")

    async with auth_lock:
        store = await read_user_store()
        target = find_user(store, user["id"])
        if not target:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado.")
        target["plan"] = payload.plan
        target["permissions"] = selected_permissions
        target["requiresPlanSelection"] = False
        target["updatedAt"] = now_iso()
        await write_user_store(store)
    safe_user = sanitize_user(target)
    return {
        "token": create_token(target),
        "user": safe_user,
        "availableModes": ["app", "admin"] if can_manage_system(target) else ["app"],
    }


@router.get("/me")
async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "user": sanitize_user(user),
        "availableModes": ["app", "admin"] if can_manage_system(user) else ["app"],
    }


@router.get("/plans")
async def plans(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"plans": PLAN_CATALOG}


@router.get("/users")
async def list_users(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Sem permissao para gerenciar equipe.")
    store = await read_user_store()
    return {"users": visible_users_for(user, store.get("users", []))}


@router.post("/users")
async def create_user(payload: CreateUserPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Sem permissao para criar usuarios.")
    assert_team_plan(user)

    async with auth_lock:
        store = await read_user_store()
        if find_user_by_email(store, payload.email):
            raise HTTPException(status_code=409, detail="Ja existe usuario com este e-mail.")
        created = now_iso()
        allowed_permissions = sanitize_permissions(payload.permissions, DEFAULT_MEMBER_PERMISSIONS)
        if not can_manage_system(user):
            allowed_permissions["admin"] = False
            allowed_permissions["equipe"] = False
        new_user = {
            "id": f"usr_{secrets.token_hex(8)}",
            "nome": payload.nome.strip(),
            "email": payload.email,
            "passwordHash": hash_password(payload.password),
            "role": payload.role if can_manage_system(user) else "member",
            "plan": payload.plan if can_manage_system(user) else "individual",
            "status": "ativo",
            "systemAdmin": False,
            "teamOwnerId": user["id"],
            "createdBy": user["id"],
            "createdAt": created,
            "updatedAt": created,
            "lastLoginAt": None,
            "permissions": allowed_permissions,
        }
        if not is_system_owner(new_user):
            new_user["systemAdmin"] = False
            new_user["permissions"]["admin"] = False
        store.setdefault("users", []).append(new_user)
        await write_user_store(store)
    return {"user": sanitize_user(new_user)}


@router.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UpdateUserPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Sem permissao para gerenciar usuarios.")
    async with auth_lock:
        store = await read_user_store()
        target = find_user(store, user_id)
        if not target:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado.")
        assert_can_touch_user(user, target)

        if payload.nome is not None:
            target["nome"] = payload.nome.strip()
        if payload.password:
            target["passwordHash"] = hash_password(payload.password)
        if payload.status is not None and target.get("email") != OWNER_EMAIL:
            target["status"] = payload.status
        if payload.role is not None and can_manage_system(user):
            target["role"] = payload.role
        if payload.plan is not None and can_manage_system(user):
            target["plan"] = payload.plan
        if payload.systemAdmin is not None and can_manage_system(user):
            target["systemAdmin"] = bool(payload.systemAdmin) if is_system_owner(target) else False
        if payload.permissions is not None:
            fallback = OWNER_PERMISSIONS if target.get("role") == "owner" else DEFAULT_MEMBER_PERMISSIONS
            next_permissions = sanitize_permissions(payload.permissions, fallback)
            if not can_manage_system(user):
                next_permissions["admin"] = False
                next_permissions["equipe"] = False
            if not is_system_owner(target):
                next_permissions["admin"] = False
            if target.get("email") == OWNER_EMAIL:
                next_permissions = OWNER_PERMISSIONS
            target["permissions"] = next_permissions
        target["updatedAt"] = now_iso()
        await write_user_store(store)
    return {"user": sanitize_user(target)}


@router.delete("/users/{user_id}")
async def deactivate_user(user_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Sem permissao para remover usuarios.")
    async with auth_lock:
        store = await read_user_store()
        target = find_user(store, user_id)
        if not target:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado.")
        assert_can_touch_user(user, target)
        if target.get("email") == OWNER_EMAIL:
            raise HTTPException(status_code=403, detail="O usuario principal nao pode ser removido.")
        target["status"] = "inativo"
        target["updatedAt"] = now_iso()
        await write_user_store(store)
    return {"user": sanitize_user(target)}


@router.get("/admin/overview")
async def admin_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_system(user):
        raise HTTPException(status_code=403, detail="Acesso admin restrito.")
    store = await read_user_store()
    users = [sanitize_user(item) for item in store.get("users", [])]
    active_users = [item for item in users if item.get("status") == "ativo"]
    plan_counts: dict[str, int] = {}
    for item in users:
        plan = str(item.get("plan") or "individual")
        plan_counts[plan] = plan_counts.get(plan, 0) + 1
    return {
        "totalUsers": len(users),
        "activeUsers": len(active_users),
        "teamUsers": len([item for item in users if item.get("teamOwnerId")]),
        "adminUsers": len([item for item in users if item.get("systemAdmin") or item.get("permissions", {}).get("admin")]),
        "planCounts": plan_counts,
        "plans": PLAN_CATALOG,
    }
