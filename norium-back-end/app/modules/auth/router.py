"""Dominio de autenticacao extraido sem alterar as rotas publicas existentes."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
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
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.request_context import normalize_workspace_id
from app.core.tenant import get_system_db_path, read_account_db, read_json_file, write_json_file

BASE_DIR = Path(__file__).resolve().parents[3]
USERS_DB_PATH = Path(get_system_db_path("usuarios"))
AUTH_SECRET = auth_secret()
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7
logger = logging.getLogger(__name__)

OWNER_EMAIL = os.getenv("NORIUM_BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
OWNER_USER_ID = os.getenv("NORIUM_BOOTSTRAP_ADMIN_USER_ID", "norium-admin").strip() or "norium-admin"
OWNER_NAME = os.getenv("NORIUM_BOOTSTRAP_ADMIN_NAME", "Administrador Norium").strip() or "Administrador Norium"
OWNER_BOOTSTRAP_PASSWORD = os.getenv("NORIUM_BOOTSTRAP_ADMIN_PASSWORD", "").strip()
LEGAL_VERSION = "2026-08-20"

router = APIRouter(prefix="/api/auth", tags=["Usuarios"])
auth_lock = asyncio.Lock()
bearer_scheme = HTTPBearer(auto_error=False)
login_limiter = SlidingWindowRateLimiter(limit=8, window_seconds=15 * 60)
register_limiter = SlidingWindowRateLimiter(limit=4, window_seconds=60 * 60)
websocket_ticket_lock = asyncio.Lock()
websocket_tickets: dict[str, dict[str, Any]] = {}
WEBSOCKET_TICKET_TTL_SECONDS = 45

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
    acceptedTerms: bool = False
    acceptedPrivacy: bool = False

    @field_validator("email")
    @classmethod
    def normalize_email_field(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("password")
    @classmethod
    def secure_password(cls, value: str) -> str:
        if len(value) < 10:
            raise ValueError("A senha deve ter pelo menos 10 caracteres.")
        return value


class CreateUserPayload(StrictModel):
    nome: str = Field(min_length=2, max_length=140)
    email: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=6, max_length=180)
    role: Role = "member"
    plan: PlanCode = "individual"
    permissions: dict[str, bool] = Field(default_factory=dict)
    teamOwnerId: str | None = Field(default=None, max_length=160)

    @field_validator("email")
    @classmethod
    def normalize_email_field(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("password")
    @classmethod
    def secure_password(cls, value: str) -> str:
        if len(value) < 10:
            raise ValueError("A senha deve ter pelo menos 10 caracteres.")
        return value


class UpdateUserPayload(StrictModel):
    nome: str | None = Field(default=None, min_length=2, max_length=140)
    password: str | None = Field(default=None, min_length=6, max_length=180)
    status: UserStatus | None = None
    role: Role | None = None
    plan: PlanCode | None = None
    permissions: dict[str, bool] | None = None
    systemAdmin: bool | None = None
    teamOwnerId: str | None = Field(default=None, max_length=160)

    @field_validator("password")
    @classmethod
    def secure_password(cls, value: str | None) -> str | None:
        if value is not None and len(value) < 10:
            raise ValueError("A senha deve ter pelo menos 10 caracteres.")
        return value


class TeamProfilePayload(StrictModel):
    name: str = Field(min_length=2, max_length=140)


class SelectPlanPayload(StrictModel):
    plan: PlanCode


class ChangePasswordPayload(StrictModel):
    currentPassword: str = Field(min_length=1, max_length=180)
    newPassword: str = Field(min_length=10, max_length=180)


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
    return bool(user.get("systemAdmin"))


def effective_permissions(user: dict[str, Any]) -> dict[str, bool]:
    if is_system_owner(user):
        return dict(OWNER_PERMISSIONS)
    plan = str(user.get("plan") or "free")
    entitlements = permissions_for_plan(plan, is_owner=user.get("role") == "owner")
    configured = sanitize_permissions(
        user.get("permissions"),
        OWNER_PERMISSIONS if user.get("role") == "owner" else DEFAULT_MEMBER_PERMISSIONS,
    )
    result = {key: bool(configured.get(key) and entitlements.get(key)) for key in PERMISSION_KEYS}
    result["admin"] = False
    return result


ROUTE_PERMISSIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("/api/emails/gmail", ("emails", "integracao_gmail")),
    ("/api/emails", ("emails",)),
    ("/api/integracoes/google", ("agenda", "integracao_agenda")),
    ("/api/agenda", ("agenda",)),
    ("/api/chat", ("chat",)),
    ("/api/financeiro", ("gastos",)),
    ("/api/tarefas", ("tarefas",)),
    ("/api/automacoes", ("automacoes",)),
    ("/api/nora", ("nora",)),
    ("/api/comercial", ("propostas",)),
    ("/api/brainstorm", ("equipe",)),
    ("/api/team-chat", ("equipe",)),
    ("/api/plataforma", ("equipe",)),
    ("/api/clientes", ("central",)),
    ("/api/operacao", ("dashboard",)),
    ("/api/omnichannel", ("central",)),
    ("/api/system", ("dashboard",)),
    ("/api/perfil", ("perfil",)),
    ("/api/admin", ("admin",)),
)


def assert_route_permissions(user: dict[str, Any], path: str) -> None:
    permissions = effective_permissions(user)
    for prefix, required in ROUTE_PERMISSIONS:
        if path.startswith(prefix) and not all(permissions.get(key, False) for key in required):
            raise HTTPException(status_code=403, detail="Seu acesso nao permite esta operacao.")
        if path.startswith(prefix):
            return


async def assert_workspace_access(user: dict[str, Any], request: Request) -> None:
    raw_workspace = request.headers.get("X-Norium-Workspace", "").strip()
    if not raw_workspace or raw_workspace == "primary":
        return
    workspace_id = normalize_workspace_id(raw_workspace)
    if workspace_id != raw_workspace:
        raise HTTPException(status_code=400, detail="Workspace invalido.")
    account_owner_id = str(user.get("teamOwnerId") or user.get("id") or "").strip()
    payload = await asyncio.to_thread(read_account_db, account_owner_id, "plataforma", {})
    workspaces = payload.get("workspaces", []) if isinstance(payload, dict) else []
    allowed = any(
        isinstance(item, dict)
        and str(item.get("id") or "") == workspace_id
        and item.get("active", True)
        for item in workspaces
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="Workspace nao pertence a esta conta.")


def sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    safe = {key: value for key, value in user.items() if key != "passwordHash"}
    safe["systemAdmin"] = is_system_owner(safe)
    safe["permissions"] = effective_permissions(safe)
    safe["status"] = safe.get("status", "ativo")
    safe["requiresPlanSelection"] = bool(safe.get("requiresPlanSelection", False))
    return safe


def can_manage_team(user: dict[str, Any]) -> bool:
    permissions = effective_permissions(user)
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
    users: list[dict[str, Any]] = []
    teams: list[dict[str, Any]] = []
    if OWNER_EMAIL and OWNER_BOOTSTRAP_PASSWORD:
        owner = {
            "id": OWNER_USER_ID,
            "nome": OWNER_NAME,
            "email": OWNER_EMAIL,
            "passwordHash": hash_password(OWNER_BOOTSTRAP_PASSWORD),
            "role": "owner",
            "plan": "equipe",
            "status": "ativo",
            "systemAdmin": True,
            "sessionVersion": 0,
            "teamOwnerId": None,
            "createdBy": None,
            "createdAt": created,
            "updatedAt": created,
            "lastLoginAt": None,
            "permissions": OWNER_PERMISSIONS,
            "requiresPlanSelection": False,
        }
        users.append(owner)
        teams.append(
            {
                "id": OWNER_USER_ID,
                "ownerUserId": OWNER_USER_ID,
                "name": "Equipe Norium",
                "createdAt": created,
                "updatedAt": created,
            }
        )
    else:
        logger.warning(
            "Bootstrap administrativo desativado. Configure e-mail e senha por ambiente "
            "somente ao inicializar uma instalacao nova."
        )
    return {
        "users": users,
        "plans": PLAN_CATALOG,
        "teams": teams,
    }


def ensure_team_profiles(store: dict[str, Any]) -> dict[str, Any]:
    teams = store.get("teams")
    if not isinstance(teams, list):
        teams = []
        store["teams"] = teams

    known_ids = {str(item.get("id") or "") for item in teams if isinstance(item, dict)}
    for owner in store.get("users", []):
        if not isinstance(owner, dict) or owner.get("role") != "owner":
            continue
        owner_id = str(owner.get("id") or "").strip()
        if not owner_id or owner_id in known_ids:
            continue
        created = str(owner.get("createdAt") or now_iso())
        teams.append(
            {
                "id": owner_id,
                "ownerUserId": owner_id,
                "name": f"Equipe de {str(owner.get('nome') or 'Norium').strip()}",
                "createdAt": created,
                "updatedAt": created,
            }
        )
        known_ids.add(owner_id)

    # Registros antigos usavam apenas ``createdBy`` para inferir a equipe.
    # Materializamos o vinculo uma unica vez para que toda autorizacao passe a
    # depender exclusivamente de ``teamOwnerId`` e uma troca de equipe revogue
    # imediatamente o acesso do criador anterior.
    users_by_id = {
        str(item.get("id") or ""): item
        for item in store.get("users", [])
        if isinstance(item, dict)
    }
    for member in store.get("users", []):
        if not isinstance(member, dict) or member.get("role") == "owner" or member.get("teamOwnerId"):
            continue
        creator_id = str(member.get("createdBy") or "").strip()
        creator = users_by_id.get(creator_id)
        if creator and creator.get("role") == "owner":
            member["teamOwnerId"] = creator_id
    return store


def ensure_seed_user(store: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(store.get("users"), list):
        store["users"] = []
    users = store["users"]
    if not users:
        configured = default_store()
        users.extend(configured["users"])
        if not store.get("teams"):
            store["teams"] = configured["teams"]
    if OWNER_EMAIL and OWNER_BOOTSTRAP_PASSWORD:
        owner = next((item for item in users if stored_email(item) == OWNER_EMAIL), None)
        if owner:
            owner["systemAdmin"] = True
            owner["role"] = "owner"
    for item in users:
        item["sessionVersion"] = max(0, int(item.get("sessionVersion") or 0))
        item["systemAdmin"] = bool(item.get("systemAdmin"))
        item["permissions"] = effective_permissions(item)
    store["plans"] = PLAN_CATALOG
    return ensure_team_profiles(store)


async def read_user_store() -> dict[str, Any]:
    def load() -> dict[str, Any]:
        if not USERS_DB_PATH.exists():
            legacy_users = BASE_DIR / "usuarios_db.json"
            # Um diretorio explicitamente configurado representa um ambiente
            # isolado (producao, homologacao ou QA). Nunca o contamine com o
            # banco legado empacotado no codigo-fonte.
            allow_legacy_import = not os.getenv("NORIUM_DATA_DIR", "").strip()
            if allow_legacy_import and legacy_users.exists():
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


def find_team(store: dict[str, Any], team_id: str) -> dict[str, Any] | None:
    return next(
        (team for team in store.get("teams", []) if isinstance(team, dict) and str(team.get("id")) == team_id),
        None,
    )


def team_id_for_user(user: dict[str, Any]) -> str:
    return str(user.get("teamOwnerId") or user.get("id") or "").strip()


def sanitize_team(store: dict[str, Any], team: dict[str, Any]) -> dict[str, Any]:
    team_id = str(team.get("id") or "")
    members = [
        item for item in store.get("users", [])
        if str(item.get("id") or "") == team_id or str(item.get("teamOwnerId") or "") == team_id
    ]
    owner = find_user(store, str(team.get("ownerUserId") or team_id))
    return {
        "id": team_id,
        "ownerUserId": str(team.get("ownerUserId") or team_id),
        "ownerName": str((owner or {}).get("nome") or ""),
        "name": str(team.get("name") or "Equipe Norium"),
        "memberCount": len(members),
        "createdAt": team.get("createdAt"),
        "updatedAt": team.get("updatedAt"),
    }


def validate_team_owner(store: dict[str, Any], team_owner_id: str | None) -> str | None:
    normalized = str(team_owner_id or "").strip()
    if not normalized:
        return None
    owner = find_user(store, normalized)
    if not owner or owner.get("role") != "owner" or owner.get("status") != "ativo":
        raise HTTPException(status_code=422, detail="A equipe selecionada nao possui um usuario principal ativo.")
    if not find_team(store, normalized):
        ensure_team_profiles(store)
    return normalized


async def current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Login necessario.")
    user = await user_from_token(credentials.credentials)
    await assert_workspace_access(user, request)
    assert_route_permissions(user, request.url.path)
    return user


async def user_from_token(token: str) -> dict[str, Any]:
    payload = decode_token(token)
    store = await read_user_store()
    user = find_user(store, str(payload.get("sub")))
    if not user or user.get("status") != "ativo":
        raise HTTPException(status_code=401, detail="Usuario inativo ou inexistente.")
    if int(payload.get("sv", -1)) != int(user.get("sessionVersion") or 0):
        raise HTTPException(status_code=401, detail="Sessao revogada. Entre novamente.")
    return user


async def issue_websocket_ticket(user: dict[str, Any]) -> str:
    ticket = secrets.token_urlsafe(32)
    now = time.monotonic()
    async with websocket_ticket_lock:
        expired = [key for key, item in websocket_tickets.items() if float(item.get("expiresAt") or 0) <= now]
        for key in expired:
            websocket_tickets.pop(key, None)
        websocket_tickets[ticket] = {
            "userId": str(user.get("id") or ""),
            "sessionVersion": int(user.get("sessionVersion") or 0),
            "expiresAt": now + WEBSOCKET_TICKET_TTL_SECONDS,
        }
    return ticket


async def user_from_websocket_ticket(ticket: str) -> dict[str, Any]:
    now = time.monotonic()
    async with websocket_ticket_lock:
        record = websocket_tickets.pop(ticket, None)
    if not record or float(record.get("expiresAt") or 0) <= now:
        raise HTTPException(status_code=401, detail="Ticket de conexao invalido ou expirado.")
    store = await read_user_store()
    user = find_user(store, str(record.get("userId") or ""))
    if not user or user.get("status") != "ativo":
        raise HTTPException(status_code=401, detail="Usuario inativo ou inexistente.")
    if int(record.get("sessionVersion") or 0) != int(user.get("sessionVersion") or 0):
        raise HTTPException(status_code=401, detail="Sessao revogada. Entre novamente.")
    return user


def visible_users_for(current: dict[str, Any], users: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if can_manage_system(current):
        return [sanitize_user(user) for user in users]
    current_id = current["id"]
    return [
        sanitize_user(user)
        for user in users
        if user.get("id") == current_id or user.get("teamOwnerId") == current_id
    ]


def assert_can_touch_user(current: dict[str, Any], target: dict[str, Any]) -> None:
    if can_manage_system(current):
        return
    if target.get("teamOwnerId") == current.get("id"):
        return
    if target.get("id") == current.get("id"):
        return
    raise HTTPException(status_code=403, detail="Voce nao pode gerenciar este usuario.")


@router.post("/login")
async def login(payload: LoginPayload, request: Request) -> dict[str, Any]:
    client_host = request.client.host if request.client else "unknown"
    await login_limiter.check(f"{client_host}:{payload.email}")
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
async def register(payload: RegisterPayload, request: Request) -> dict[str, Any]:
    client_host = request.client.host if request.client else "unknown"
    await register_limiter.check(client_host)
    if not payload.acceptedTerms or not payload.acceptedPrivacy:
        raise HTTPException(status_code=422, detail="Aceite os Termos de Uso e a Politica de Privacidade.")
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
            "sessionVersion": 0,
            "teamOwnerId": None,
            "createdBy": None,
            "createdAt": created,
            "updatedAt": created,
            "lastLoginAt": created,
            "permissions": permissions_for_plan("free"),
            "requiresPlanSelection": True,
            "legalAcceptance": {
                "termsVersion": LEGAL_VERSION,
                "privacyVersion": LEGAL_VERSION,
                "acceptedAt": created,
            },
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
    if payload.plan != "free" and not can_manage_system(user):
        raise HTTPException(status_code=403, detail="Planos pagos exigem ativacao administrativa valida.")
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


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    async with auth_lock:
        store = await read_user_store()
        target = find_user(store, user["id"])
        if not target or not verify_password(payload.currentPassword, str(target.get("passwordHash", ""))):
            raise HTTPException(status_code=401, detail="Senha atual invalida.")
        target["passwordHash"] = hash_password(payload.newPassword)
        target["sessionVersion"] = int(target.get("sessionVersion") or 0) + 1
        target["updatedAt"] = now_iso()
        await write_user_store(store)
    return {
        "token": create_token(target),
        "user": sanitize_user(target),
        "availableModes": ["app", "admin"] if can_manage_system(target) else ["app"],
    }


@router.post("/logout")
async def logout(user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    async with auth_lock:
        store = await read_user_store()
        target = find_user(store, user["id"])
        if not target:
            raise HTTPException(status_code=401, detail="Usuario inexistente.")
        target["sessionVersion"] = int(target.get("sessionVersion") or 0) + 1
        target["updatedAt"] = now_iso()
        await write_user_store(store)
    return {"loggedOut": True}


@router.get("/me")
async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "user": sanitize_user(user),
        "availableModes": ["app", "admin"] if can_manage_system(user) else ["app"],
    }


@router.post("/websocket-ticket")
async def websocket_ticket(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "ticket": await issue_websocket_ticket(user),
        "expiresIn": WEBSOCKET_TICKET_TTL_SECONDS,
    }


@router.get("/plans")
async def plans(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"plans": PLAN_CATALOG}


@router.get("/teams")
async def list_teams(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = await read_user_store()
    if can_manage_system(user):
        teams = store.get("teams", [])
    else:
        current_team_id = team_id_for_user(user)
        teams = [team for team in store.get("teams", []) if str(team.get("id") or "") == current_team_id]
    return {"teams": [sanitize_team(store, team) for team in teams if isinstance(team, dict)]}


@router.get("/team-profile")
async def get_team_profile(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = await read_user_store()
    team = find_team(store, team_id_for_user(user))
    if not team:
        raise HTTPException(status_code=404, detail="Equipe nao encontrada.")
    return {"team": sanitize_team(store, team)}


@router.patch("/team-profile")
async def update_team_profile(payload: TeamProfilePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    team_id = team_id_for_user(user)
    if not can_manage_system(user) and str(user.get("id") or "") != team_id:
        raise HTTPException(status_code=403, detail="Somente o usuario principal pode alterar o nome da equipe.")
    async with auth_lock:
        store = await read_user_store()
        team = find_team(store, team_id)
        if not team:
            raise HTTPException(status_code=404, detail="Equipe nao encontrada.")
        team["name"] = payload.name.strip()
        team["updatedAt"] = now_iso()
        await write_user_store(store)
    return {"team": sanitize_team(store, team)}


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
        selected_team_owner_id = validate_team_owner(store, payload.teamOwnerId) if can_manage_system(user) else user["id"]
        new_user = {
            "id": f"usr_{secrets.token_hex(8)}",
            "nome": payload.nome.strip(),
            "email": payload.email,
            "passwordHash": hash_password(payload.password),
            "role": payload.role if can_manage_system(user) else "member",
            "plan": payload.plan if can_manage_system(user) else "individual",
            "status": "ativo",
            "systemAdmin": False,
            "sessionVersion": 0,
            "teamOwnerId": selected_team_owner_id,
            "createdBy": user["id"],
            "createdAt": created,
            "updatedAt": created,
            "lastLoginAt": None,
            "permissions": allowed_permissions,
        }
        new_user["permissions"] = effective_permissions(new_user)
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
            target["sessionVersion"] = int(target.get("sessionVersion") or 0) + 1
        if payload.status is not None and not is_system_owner(target):
            target["status"] = payload.status
        if payload.role is not None and can_manage_system(user):
            target["role"] = payload.role
        if payload.plan is not None and can_manage_system(user):
            target["plan"] = payload.plan
            target["permissions"] = permissions_for_plan(payload.plan, is_owner=target.get("role") == "owner")
        if payload.systemAdmin is not None and can_manage_system(user):
            if target.get("systemAdmin") and not payload.systemAdmin:
                other_active_admins = [
                    item
                    for item in store.get("users", [])
                    if item.get("id") != target.get("id")
                    and item.get("status") == "ativo"
                    and item.get("systemAdmin")
                ]
                if not other_active_admins:
                    raise HTTPException(status_code=409, detail="Mantenha ao menos um administrador do sistema ativo.")
            target["systemAdmin"] = bool(payload.systemAdmin)
        if payload.permissions is not None:
            fallback = OWNER_PERMISSIONS if target.get("role") == "owner" else DEFAULT_MEMBER_PERMISSIONS
            next_permissions = sanitize_permissions(payload.permissions, fallback)
            if not can_manage_system(user):
                next_permissions["admin"] = False
                next_permissions["equipe"] = False
            if is_system_owner(target):
                next_permissions = OWNER_PERMISSIONS
            target["permissions"] = next_permissions
        if "teamOwnerId" in payload.model_fields_set and can_manage_system(user):
            selected_team_owner_id = validate_team_owner(store, payload.teamOwnerId)
            if selected_team_owner_id == target.get("id"):
                selected_team_owner_id = None
            target["teamOwnerId"] = selected_team_owner_id
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
        if is_system_owner(target):
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
