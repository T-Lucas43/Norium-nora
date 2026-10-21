"""Fresh account, workspace, binding and conversation checks for every action."""
from __future__ import annotations

from dataclasses import dataclass
from fastapi import HTTPException, Request

from app.core.identity import require_team_id, require_user_id
from app.core.request_context import current_workspace_id
from app.modules.auth.router import assert_workspace_access, effective_permissions
from app.modules.chat.history import binding_signature
from .repository import Scope


@dataclass(frozen=True)
class Access:
    actor: dict
    owner: dict
    scope: Scope
    roster: tuple[dict, ...]

    @property
    def actor_id(self) -> str:
        return require_user_id(self.actor)

    @property
    def manager(self) -> bool:
        return self.actor_id == self.scope.owner_id or bool(effective_permissions(self.actor).get("whatsapp.ver_todas"))


def can_attend(user: dict) -> bool:
    permissions = effective_permissions(user)
    return (user.get("status", "ativo") == "ativo" and bool(permissions.get("chat"))
            and bool(permissions.get("integracao_whatsapp")) and bool(permissions.get("whatsapp.atender")))


async def resolve(runtime, authenticated: dict, inbox_id: str | None = None, *, owner_only: bool = False) -> Access:
    actor_id = require_user_id(authenticated)
    directory = (await runtime.read_user_store()).get("users", [])
    actor = next((row for row in directory if row.get("id") == actor_id), None)
    if not actor or actor.get("status", "ativo") != "ativo":
        raise HTTPException(403, "Acesso à caixa indisponível.")
    # Do not trust a stale browser session's role or teamOwnerId after removal.
    team = require_team_id(actor)
    owner = next((row for row in directory if row.get("id") == team), None)
    if (not owner or owner.get("role") != "owner" or require_team_id(owner) != team
            or owner.get("status", "ativo") != "ativo" or owner.get("plan") not in {"equipe", "enterprise"}
            or not can_attend(owner) or not can_attend(actor)):
        raise HTTPException(403, "Esta conta não tem acesso ao atendimento em equipe.")
    if owner_only and actor_id != team:
        raise HTTPException(403, "Somente o dono pode compartilhar esta instância.")
    workspace = current_workspace_id()
    if workspace != "primary":
        # Recheck with the fresh directory identity after transfers/revocations.
        await assert_workspace_access(actor, Request({"type": "http", "headers": [(b"x-norium-workspace", workspace.encode("utf-8"))]}))
    binding = runtime.wapi_owned_binding(team)
    if binding is None or not binding.exists:
        raise HTTPException(409, "Conecte a instância do dono antes de compartilhar.")
    scope = Scope(team, workspace, team, binding_signature(binding.instance_id, binding.created_at))
    if inbox_id is not None and inbox_id != scope.inbox_id:
        raise HTTPException(404, "Caixa indisponível.")
    roster = tuple(row for row in directory if require_team_id(row) == team and can_attend(row))
    return Access(actor, owner, scope, roster)


def assert_enabled(value: dict) -> None:
    if value["inbox"].get("enabled") is not True:
        raise HTTPException(404, "Caixa indisponível.")


def assert_conversation(access: Access, value: dict, conversation_id: str, aliases=()) -> dict:
    assert_enabled(value)
    from app.services.whatsapp_identity import token
    keys = {conversation_id, *aliases}
    for key in list(keys):
        normalized = token(key)
        if normalized.endswith("@s.whatsapp.net"):
            phone = normalized.split("@", 1)[0]
            keys.update({normalized, phone, phone + "@c.us"})
    rows = [value["assignments"][key] for key in keys if key in value["assignments"]]
    for row in rows:
        kind = row.get("assigneeKind", "none")
        if not access.manager and (kind != "none" and row.get("assigneeUserId") != access.actor_id):
            raise HTTPException(404, "Conversa indisponível.")
    return value["assignments"].get(conversation_id) or next((row for row in rows if row.get("assigneeKind") != "none"), {})


def public_member(row: dict) -> dict:
    return {"id": row["id"], "name": str(row.get("nome") or "Membro"),
            "avatar": str(row.get("fotoUrl") or "")}
