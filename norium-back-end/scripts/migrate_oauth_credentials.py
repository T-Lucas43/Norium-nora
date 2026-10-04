"""Offline PostgreSQL OAuth protection, aggregate receipts only.

This tool never prints document IDs or credentials and never opens .env.
Pause writers and prove a backup restore before --apply. It updates only known
per-account/profile JSONB sections; legacy loose files require a separate inventory.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def account_for_key(key: str) -> str | None:
    path = PurePosixPath(key)
    if path.name not in {"perfil_db.json", "gmail_integration_db.json", "calendar_integration_db.json"}:
        return None
    if not path.parts or not re.fullmatch(r"user_[A-Za-z0-9][A-Za-z0-9_.-]{0,179}", path.parts[0]):
        return None
    if len(path.parts) > 3 or any(part in {".", ".."} for part in path.parts):
        return None
    if len(path.parts) == 3 and path.parts[1] != "_account" and not re.fullmatch(r"workspace_[A-Za-z0-9_-]+", path.parts[1]):
        return None
    return path.parts[0][5:]


def transform(user_id: str, payload: dict) -> tuple[dict, dict[str, int]]:
    from app.services import oauth_credentials as credentials
    result = copy.deepcopy(payload)
    counts = {"sections": 0, "legacy": 0, "rewritten": 0}
    for section in sorted(credentials.SECTIONS):
        if section not in result or not result[section]:
            continue
        value = result[section]
        counts["sections"] += 1
        if isinstance(value, dict) and value.get("format") != credentials.FORMAT:
            counts["legacy"] += 1
        recovered, rewrite = credentials.recover(user_id, section, value)
        if rewrite:
            result[section] = credentials.protect(user_id, section, recovered)
            roundtrip, needs_rewrite = credentials.recover(user_id, section, result[section])
            if roundtrip != recovered or needs_rewrite:
                raise RuntimeError("oauth_migration_roundtrip_failed")
            counts["rewritten"] += 1
    return result, counts


def migrate(*, apply: bool) -> dict:
    from app.infrastructure.persistence import postgres_store
    from app.services.oauth_credentials import credential_store
    credential_store()
    if not postgres_store.configured():
        raise RuntimeError("oauth_migration_requires_postgresql")
    postgres_store.initialize()
    totals = {"documents": 0, "sections": 0, "legacy": 0, "rewritten": 0, "applied": apply}
    from psycopg.types.json import Jsonb
    with postgres_store.connection() as db:
        db.execute("SET LOCAL lock_timeout = '5s'")
        if apply:
            # Follow the same lock order as document writers, even though apply
            # is an offline operation with all writers explicitly paused.
            postgres_store._quota_lock(db)
            db.execute("LOCK TABLE norium_documents IN SHARE ROW EXCLUSIVE MODE")
        last = ""
        while True:
            rows = db.execute("SELECT store_key,payload FROM norium_documents WHERE store_key>%s ORDER BY store_key LIMIT 200", (last,)).fetchall()
            if not rows:
                break
            for row in rows:
                last = row["store_key"]
                user_id = account_for_key(last)
                if not user_id or not isinstance(row["payload"], dict):
                    continue
                value, counts = transform(user_id, row["payload"])
                totals["documents"] += 1
                for name, count in counts.items():
                    totals[name] += count
                if apply and counts["rewritten"]:
                    postgres_store.check_document_growth(db, last, value)
                    db.execute("UPDATE norium_documents SET payload=%s,revision=revision+1,updated_at=clock_timestamp() WHERE store_key=%s", (Jsonb(value), last))
    totals["rewritten"] = totals["rewritten"] if apply else 0
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--writers-paused", action="store_true")
    parser.add_argument("--backup-restore-verified", action="store_true")
    args = parser.parse_args()
    if args.apply and not (args.writers_paused and args.backup_restore_verified):
        parser.error("--apply requires confirmed offline writers and a verified backup restore")
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    try:
        result = migrate(apply=args.apply)
    except Exception:
        print("oauth_migration_failed: validate keys, database and envelopes offline; no values logged", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
