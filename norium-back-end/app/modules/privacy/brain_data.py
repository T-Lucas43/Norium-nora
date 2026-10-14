"""Cobertura do banco dedicado do cérebro, inclusive quando não é o DB principal."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def brain_personal_data(user_id: str, *, purge: bool = False, workspace_id: str | None = None) -> dict[str, Any]:
    url = os.getenv("NORA_BRAIN_DATABASE_URL", "").strip()
    if not url or (url == os.getenv("NORIUM_DATABASE_URL", "").strip() and url.startswith(("postgres://", "postgresql://"))):
        return {}
    if url.startswith("sqlite:///") and not Path(url.removeprefix("sqlite:///")).is_file():
        return {}
    from app.modules.nora.brain.repository import configured_repository
    from app.modules.privacy.storage_catalog import ROW_SCOPES, scope_clause
    repo = configured_repository()
    result = {}
    with repo.transaction() as db:
        if repo.postgres:
            tables = {row["table_name"] for row in db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()").fetchall()}
        else:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        job_rows = []
        if "nora_jobs" in tables:
            query, params = "SELECT * FROM nora_jobs WHERE (tenant=? OR actor=?)", (user_id, user_id)
            if workspace_id is not None:
                query, params = query + " AND workspace=?", params + (workspace_id,)
            job_rows = [dict(row) for row in repo.sql(db, query, params).fetchall()]
        tombstone_ids = set()
        for row in job_rows:
            tombstone_ids.update((row["id"], row["id"] + ":summary"))
            try:
                payload = json.loads(row["payload"])
                tombstone_ids.update("preference-delete:" + str(step["id"]) for step in payload.get("steps", []) if isinstance(step, dict) and step.get("id"))
            except (ValueError, TypeError):
                raise RuntimeError("invalid brain record in privacy coverage") from None
        if "nora_tombstone_scopes" in tables:
            query, params = "SELECT id FROM nora_tombstone_scopes WHERE (tenant=? OR actor=?)", (user_id, user_id)
            if workspace_id is not None:
                query, params = query + " AND workspace=?", params + (workspace_id,)
            tombstone_ids.update(row["id"] for row in repo.sql(db, query, params).fetchall())
        if "nora_tombstones" in tables and tombstone_ids:
            ids = sorted(tombstone_ids)
            rows = []
            for identifier in ids:
                row = repo.sql(db, "SELECT * FROM nora_tombstones WHERE id=?", (identifier,)).fetchone()
                if row is not None:
                    rows.append(dict(row))
            if rows:
                result["nora_tombstones"] = rows
            if purge:
                for identifier in ids:
                    repo.sql(db, "DELETE FROM nora_tombstones WHERE id=?", (identifier,))
        for table in ROW_SCOPES:
            if not table.startswith("nora_") or table not in tables:
                continue
            if repo.postgres:
                columns = {row["column_name"] for row in db.execute("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=%s", (table,)).fetchall()}
            else:
                columns = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}  # nosec B608 -- fixed table map
            clause = scope_clause(table, columns, user_id)
            if clause is None:
                raise RuntimeError("brain storage without privacy coverage")
            where, params = clause
            if workspace_id is not None:
                if "workspace" not in columns:
                    continue
                where, params = f"({where}) AND workspace=?", params + (workspace_id,)
            rows = [dict(row) for row in repo.sql(db, f"SELECT * FROM {table} WHERE {where}", params).fetchall()]  # nosec B608 -- fixed table map
            if rows:
                result[table] = rows
            if purge:
                repo.sql(db, f"DELETE FROM {table} WHERE {where}", params)  # nosec B608 -- fixed table map
    from app.modules.nora.brain.runtime import clear_runtime_cache
    if purge:
        clear_runtime_cache()
    return result
