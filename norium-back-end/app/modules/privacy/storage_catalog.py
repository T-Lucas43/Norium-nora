"""Inventário comum à exportação e eliminação, sem copiar bancos de terceiros."""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from app.core.tenant import get_data_root, safe_tenant_id, read_json_file
from app.infrastructure.persistence import postgres_store, files, document_cache

UPLOAD_STORES = ("team_chat_uploads", "finance_uploads", "task_uploads")
SQLITE_STORES = ("ai_costs.sqlite3", "automation_events.sqlite3", "outbound_receipts.sqlite3",
                 "scheduling.sqlite3", "nora_brain.sqlite3", "wapi_binding_registry_db.sqlite3")
# Every personal relational store must have an explicit ownership predicate.
ROW_SCOPES = {
    "scheduling_services": "tenant_id", "scheduling_availability": "tenant_id",
    "scheduling_pages": "tenant_id", "scheduling_bookings": "tenant_id",
    "scheduling_team_settings": "tenant_id", "scheduling_professionals": "tenant_id|user_id",
    "scheduling_service_professionals": "tenant_id|user_id",
    "scheduling_audit": "tenant_id", "scheduling_notification_attempts": "tenant_id",
    "wapi_ownership": "tenant_id", "wapi_instance_lifecycle": "tenant_id", "wapi_binding_journal": "tenant_id",
    "jobs": "user_id", "automation_jobs": "user_id", "norium_system_logs": "user_id",
    "usage": "user_id", "limits": "user_id", "reservations": "user_id", "audit": "actor|target",
    "nora_jobs": "tenant|actor", "nora_events": "tenant|actor", "nora_preferences": "tenant|actor",
    "nora_budget": "account", "nora_outbound_receipts": "tenant|actor",
    "nora_tombstone_scopes": "tenant|actor",
    "norium_outbound_receipts": "user_id", "nora_knowledge_embeddings": "tenant|user_id",
}
NON_PERSONAL_TABLES = {"rates", "metadata", "nora_schema", "nora_internal_nonces", "sqlite_sequence", "wapi_binding_metadata"}
SPECIAL_COVERAGE = {"scheduling_holds", "nora_tombstones", "norium_auth_accounts", "norium_auth_sessions", "norium_auth_events", "norium_auth_credentials"}


def tombstone_ids(jobs: list[dict[str, Any]]) -> set[str]:
    identifiers = set()
    for row in jobs:
        identifiers.update((row["id"], row["id"] + ":summary"))
        try:
            payload = json.loads(row["payload"])
        except (ValueError, TypeError):
            raise RuntimeError("invalid brain record in privacy coverage") from None
        identifiers.update("preference-delete:" + str(step["id"]) for step in payload.get("steps", []) if isinstance(step, dict) and step.get("id"))
    return identifiers


def validate_postgres_coverage(db: Any) -> None:
    rows = db.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()").fetchall()
    personal = {row["table_name"] for row in rows if row["column_name"] in {"user_id", "tenant", "actor", "account", "tenant_id"}}
    if personal - set(ROW_SCOPES) - SPECIAL_COVERAGE - NON_PERSONAL_TABLES:
        raise RuntimeError("personal storage without privacy coverage")


def account_prefixes(user_id: str) -> tuple[str, ...]:
    safe = safe_tenant_id(user_id)
    return (f"user_{safe}/", f"{safe}/", f"uploads/{safe}/")


def personal_documents(user_id: str) -> list[tuple[str, Any]]:
    root = get_data_root().resolve()
    if postgres_store.configured() or postgres_store.required():
        keys = sorted({key for prefix in account_prefixes(user_id) for key in postgres_store.list_document_keys(prefix)})
        return [(key, payload) for key in keys if (result := postgres_store.read_document(key))[0]
                for payload in [result[1]]]
    directory = root / f"user_{safe_tenant_id(user_id)}"
    return [(path.relative_to(root).as_posix(), read_json_file(path, None))
            for path in sorted(directory.rglob("*.json")) if path.is_file() and not path.is_symlink()]


def attachment_names(value: Any):
    if isinstance(value, dict):
        name = value.get("storedName")
        if isinstance(name, str) and Path(name).name == name and len(name) < 256:
            yield name
        for item in value.values():
            yield from attachment_names(item)
    elif isinstance(value, list):
        for item in value:
            yield from attachment_names(item)


def legacy_uploads(user_id: str, *, documents: list[tuple[str, Any]] | None = None) -> list[Path]:
    """Arquivos planos antigos só entram se referenciados em documento do dono."""
    root = get_data_root().resolve()
    names = {name for _, payload in (documents if documents is not None else personal_documents(user_id))
             for name in attachment_names(payload)}
    result: list[Path] = []
    for store in UPLOAD_STORES:
        for path in files.list_paths(root / store):
            if path.name in names and not path.is_symlink():
                result.append(path)
    return result


def scope_clause(table: str, columns: set[str], user_id: str, *, placeholder: str = "?") -> tuple[str, tuple[Any, ...]] | None:
    fields = ROW_SCOPES.get(table, "").split("|")
    fields = [field for field in fields if field in columns]
    if not fields:
        return None
    return " OR ".join(f'"{field}"={placeholder}' for field in fields), tuple(user_id for _ in fields)


def sqlite_personal_data(user_id: str, *, purge: bool = False, workspace_id: str | None = None) -> dict[str, Any]:
    root = get_data_root().resolve()
    # Discover additional brain paths only inside the managed data root.
    paths = {root / name for name in SQLITE_STORES}
    import os
    url = os.getenv("NORA_BRAIN_DATABASE_URL", "")
    if url.startswith("sqlite:///"):
        candidate = Path(url.removeprefix("sqlite:///")).resolve()
        if candidate.is_relative_to(root):
            paths.add(candidate)
    result: dict[str, Any] = {}
    for path in sorted(paths):
        if not path.is_file() or path.is_symlink():
            continue
        with closing(sqlite3.connect(path)) as db:
            db.row_factory = sqlite3.Row
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for table in tables:
                if not re.fullmatch(r"[a-zA-Z0-9_]+", table):
                    raise RuntimeError("invalid storage table")
                columns = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}  # nosec B608 -- identifier whitelist
                clause = scope_clause(table, columns, user_id)
                if table == "nora_tombstones":
                    # Tombstones refer to jobs; resolve ownership before removing jobs.
                    if "nora_jobs" in tables:
                        query, params = "SELECT * FROM nora_jobs WHERE (tenant=? OR actor=?)", (user_id, user_id)
                        if workspace_id is not None:
                            query, params = query + " AND workspace=?", params + (workspace_id,)
                        ids = tombstone_ids([dict(row) for row in db.execute(query, params)])
                        if "nora_tombstone_scopes" in tables:
                            query, params = "SELECT id FROM nora_tombstone_scopes WHERE (tenant=? OR actor=?)", (user_id, user_id)
                            if workspace_id is not None:
                                query, params = query + " AND workspace=?", params + (workspace_id,)
                            ids.update(row[0] for row in db.execute(query, params))
                        ids = sorted(ids)
                        clause = ("id IN (" + ",".join("?" for _ in ids) + ")", tuple(ids)) if ids else None
                if table == "scheduling_holds" and "scheduling_pages" in tables:
                    query, params = "SELECT id FROM scheduling_pages WHERE tenant_id=?", (user_id,)
                    if workspace_id is not None:
                        query, params = query + " AND workspace_id=?", params + (workspace_id,)
                    ids = [row[0] for row in db.execute(query, params)]
                    clause = ("page_id IN (" + ",".join("?" for _ in ids) + ")", tuple(ids)) if ids else None
                if clause is None:
                    if (columns & {"user_id", "tenant", "actor", "account", "tenant_id"}) and table not in NON_PERSONAL_TABLES:
                        raise RuntimeError("personal storage without privacy coverage")
                    continue
                if workspace_id is not None and table not in {"nora_tombstones", "scheduling_holds"}:
                    workspace_column = "workspace_id" if "workspace_id" in columns else "workspace" if "workspace" in columns else ""
                    if not workspace_column:
                        continue
                    clause = (f"({clause[0]}) AND {workspace_column}=?", clause[1] + (workspace_id,))
                where, params = clause
                rows = [dict(row) for row in db.execute(f'SELECT * FROM "{table}" WHERE {where}', params)]  # nosec B608 -- fixed scope, identifier whitelist
                if rows:
                    result[f"{path.name}/{table}"] = rows
            if purge:
                # Gather all rows before deletion so job-linked tombstones still resolve.
                entries = sorted(result.items(), key=lambda item: 0 if item[0].endswith(("/nora_tombstones", "/scheduling_holds")) else 1)
                for key, rows in entries:
                    if not key.startswith(path.name + "/") or not rows:
                        continue
                    table = key.split("/", 1)[1]
                    if table in {"nora_tombstones", "scheduling_holds"}:
                        for row in rows:
                            db.execute(f'DELETE FROM "{table}" WHERE id=?', (row["id"],))  # nosec B608 -- fixed table set
                        continue
                    columns = set(rows[0])
                    clause = scope_clause(table, columns, user_id)
                    if clause:
                        if workspace_id is not None:
                            workspace_column = "workspace_id" if "workspace_id" in columns else "workspace"
                            clause = (f"({clause[0]}) AND {workspace_column}=?", clause[1] + (workspace_id,))
                        db.execute(f'DELETE FROM "{table}" WHERE {clause[0]}', clause[1])  # nosec B608 -- fixed scope, identifier whitelist
                db.commit()
    return result


def clear_personal_cache(user_id: str) -> None:
    for prefix in account_prefixes(user_id):
        document_cache.forget_prefix(prefix)
    from app.infrastructure.persistence.json_repository import forget_directory
    forget_directory(get_data_root() / f"user_{safe_tenant_id(user_id)}")
    # These process caches contain provider URLs, metadata or prepared sessions.
    import sys
    for module_name in ("app.modules.chat.router", "app.services.gmail_service", "app.services.email_agent", "app.services.agenda_agent", "app.services.nora"):
        module = sys.modules.get(module_name)
        if module is None:
            continue
        invalidator = getattr(module, "invalidate_user_cache", None) or getattr(module, "clear_response_cache", None)
        if callable(invalidator):
            invalidator(user_id)
        for name in ("remote_media_registry", "inbound_messages", "sessions", "_sessions", "_message_cache"):
            cache = getattr(module, name, None)
            if isinstance(cache, dict):
                cache.pop(user_id, None)
