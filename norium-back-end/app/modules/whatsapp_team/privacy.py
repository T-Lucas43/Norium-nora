"""Export own contributions and anonymize them without deleting teammates' work."""
from __future__ import annotations

import copy
import time

from app.core.tenant import get_data_root, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store
from app.infrastructure.persistence.json_repository import _lock_for
from .repository import empty
from .schema import postgres_enabled

TABLES = {"inbox": "norium_whatsapp_team_inboxes", "assignments": "norium_whatsapp_team_assignments",
          "events": "norium_whatsapp_team_events", "notes": "norium_whatsapp_team_notes"}
ACTOR_FIELDS = ("authorUserId", "actorUserId", "updatedBy", "assigneeUserId")


def contribution(row: dict, user_id: str) -> dict | None:
    fields = [field for field in ACTOR_FIELDS if row.get(field) == user_id]
    mentioned = user_id in row.get("mentions", [])
    payload_match = (row.get("payload") or {}).get("assigneeUserId") == user_id
    if not fields and not mentioned and not payload_match:
        return None
    result = {key: copy.deepcopy(row[key]) for key in ("id", "conversationId", "createdAt", "editedAt", "deletedAt", "kind") if key in row}
    result["fields"] = fields
    result["mentioned"] = mentioned
    if row.get("authorUserId") == user_id:
        result["body"] = row.get("body", "")
    if row.get("actorUserId") == user_id:
        result["payload"] = copy.deepcopy(row.get("payload", {}))
    return result


def anonymize(row: dict, user_id: str) -> bool:
    if contribution(row, user_id) is None:
        return False
    if row.get("authorUserId") == user_id:
        row.update({"body": "", "mentions": [], "deletedAt": time.time()})
    if row.get("assigneeUserId") == user_id:
        row.update({"assigneeUserId": None, "assigneeKind": "none", "version": row.get("version", 0) + 1,
                    "generation": row.get("generation", 0) + 1})
    for field in ACTOR_FIELDS:
        if row.get(field) == user_id:
            row[field] = "deleted"
    if "mentions" in row:
        row["mentions"] = [identifier for identifier in row["mentions"] if identifier != user_id]
    if (row.get("payload") or {}).get("assigneeUserId") == user_id:
        row["payload"]["assigneeUserId"] = "deleted"
    return True


def _exists(db, table: str) -> bool:
    return bool(db.execute("SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=%s", (table,)).fetchone())


def _postgres_contributions(user_id: str, *, purge: bool) -> list[dict]:
    from psycopg import sql
    from psycopg.types.json import Jsonb
    result = []
    with postgres_store.connection() as db:
        if purge and _exists(db, TABLES["inbox"]):
            # Match the normal write order: inbox lock before notes/assignments.
            # Account erasure is rare; the ordered locks avoid stale rewrites.
            db.execute("""SELECT tenant_id FROM norium_whatsapp_team_inboxes
                ORDER BY tenant_id,workspace_id,owner_id,binding_id FOR UPDATE""").fetchall()
        for kind, table in TABLES.items():
            if not _exists(db, table):
                continue
            query = sql.SQL("""SELECT * FROM {} WHERE tenant_id<>%s AND
                (payload->>'authorUserId'=%s OR payload->>'actorUserId'=%s OR payload->>'updatedBy'=%s
                OR payload->>'assigneeUserId'=%s OR (payload->'mentions') ? %s
                OR payload->'payload'->>'assigneeUserId'=%s) LIMIT 100001""").format(sql.Identifier(table))
            if purge:
                query += sql.SQL(" FOR UPDATE")
            rows = db.execute(query, (user_id,) * 7).fetchall()
            if len(rows) > 100000:
                raise RuntimeError("whatsapp_privacy_export_limit")
            for row in rows:
                payload = copy.deepcopy(row["payload"])
                exported = contribution(payload, user_id)
                if exported is not None:
                    result.append({"kind": kind, "workspace": row["workspace_id"], "record": exported})
                if purge and anonymize(payload, user_id):
                    statement = sql.SQL("""UPDATE {} SET payload=%s WHERE tenant_id=%s AND workspace_id=%s
                        AND owner_id=%s AND binding_id=%s""").format(sql.Identifier(table))
                    params = (Jsonb(payload), row["tenant_id"], row["workspace_id"], row["owner_id"], row["binding_id"])
                    if kind != "inbox":
                        statement += sql.SQL(" AND id=%s")
                        params += (row["id"],)
                    db.execute(statement, params)
    return result


def personal_contributions(user_id: str, *, purge: bool = False) -> list[dict]:
    if not user_id:
        raise ValueError("Privacy requires an explicit user")
    if postgres_enabled():
        return _postgres_contributions(user_id, purge=purge)
    root = get_data_root().resolve()
    result = []
    for path in root.glob("user_*/**/whatsapp_team_*_db.json"):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise RuntimeError("unsafe whatsapp privacy path")
        with _lock_for(path):
            value = copy.deepcopy(read_json_file(path, empty()))
            changed = False
            for kind in TABLES:
                rows = [value["inbox"]] if kind == "inbox" else value.get(kind, {}).values()
                for row in rows:
                    exported = contribution(row, user_id)
                    if exported is not None:
                        result.append({"kind": kind, "store": path.relative_to(root).as_posix(), "record": exported})
                    if purge:
                        changed = anonymize(row, user_id) or changed
            if changed:
                write_json_file(path, value)
    return result
