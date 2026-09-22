"""Import one quiesced Norium data root into PostgreSQL and validate it.

The source stays untouched. JSON documents become JSONB rows, operational
SQLite tables become native PostgreSQL tables, and all remaining business
files become BYTEA objects. A migration receipt makes retries observable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


SQLITE_TARGETS = {
    "scheduling.sqlite3": {
        "scheduling_services": "scheduling_services",
        "scheduling_availability": "scheduling_availability",
        "scheduling_pages": "scheduling_pages",
        "scheduling_holds": "scheduling_holds",
        "scheduling_bookings": "scheduling_bookings",
        "scheduling_audit": "scheduling_audit",
        "scheduling_notification_attempts": "scheduling_notification_attempts",
    },
    "wapi_binding_registry_db.sqlite3": {
        "wapi_ownership": "wapi_ownership",
        "wapi_binding_journal": "wapi_binding_journal",
        "wapi_binding_metadata": "wapi_binding_metadata",
        "wapi_instance_lifecycle": "wapi_instance_lifecycle",
    },
    "automation_events.sqlite3": {"jobs": "automation_jobs"},
    "ai_costs.sqlite3": {
        "rates": "rates", "usage": "usage", "limits": "limits",
        "reservations": "reservations", "audit": "audit", "metadata": "metadata",
    },
}


def _source_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def _initialize_schemas(database_url: str) -> None:
    from app.infrastructure.persistence import postgres_store
    from app.modules.automations import events
    from app.modules.nora.brain.repository import Repository as BrainRepository
    from app.modules.scheduling.repository import SchedulingRepository
    from app.services import ai_costs, system_logs, wapi_binding

    postgres_store.initialize()
    SchedulingRepository()
    registry = wapi_binding._registry_connection()
    registry.close()
    automation = events.connection()
    automation.close()
    with ai_costs.database():
        pass
    system_logs.list_system_logs(limit=1)
    BrainRepository(database_url).initialize()
    with postgres_store.connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS norium_migrations (
            migration_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL,
            report JSONB NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())""")


def _sqlite_rows(path: Path, table: str) -> tuple[list[str], list[tuple[Any, ...]]]:
    with closing(sqlite3.connect(path)) as source:
        exists = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        if not exists:
            return [], []
        columns = [str(item[1]) for item in source.execute(f'PRAGMA table_info("{table}")')]
        rows = source.execute(f'SELECT * FROM "{table}"').fetchall()
    return columns, rows


def _copy_sqlite(root: Path) -> dict[str, int]:
    from psycopg import sql
    from app.infrastructure.persistence import postgres_store

    counts: dict[str, int] = {}
    with postgres_store.connection() as target:
        for file_name, tables in SQLITE_TARGETS.items():
            source_path = root / file_name
            if not source_path.is_file():
                continue
            for source_table, target_table in tables.items():
                columns, rows = _sqlite_rows(source_path, source_table)
                if not columns:
                    continue
                statement = sql.SQL("INSERT INTO {} ({}) {} VALUES ({}) ON CONFLICT DO NOTHING").format(
                    sql.Identifier(target_table),
                    sql.SQL(",").join(map(sql.Identifier, columns)),
                    sql.SQL("OVERRIDING SYSTEM VALUE") if file_name == "ai_costs.sqlite3" and target_table == "audit" else sql.SQL(""),
                    sql.SQL(",").join(sql.Placeholder() for _ in columns),
                )
                if rows:
                    target.cursor().executemany(statement, rows)
                destination = target.execute(sql.SQL("SELECT COUNT(*) AS total FROM {}").format(sql.Identifier(target_table))).fetchone()
                if int(destination["total"]) < len(rows):
                    raise RuntimeError(f"row count validation failed for {target_table}")
                counts[target_table] = len(rows)
    return counts


def _copy_json_and_blobs(root: Path) -> tuple[int, int]:
    from app.infrastructure.persistence import postgres_store

    documents = blobs = 0
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative in SQLITE_TARGETS:
            continue
        if path.suffix.lower() in {".sqlite", ".sqlite3", ".db"} or path.name.endswith((".sqlite3-wal", ".sqlite3-shm", ".sqlite3-journal")):
            raise RuntimeError(f"unmapped SQLite source: {relative}")
        if path.name == ".wapi_binding_registry.lock":
            continue
        content = path.read_bytes()
        if path.suffix.lower() == ".json":
            try:
                payload = json.loads(content.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"invalid JSON source: {relative}") from exc
            postgres_store.write_document(relative, payload)
            found, stored = postgres_store.read_document(relative)
            if not found or stored != payload:
                raise RuntimeError(f"JSONB verification failed: {relative}")
            documents += 1
        elif path.name == "system_logs_db.jsonl":
            _copy_system_logs(content)
        else:
            postgres_store.write_blob(relative, content, mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                                      {"migratedFrom": relative})
            stored = postgres_store.read_blob(relative)
            if stored is None or bytes(stored["sha256"]) != hashlib.sha256(content).digest() or int(stored["byte_size"]) != len(content):
                raise RuntimeError(f"BYTEA verification failed: {relative}")
            blobs += 1
    return documents, blobs


def _copy_system_logs(content: bytes) -> None:
    from psycopg.types.json import Jsonb
    from app.infrastructure.persistence import postgres_store

    rows = []
    for line in content.decode("utf-8-sig").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        rows.append((item["id"], item.get("event", ""), item.get("level", "info"), item.get("message", ""),
                     item.get("userId", "anonymous"), item.get("workspaceId", "primary"), Jsonb(item.get("metadata") or {}),
                     item.get("createdAt")))
    with postgres_store.connection() as db:
        if rows:
            db.cursor().executemany("""INSERT INTO norium_system_logs
                (id,event,level,message,user_id,workspace_id,metadata,created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""", rows)


def _copy_scheduling_logos(root: Path) -> int:
    from app.infrastructure.persistence import postgres_store

    copied = 0
    with postgres_store.connection() as db:
        pages = db.execute("SELECT id,tenant_id,workspace_id FROM scheduling_pages WHERE logo_url IS NOT NULL").fetchall()
    for page in pages:
        directory = root / f"user_{page['tenant_id']}" / "scheduling_assets"
        source = next((directory / f"{page['id']}.{suffix}" for suffix in ("png", "jpg", "webp")
                       if (directory / f"{page['id']}.{suffix}").is_file()), None)
        if source is None:
            continue
        content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        postgres_store.write_blob(f"{page['tenant_id']}/{page['workspace_id']}/scheduling/logo/{page['id']}",
                                  source.read_bytes(), content_type, {"migratedFrom": source.relative_to(root).as_posix()})
        copied += 1
    return copied


def _verify_accounts(root: Path) -> dict[str, int]:
    from app.infrastructure.persistence import postgres_store

    path = root / "usuarios_db.json"
    if not path.is_file():
        raise RuntimeError("user registry missing from migration source")
    source = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(source, dict) or not isinstance(source.get("users"), list) or not source["users"]:
        raise RuntimeError("user registry invalid or empty in migration source")
    found, target = postgres_store.read_document("usuarios_db.json")
    if not found or target != source:
        raise RuntimeError("user registry verification failed in PostgreSQL")
    return {key: len(source[key]) for key in ("users", "teams", "plans") if isinstance(source.get(key), list)}


def migrate(root: Path, migration_id: str) -> dict[str, Any]:
    from psycopg.types.json import Jsonb
    from app.infrastructure.persistence import postgres_store

    root = root.resolve()
    if not root.is_dir():
        raise ValueError("migration source must be a directory")
    source_sha256 = _source_hash(root)
    with postgres_store.connection() as db:
        previous = db.execute("SELECT source_sha256,report FROM norium_migrations WHERE migration_id=%s", (migration_id,)).fetchone()
    if previous:
        if previous["source_sha256"] != source_sha256:
            raise RuntimeError("migration id already used by a different source")
        return {**previous["report"], "replayed": True}
    documents, blobs = _copy_json_and_blobs(root)
    accounts = _verify_accounts(root)
    tables = _copy_sqlite(root)
    logos = _copy_scheduling_logos(root)
    report = {"migrationId": migration_id, "sourceSha256": source_sha256, "documents": documents,
              "accounts": accounts,
              "blobs": blobs, "schedulingLogos": logos, "tables": tables, "status": "validated"}
    with postgres_store.connection() as db:
        db.execute("INSERT INTO norium_migrations(migration_id,source_sha256,report) VALUES (%s,%s,%s)",
                   (migration_id, source_sha256, Jsonb(report)))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--migration-id", required=True)
    args = parser.parse_args()
    database_url = os.environ.get("NORIUM_DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("NORIUM_DATABASE_URL is required")
    os.environ["NORIUM_POSTGRES_REQUIRED"] = "1"
    os.environ.setdefault("NORA_BRAIN_DATABASE_URL", database_url)
    os.environ.setdefault("NORA_BRAIN_DB_SSLMODE", "verify-full")
    _initialize_schemas(database_url)
    report = migrate(args.source, args.migration_id)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
