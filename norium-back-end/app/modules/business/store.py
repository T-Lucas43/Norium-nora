"""Atomic document mutations, with PostgreSQL row locking across processes."""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Callable, TypeVar

from fastapi import HTTPException

from app.core.identity import require_team_id, require_user_id
from app.core.tenant import get_user_db_path, read_json_file, write_json_file
from app.infrastructure.persistence import document_cache, postgres_store
from app.infrastructure.persistence.json_repository import _lock_for, validate_shape

T = TypeVar("T")
DOMAINS = frozenset({"catalog", "tags", "tag_links", "client_relations", "saved_views", "team_views", "import_previews"})


def path_for(user: dict, domain: str) -> Path:
    if domain not in DOMAINS:
        raise ValueError("Unknown business document")
    # Personal views never share a document with the team's filters.
    owner = require_user_id(user) if domain in {"saved_views", "import_previews"} else require_team_id(user)
    return Path(get_user_db_path(owner, "business_" + domain))


def snapshot(user: dict, domain: str) -> dict:
    return read_json_file(path_for(user, domain), {"schemaVersion": 1, "items": []})


def mutate(user: dict, domain: str, operation: Callable[[dict], T]) -> T:
    path = path_for(user, domain)
    return mutate_path(path, operation)


def mutate_path(path: Path, operation: Callable[[dict], T]) -> T:
    """Internal entry for privacy maintenance of an already enumerated store."""
    fallback = {"schemaVersion": 1, "items": []}
    if postgres_store.configured() or postgres_store.required():
        from psycopg.types.json import Jsonb
        postgres_store.initialize()
        key = postgres_store.canonical_key(path)
        try:
            with postgres_store.connection() as db:
                # Match the quota-before-document lock order of legacy writes.
                postgres_store._quota_lock(db)
                db.execute("INSERT INTO norium_documents(store_key,payload) VALUES (%s,%s) ON CONFLICT DO NOTHING", (key, Jsonb(fallback)))
                row = db.execute("SELECT payload FROM norium_documents WHERE store_key=%s FOR UPDATE", (key,)).fetchone()
                payload = copy.deepcopy(row["payload"])
                validate_shape(payload, fallback, path)
                result = operation(payload)
                postgres_store.check_document_growth(db, key, payload)
                db.execute("UPDATE norium_documents SET payload=%s,revision=revision+1,updated_at=clock_timestamp() WHERE store_key=%s", (Jsonb(payload), key))
            return result
        finally:
            document_cache.forget(key)
    with _lock_for(path):
        payload = read_json_file(path, fallback)
        result = operation(payload)
        write_json_file(path, payload)
        return result


def require_room(items: list, maximum: int = 10_000) -> None:
    if len(items) >= maximum:
        raise HTTPException(409, "Limite de registros atingido. Arquive registros antes de continuar.")
