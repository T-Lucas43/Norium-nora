"""CI integration gate for the legacy-to-PostgreSQL cutover."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path

from migrate_to_postgres import _initialize_schemas, migrate


def create_source(root: Path) -> None:
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
    os.environ.setdefault("NORA_BRAIN_DATABASE_URL", database_url)
    _initialize_schemas(database_url)
    with tempfile.TemporaryDirectory(prefix="norium-pg-source-") as directory:
        root = Path(directory)
        create_source(root)
        first = migrate(root, "ci-cutover")
        second = migrate(root, "ci-cutover")
        if first["status"] != "validated" or second.get("replayed") is not True:
            raise RuntimeError("migration receipt validation failed")

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
    print("postgres_persistence_ci_passed")


if __name__ == "__main__":
    main()
