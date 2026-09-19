"""Default-deny tool catalogue and policy. No free HTTP, SQL or shell tools."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from pydantic import BaseModel

from .contracts import BrainError, Outcome, POLICY_VERSION, Scope, canonical, fingerprint


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    permission: str | tuple[str, ...]
    policy: str
    schema: type[BaseModel]
    prepare: Callable[..., Awaitable[dict]]
    execute: Callable[..., Awaitable[Outcome]]
    version: str = "1"
    responsible_role: str = ""
    reconcile: Callable[..., Awaitable[Outcome]] | None = None


class Registry:
    def __init__(self, tools=()):
        self.tools = {}
        for tool in tools:
            if tool.name in self.tools or tool.policy not in {"C", "D", "R", "H"}:
                raise ValueError("Invalid tool registration")
            self.tools[tool.name] = tool

    def require(self, name, user):
        tool = self.tools.get(name)
        if tool is None:
            raise BrainError("tool_unavailable", 422)
        permissions = user.get("permissions") or {}
        required = (tool.permission,) if isinstance(tool.permission, str) else tool.permission
        if not permissions.get("nora") or not all(permissions.get(item) for item in required):
            raise BrainError("permission_denied", 403)
        if tool.policy == "H":
            raise BrainError("human_operation_required", 403)
        return tool

    def catalogue(self, user, domains=None):
        permissions = user.get("permissions") or {}
        return [{"type": "function", "name": tool.name, "description": tool.description,
                 "parameters": strict_schema(tool.schema.model_json_schema()), "strict": True}
                for tool in self.tools.values() if tool.policy != "H"
                and permissions.get("nora")
                and all(permissions.get(item) for item in ((tool.permission,) if isinstance(tool.permission, str) else tool.permission))
                and (domains is None or tool.name.split("_", 1)[0] in domains)]


def strict_schema(schema):
    """Make Pydantic schemas satisfy provider strict-function requirements."""
    if isinstance(schema, dict):
        result = {key: strict_schema(value) for key, value in schema.items()}
        if result.get("type") == "object" or "properties" in result:
            properties = result.get("properties") or {}
            result["additionalProperties"] = False
            result["required"] = list(properties)
        return result
    if isinstance(schema, list):
        return [strict_schema(value) for value in schema]
    return schema


def operation(tool, prepared, scope, user=None):
    if len(canonical(prepared).encode()) > 100_000:
        raise BrainError("operation_too_large", 422)
    effects = prepared.get("effects", [])
    policy = "R" if tool.policy == "R" or any(effect in {"send", "delete", "publish", "invite", "finance"} for effect in effects) else tool.policy
    required = (tool.permission,) if isinstance(tool.permission, str) else tool.permission
    exact = {"tool": tool.name, "version": tool.version, "policyVersion": POLICY_VERSION,
             "scope": scope.as_dict(), "prepared": prepared, "policy": policy,
             "responsibleRole": tool.responsible_role,
             "verifiedPermissions": sorted({"nora", *required}) if user is not None else []}
    return {**exact, "digest": fingerprint(exact)}


def scope_for(user, workspace):
    actor = str(user.get("id") or "").strip()
    return Scope(str(user.get("teamOwnerId") or actor), actor, workspace)


async def live_user(scope: Scope):
    """Recheck persisted identity and workspace at every boundary, without tokens."""
    from fastapi import HTTPException
    from starlette.requests import Request
    from app.modules.auth.router import read_user_store, find_user, sanitize_user, assert_workspace_access
    raw = find_user(await read_user_store(), scope.user)
    if not raw or raw.get("status") != "ativo":
        raise BrainError("identity_revoked", 403)
    user = sanitize_user(raw)
    if scope_for(user, scope.workspace) != scope or not (user.get("permissions") or {}).get("nora"):
        raise BrainError("permission_revoked", 403)
    request = Request({"type": "http", "headers": [(b"x-norium-workspace", scope.workspace.encode())]})
    try:
        await assert_workspace_access(user, request)
    except HTTPException:
        raise BrainError("workspace_access_revoked", 403) from None
    return user


async def live_identity(scope: Scope):
    """The executor never mounts legacy user data; the web writer revalidates it."""
    import os
    if os.getenv("NORA_BRAIN_EXECUTOR_ENABLED") == "1":
        from .dispatcher import remote_identity
        return await remote_identity(scope)
    return await live_user(scope)
