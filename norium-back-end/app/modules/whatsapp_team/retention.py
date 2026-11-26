"""Bounded, opt-in WhatsApp retention. Assignment ACL is never age-deleted."""
from __future__ import annotations

import copy
from pathlib import Path
from app.core.tenant import get_data_root, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store
from app.infrastructure.persistence.json_repository import _lock_for
from .repository import empty
from .schema import postgres_enabled


def maintain(cutoff: float) -> int:
    if cutoff <= 0:
        return 0
    if postgres_enabled():
        return _postgres(cutoff)
    root = get_data_root().resolve()
    count = 0
    for path in list(root.glob("user_*/**/whatsapp_team_*_db.json"))[:100]:
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            continue
        with _lock_for(path):
            value = copy.deepcopy(read_json_file(path, empty()))
            changed = 0
            for kind in ("notes", "events"):
                rows = value.get(kind, {})
                expired = [identifier for identifier, row in rows.items()
                           if type(row.get("createdAt")) in {int, float} and row["createdAt"] < cutoff]
                for identifier in expired[:500]:
                    del rows[identifier]
                    changed += 1
            if changed:
                write_json_file(path, value)
            count += changed
    return count


def _postgres(cutoff: float) -> int:
    count = 0
    with postgres_store.connection() as db:
        if not db.execute("SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='norium_whatsapp_team_inboxes'").fetchone():
            return 0
        # Lock in the same order as normal metadata writers. Select only boxes
        # with expired content, so repeated bounded passes make progress.
        scopes = db.execute("""SELECT i.tenant_id,i.workspace_id,i.owner_id,i.binding_id
            FROM norium_whatsapp_team_inboxes i WHERE EXISTS (
                SELECT 1 FROM norium_whatsapp_team_notes n WHERE
                (n.tenant_id,n.workspace_id,n.owner_id,n.binding_id)=(i.tenant_id,i.workspace_id,i.owner_id,i.binding_id)
                AND CASE WHEN jsonb_typeof(n.payload->'createdAt')='number' THEN (n.payload->>'createdAt')::double precision END < %s)
            OR EXISTS (SELECT 1 FROM norium_whatsapp_team_events e WHERE
                (e.tenant_id,e.workspace_id,e.owner_id,e.binding_id)=(i.tenant_id,i.workspace_id,i.owner_id,i.binding_id)
                AND CASE WHEN jsonb_typeof(e.payload->'createdAt')='number' THEN (e.payload->>'createdAt')::double precision END < %s)
            ORDER BY i.tenant_id,i.workspace_id,i.owner_id,i.binding_id LIMIT 100 FOR UPDATE OF i SKIP LOCKED""", (cutoff, cutoff)).fetchall()
        statements = (
            """DELETE FROM norium_whatsapp_team_notes WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s
                AND id IN (SELECT id FROM norium_whatsapp_team_notes WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s
                AND CASE WHEN jsonb_typeof(payload->'createdAt')='number' THEN (payload->>'createdAt')::double precision END < %s ORDER BY id LIMIT 500)""",
            """DELETE FROM norium_whatsapp_team_events WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s
                AND id IN (SELECT id FROM norium_whatsapp_team_events WHERE tenant_id=%s AND workspace_id=%s AND owner_id=%s AND binding_id=%s
                AND CASE WHEN jsonb_typeof(payload->'createdAt')='number' THEN (payload->>'createdAt')::double precision END < %s ORDER BY id LIMIT 500)""",
        )
        for scope in scopes:
            params = tuple(scope[key] for key in ("tenant_id", "workspace_id", "owner_id", "binding_id"))
            for statement in statements:
                count += db.execute(statement, (*params, *params, cutoff)).rowcount
    return count
