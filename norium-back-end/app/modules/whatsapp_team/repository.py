"""Scoped metadata transactions, PostgreSQL or the existing local file fallback."""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

from app.core.request_context import current_workspace_id
from app.core.tenant import get_user_db_path, get_user_dir, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store
from app.infrastructure.persistence.json_repository import _lock_for, validate_shape
from . import schema

T = TypeVar("T")


@dataclass(frozen=True)
class Scope:
    tenant_id: str
    workspace_id: str
    owner_id: str
    binding_id: str

    def __post_init__(self):
        if any(not isinstance(value, str) or not value.strip() or len(value) > 180
               for value in self.params):
            raise ValueError("Team inbox requires explicit scoped identities")
        if self.tenant_id != self.owner_id:
            raise ValueError("Only the team owner can share their instance")

    @property
    def params(self) -> tuple[str, str, str, str]:
        return self.tenant_id, self.workspace_id, self.owner_id, self.binding_id

    @property
    def inbox_id(self) -> str:
        return hashlib.sha256("\0".join(self.params).encode()).hexdigest()

    def file_path(self) -> Path:
        if current_workspace_id() != self.workspace_id:
            raise ValueError("Inbox workspace differs from request context")
        return Path(get_user_db_path(self.owner_id, "whatsapp_team_" + self.inbox_id))


def empty() -> dict:
    return {"schemaVersion": 1, "inbox": {"enabled": False, "autoAssignOnSend": True, "autoDistribute": False, "revision": 0},
            "assignments": {}, "events": {}, "notes": {}}


def _read(db, scope: Scope, *, lock: bool = False) -> dict:
    if lock:
        from psycopg.types.json import Jsonb
        db.execute("""INSERT INTO norium_whatsapp_team_inboxes
            (tenant_id,workspace_id,owner_id,binding_id,payload) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT DO NOTHING""", (*scope.params, Jsonb(empty()["inbox"])))
        row = db.execute("""SELECT payload FROM norium_whatsapp_team_inboxes
            WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s FOR UPDATE""", scope.params).fetchone()
    else:
        row = db.execute("""SELECT payload FROM norium_whatsapp_team_inboxes
            WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s""", scope.params).fetchone()
    result = empty()
    if not row:
        return result
    result["inbox"] = copy.deepcopy(row["payload"])
    queries = {
        "assignments": "SELECT id,payload FROM norium_whatsapp_team_assignments WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s LIMIT 10001",
        "events": "SELECT id,payload FROM norium_whatsapp_team_events WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s LIMIT 20001",
        "notes": "SELECT id,payload FROM norium_whatsapp_team_notes WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s LIMIT 10001",
    }
    for key, query in queries.items():
        result[key] = {item["id"]: copy.deepcopy(item["payload"]) for item in db.execute(query, scope.params).fetchall()}
    _validate(result)
    return result


def _validate(value: dict) -> None:
    if (value.get("schemaVersion") != 1 or not isinstance(value.get("inbox"), dict)
            or any(not isinstance(value.get(key), dict) for key in ("assignments", "events", "notes"))):
        raise postgres_store.PostgresStoreError("whatsapp_team_metadata_invalid")
    if any(len(value[key]) > limit for key, limit in (("assignments", 10000), ("events", 20000), ("notes", 10000))):
        raise postgres_store.PostgresStoreError("whatsapp_team_metadata_limit")


def snapshot(scope: Scope) -> dict:
    if schema.postgres_enabled():
        postgres_store.initialize()
        with postgres_store.connection() as db:
            schema.initialize(db)
            return _read(db, scope)
    path = scope.file_path()
    value = read_json_file(path, empty())
    _validate(value)
    return copy.deepcopy(value)


def _save(db, scope: Scope, original: dict, value: dict) -> None:
    from psycopg.types.json import Jsonb
    db.execute("""UPDATE norium_whatsapp_team_inboxes SET payload=%s
        WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s""",
               (Jsonb(value["inbox"]), *scope.params))
    statements = {
        "assignments": "INSERT INTO norium_whatsapp_team_assignments(tenant_id,workspace_id,owner_id,binding_id,id,payload) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,workspace_id,owner_id,binding_id,id) DO UPDATE SET payload=EXCLUDED.payload",
        "events": "INSERT INTO norium_whatsapp_team_events(tenant_id,workspace_id,owner_id,binding_id,id,payload) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,workspace_id,owner_id,binding_id,id) DO UPDATE SET payload=EXCLUDED.payload",
        "notes": "INSERT INTO norium_whatsapp_team_notes(tenant_id,workspace_id,owner_id,binding_id,id,payload) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,workspace_id,owner_id,binding_id,id) DO UPDATE SET payload=EXCLUDED.payload",
    }
    for key, statement in statements.items():
        if set(original[key]) - set(value[key]):
            raise ValueError("Metadata removal requires the dedicated privacy path")
        for identifier, row in value[key].items():
            if row != original[key].get(identifier):
                db.execute(statement, (*scope.params, identifier, Jsonb(row)))


def mutate(scope: Scope, operation: Callable[[dict], T]) -> T:
    if schema.postgres_enabled():
        postgres_store.initialize()
        with postgres_store.connection() as db:
            schema.initialize(db)
            value = _read(db, scope, lock=True)
            original = copy.deepcopy(value)
            result = operation(value)
            _validate(value)
            _save(db, scope, original, value)
            return copy.deepcopy(result)
    path = scope.file_path()
    with _lock_for(path):
        value = copy.deepcopy(read_json_file(path, empty()))
        validate_shape(value, empty(), path)
        _validate(value)
        result = operation(value)
        _validate(value)
        write_json_file(path, value)
        return copy.deepcopy(result)


def enabled_scopes(owner_id: str, binding_id: str) -> list[Scope]:
    if not owner_id or not binding_id:
        raise ValueError("Explicit inbox ownership required")
    if schema.postgres_enabled():
        postgres_store.initialize()
        with postgres_store.connection() as db:
            schema.initialize(db)
            rows = db.execute("""SELECT tenant_id,workspace_id,owner_id,binding_id FROM norium_whatsapp_team_inboxes
                WHERE owner_id=%s AND binding_id=%s AND payload->>'enabled'='true' LIMIT 1001""", (owner_id, binding_id)).fetchall()
        if len(rows) > 1000:
            raise postgres_store.PostgresStoreError("whatsapp_inbox_scope_limit")
        return [Scope(**row) for row in rows]
    root = get_user_dir(owner_id).resolve()
    result = []
    for path in root.glob("**/whatsapp_team_*_db.json"):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("Unsafe inbox registry path")
        box = read_json_file(path, empty()).get("inbox", {})
        metadata = box.get("scope", {})
        if box.get("enabled") is not True or metadata.get("ownerId") != owner_id or metadata.get("bindingId") != binding_id:
            continue
        scope = Scope(metadata["tenantId"], metadata["workspaceId"], metadata["ownerId"], metadata["bindingId"])
        if path.name != "whatsapp_team_" + scope.inbox_id + "_db.json":
            raise ValueError("Inbox registry identity mismatch")
        relative = path.relative_to(root).as_posix()
        expected = path.name if scope.workspace_id == "primary" else "workspace_" + scope.workspace_id + "/" + path.name
        if relative != expected:
            raise ValueError("Inbox registry workspace mismatch")
        result.append(scope)
        if len(result) > 1000:
            raise ValueError("Inbox registry scope limit")
    return result
