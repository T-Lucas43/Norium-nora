"""CI integration gate for the legacy-to-PostgreSQL cutover."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from urllib.parse import urlparse

from migrate_to_postgres import _initialize_schemas, migrate


def require_local_test_database(database_url: str) -> None:
    parsed = urlparse(database_url)
    if (os.getenv("ENVIRONMENT") != "test" or parsed.scheme not in {"postgres", "postgresql"}
            or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or os.getenv("NORA_BRAIN_DATABASE_URL", database_url) != database_url):
        raise RuntimeError("This CI gate requires one local disposable test database")


def verify_binary_quotas() -> None:
    from fastapi import HTTPException
    from app.infrastructure.persistence import postgres_store

    prefix = "user_ci-quota-" + uuid.uuid4().hex
    other = prefix + "-other"
    seed = prefix + "/files/seed.bin"
    candidates = [prefix + "/files/a.bin", prefix + "/files/b.bin"]
    sibling = prefix + "/workspace_sibling/files/c.bin"
    other_key = other + "/files/d.bin"
    overflow = prefix + "/files/overflow.bin"
    all_keys = [seed, *candidates, sibling, other_key, overflow]
    baseline_bytes = postgres_store.blob_bytes()
    limits = {"NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": str(baseline_bytes + 100),
              "NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES": "10"}
    try:
        with patch.dict(os.environ, limits):
            postgres_store.write_blob(seed, b"1234", "application/octet-stream")
            real_connection = postgres_store.connection
            barrier = Barrier(2, timeout=10)
            backend_pids: set[int] = set()

            @contextmanager
            def concurrent_connection():
                with real_connection() as db:
                    backend_pids.add(db.info.backend_pid)
                    barrier.wait()
                    yield db

            def write_candidate(key: str) -> str:
                try:
                    postgres_store.write_blob(key, b"12345", "application/octet-stream")
                    return "accepted"
                except HTTPException as exc:
                    if exc.status_code != 413:
                        raise
                    return "rejected"

            with patch.object(postgres_store, "connection", concurrent_connection), ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(write_candidate, candidates))
            if sorted(outcomes) != ["accepted", "rejected"] or len(backend_pids) != 2:
                raise RuntimeError("cross-connection quota concurrency validation failed")
            if postgres_store.blob_bytes(prefix + "/") != 9:
                raise RuntimeError("quota rejection must not persist overflow content")

            postgres_store.write_blob(seed, b"12", "application/octet-stream")
            postgres_store.write_blob(overflow, b"123", "application/octet-stream")
            # Primary, secondary workspace and another user have independent budgets.
            postgres_store.write_blob(sibling, b"1" * 10, "application/octet-stream")
            postgres_store.write_blob(other_key, b"1" * 10, "application/octet-stream")
            with patch.dict(os.environ, {"NORIUM_STORAGE_GLOBAL_QUOTA_BYTES": str(postgres_store.blob_bytes())}):
                try:
                    postgres_store.write_blob(other_key, b"1" * 11, "application/octet-stream")
                except HTTPException as exc:
                    if exc.status_code != 413 or "global" not in str(exc.detail):
                        raise
                else:
                    raise RuntimeError("global quota must reject growth")
            if postgres_store.read_blob(other_key)["byte_size"] != 10:
                raise RuntimeError("rejected replacement must retain original bytes")
    finally:
        for key in all_keys:
            postgres_store.delete_blob(key)
    print("postgres_binary_quota_ci_passed")


def create_source(root: Path) -> None:
    (root / "usuarios_db.json").write_text(json.dumps({
        "users": [{"id": "ci-user", "email": "ci@example.invalid", "passwordHash": "synthetic-hash"}],
        "teams": [{"id": "ci-team"}], "plans": [{"id": "ci-plan"}],
    }), encoding="utf-8")
    profile = root / "user_ci-user" / "perfil_db.json"
    profile.parent.mkdir(parents=True)
    profile.write_text(json.dumps({"nome": "Teste PostgreSQL", "email": "ci@example.invalid"}), encoding="utf-8")
    binary = root / "user_ci-user" / "nora_files" / "nora_file_00000000000000000000000000000000.pdf"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"%PDF-1.4\n%%EOF")

    scheduling = sqlite3.connect(root / "scheduling.sqlite3")
    scheduling.executescript((Path(__file__).parents[2] / "norium-back-end/app/modules/scheduling/migrations/001_initial.sql").read_text(encoding="utf-8"))
    scheduling.execute("""INSERT INTO scheduling_services
        (id,tenant_id,workspace_id,owner_id,name,description,durations_json,color,location_type,location,instructions,
         buffer_before,buffer_after,capacity,minimum_notice_minutes,maximum_days,slot_interval,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        ("service_ci", "ci-user", "primary", "ci-user", "Teste", "", "[30]", "#000000", "online", "", "",
         0, 0, 1, 0, 60, 15, 1, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"))
    scheduling.commit()
    scheduling.close()

    automations = sqlite3.connect(root / "automation_events.sqlite3")
    automations.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT,automation_id TEXT,
        fingerprint TEXT,event TEXT,status TEXT,created_at TEXT,finished_at TEXT,error TEXT,lease_until REAL)""")
    automations.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        ("job_ci", "ci-user", "primary", "automation_ci", "hash", "{}", "completed",
                         "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:01+00:00", None, 0))
    automations.commit()
    automations.close()


def main() -> None:
    database_url = os.environ["NORIUM_DATABASE_URL"]
    require_local_test_database(database_url)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.environ.setdefault("NORA_BRAIN_DATABASE_URL", database_url)
    _initialize_schemas(database_url)
    with tempfile.TemporaryDirectory(prefix="norium-pg-source-") as directory:
        root = Path(directory)
        create_source(root)
        first = migrate(root, "ci-cutover")
        second = migrate(root, "ci-cutover")
        if first["status"] != "validated" or second.get("replayed") is not True:
            raise RuntimeError("migration receipt validation failed")
        if first["accounts"] != {"users": 1, "teams": 1, "plans": 1}:
            raise RuntimeError("user registry count validation failed")

    from app.core.tenant import get_user_db_path, read_json_file
    from app.infrastructure.persistence import files as persistent_files
    from app.modules.scheduling.repository import SchedulingRepository

    profile = read_json_file(get_user_db_path("ci-user", "perfil"), {})
    if profile.get("nome") != "Teste PostgreSQL":
        raise RuntimeError("JSONB document validation failed")
    pdf = Path(get_user_db_path("ci-user", "perfil")).parent / "nora_files/nora_file_00000000000000000000000000000000.pdf"
    if persistent_files.read(pdf) != b"%PDF-1.4\n%%EOF":
        raise RuntimeError("BYTEA object validation failed")
    service = SchedulingRepository().one("SELECT id FROM scheduling_services WHERE id=?", ("service_ci",))
    if not service:
        raise RuntimeError("typed scheduling validation failed")
    verify_binary_quotas()
    print("postgres_persistence_ci_passed")


if __name__ == "__main__":
    main()
