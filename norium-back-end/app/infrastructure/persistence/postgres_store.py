"""Shared PostgreSQL persistence for Norium operational data.

Production is intentionally fail-closed: no JSON/SQLite fallback is allowed
when the database is unavailable. JSONB preserves the existing document
contracts while moving the authoritative bytes and revisions into PostgreSQL.
"""
from __future__ import annotations

import hashlib
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = 1
_guard = threading.RLock()
_pool = None
_initialized = False


class PostgresStoreError(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.getenv("NORIUM_DATABASE_URL", "").strip())


def required() -> bool:
    return os.getenv("NORIUM_POSTGRES_REQUIRED", "0").strip().lower() in {"1", "true", "yes"}


def _pool_instance():
    global _pool
    url = os.getenv("NORIUM_DATABASE_URL", "").strip()
    if not url:
        raise PostgresStoreError("postgresql_configuration_required")
    with _guard:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            from psycopg.rows import dict_row

            sslmode = os.getenv("NORIUM_DATABASE_SSLMODE", "verify-full" if required() else "prefer").strip().lower()
            if required() and sslmode not in {"verify-ca", "verify-full"}:
                raise PostgresStoreError("postgresql_tls_verification_required")
            sslrootcert = os.getenv("NORIUM_DATABASE_SSLROOTCERT", "system" if required() and sslmode == "verify-full" else "").strip()
            connection_kwargs = {"row_factory": dict_row, "connect_timeout": 5, "sslmode": sslmode}
            if sslrootcert:
                connection_kwargs["sslrootcert"] = sslrootcert
            _pool = ConnectionPool(
                conninfo=url,
                min_size=1,
                max_size=max(1, min(10, int(os.getenv("NORIUM_DATABASE_POOL_SIZE", "5")))),
                timeout=5,
                max_waiting=32,
                kwargs=connection_kwargs,
                open=True,
            )
    return _pool


@contextmanager
def connection() -> Iterator[Any]:
    try:
        pooled = _pool_instance().connection(timeout=5)
        db = pooled.__enter__()
    except PostgresStoreError:
        raise
    except Exception as exc:
        raise PostgresStoreError("postgresql_unavailable") from exc
    try:
        yield db
    except BaseException as exc:
        pooled.__exit__(type(exc), exc, exc.__traceback__)
        raise
    else:
        pooled.__exit__(None, None, None)


def initialize() -> None:
    global _initialized
    if _initialized:
        return
    with _guard:
        if _initialized:
            return
        try:
            with connection() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS norium_schema (
                component TEXT PRIMARY KEY, version INTEGER NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())""")
                db.execute("""CREATE TABLE IF NOT EXISTS norium_documents (
                store_key TEXT PRIMARY KEY, payload JSONB NOT NULL,
                revision BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())""")
                db.execute("""CREATE TABLE IF NOT EXISTS norium_blobs (
                object_key TEXT PRIMARY KEY, content BYTEA NOT NULL,
                content_type TEXT NOT NULL, byte_size BIGINT NOT NULL,
                sha256 BYTEA NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                revision BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                CHECK (byte_size = octet_length(content)))""")
                row = db.execute("SELECT version FROM norium_schema WHERE component='core'").fetchone()
                if row is None:
                    db.execute("INSERT INTO norium_schema(component,version) VALUES ('core',%s)", (SCHEMA_VERSION,))
                elif row["version"] != SCHEMA_VERSION:
                    raise PostgresStoreError("postgresql_schema_version_unsupported")
            _initialized = True
        except PostgresStoreError:
            raise
        except Exception as exc:
            raise PostgresStoreError("postgresql_initialization_failed") from exc


def canonical_key(path: str | Path) -> str:
    from app.core.tenant import get_data_root

    root, candidate = get_data_root().resolve(), Path(path).resolve()
    try:
        return candidate.relative_to(root).as_posix()
    except ValueError as exc:
        raise PostgresStoreError("store_path_outside_data_root") from exc


def read_document(store_key: str) -> tuple[bool, Any]:
    initialize()
    with connection() as db:
        row = db.execute("SELECT payload FROM norium_documents WHERE store_key=%s", (store_key,)).fetchone()
    return (False, None) if row is None else (True, row["payload"])


def write_document(store_key: str, payload: Any) -> None:
    from psycopg.types.json import Jsonb

    initialize()
    with connection() as db:
        db.execute("""INSERT INTO norium_documents(store_key,payload) VALUES (%s,%s)
            ON CONFLICT (store_key) DO UPDATE SET payload=EXCLUDED.payload,
            revision=norium_documents.revision+1,updated_at=clock_timestamp()""", (store_key, Jsonb(payload)))


def delete_document(store_key: str) -> bool:
    initialize()
    with connection() as db:
        return db.execute("DELETE FROM norium_documents WHERE store_key=%s", (store_key,)).rowcount == 1


def list_document_keys(prefix: str = "") -> list[str]:
    initialize()
    with connection() as db:
        rows = db.execute("SELECT store_key FROM norium_documents WHERE store_key LIKE %s ORDER BY store_key",
                          (prefix.replace("%", "\\%").replace("_", "\\_") + "%",)).fetchall()
    return [row["store_key"] for row in rows]


def write_blob(object_key: str, content: bytes, content_type: str, metadata: dict[str, Any] | None = None) -> None:
    from psycopg.types.json import Jsonb

    initialize()
    digest = hashlib.sha256(content).digest()
    with connection() as db:
        db.execute("""INSERT INTO norium_blobs(object_key,content,content_type,byte_size,sha256,metadata)
            VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (object_key) DO UPDATE SET
            content=EXCLUDED.content,content_type=EXCLUDED.content_type,byte_size=EXCLUDED.byte_size,
            sha256=EXCLUDED.sha256,metadata=EXCLUDED.metadata,
            revision=norium_blobs.revision+1,updated_at=clock_timestamp()""",
            (object_key, content, content_type, len(content), digest, Jsonb(metadata or {})))


def read_blob(object_key: str) -> dict[str, Any] | None:
    initialize()
    with connection() as db:
        row = db.execute("SELECT content,content_type,byte_size,sha256,metadata,revision,updated_at FROM norium_blobs WHERE object_key=%s",
                         (object_key,)).fetchone()
    return None if row is None else dict(row)


def delete_blob(object_key: str) -> bool:
    initialize()
    with connection() as db:
        return db.execute("DELETE FROM norium_blobs WHERE object_key=%s", (object_key,)).rowcount == 1


def list_blob_keys(prefix: str = "") -> list[str]:
    initialize()
    with connection() as db:
        rows = db.execute("SELECT object_key FROM norium_blobs WHERE object_key LIKE %s ORDER BY object_key",
                          (prefix.replace("%", "\\%").replace("_", "\\_") + "%",)).fetchall()
    return [row["object_key"] for row in rows]


def blob_bytes(prefix: str = "") -> int:
    initialize()
    with connection() as db:
        row = db.execute("SELECT COALESCE(SUM(byte_size),0) AS total FROM norium_blobs WHERE object_key LIKE %s",
                         (prefix.replace("%", "\\%").replace("_", "\\_") + "%",)).fetchone()
    return int(row["total"])


def ping() -> dict[str, Any]:
    initialize()
    with connection() as db:
        row = db.execute("SELECT version FROM norium_schema WHERE component='core'").fetchone()
    if row is None or row["version"] != SCHEMA_VERSION:
        raise PostgresStoreError("postgresql_schema_not_ready")
    return {"status": "ready", "driver": "postgresql", "schema": SCHEMA_VERSION}


@contextmanager
def advisory_lock(name: str) -> Iterator[None]:
    """Hold one session-scoped distributed lock without exposing its key."""
    initialize()
    with connection() as db:
        db.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (name,))
        try:
            yield
        finally:
            db.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (name,))
