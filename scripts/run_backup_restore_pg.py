"""Ensaio sintético de DR: PostgreSQL Docker isolado + volume criptografado.

Cria exclusivamente seu container sem porta pública, não toca bancos existentes.
Credencial e chave são efêmeras e nunca impressas. Evidência inclui contagens,
hashes, integridade SQLite, RTO medido e reaplicação do ledger de exclusões.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

from cryptography.fernet import Fernet

REPO = Path(__file__).resolve().parents[1]


def docker(*args: str, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(["docker", *args], input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    if result.returncode:
        # Provider stderr might disclose environment/DSNs; technical label only.
        raise RuntimeError("docker_operation_failed:" + args[0])
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=REPO / "output" / "pos-correcao" / "fase7-backup-restore.json")
    parser.add_argument("--image", default="postgres:16")
    args = parser.parse_args()
    if args.image != "postgres:16":
        parser.error("ensaio limitado à imagem local postgres:16")
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    spec = importlib.util.spec_from_file_location("backup_archive", REPO / "infra" / "azure" / "backup_archive.py")
    backup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backup)
    name = "norium-fase7-restore-" + uuid.uuid4().hex[:12]
    password = secrets.token_urlsafe(32)
    started = time.monotonic()
    receipt = {"synthetic": True, "image": args.image, "externalNetwork": False}
    created = False
    try:
        docker("image", "inspect", args.image)
        with tempfile.TemporaryDirectory(prefix="norium-fase7-dr-", dir=REPO / "output" / "pos-correcao") as temporary:
            base = Path(temporary)
            env = base / "postgres.env"
            env.write_text("POSTGRES_USER=dr_operator\nPOSTGRES_PASSWORD=" + password + "\nPOSTGRES_DB=source_fixture\n", encoding="utf-8")
            docker("run", "-d", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--env-file", str(env), args.image)
            created = True
            env.unlink()
            ready = False
            for _ in range(30):
                try:
                    docker("exec", name, "pg_isready", "-U", "dr_operator", "-d", "source_fixture")
                    ready = True
                    break
                except RuntimeError:
                    time.sleep(0.5)
            if not ready:
                raise RuntimeError("fixture_postgres_not_ready")
            fixture = b"""CREATE TABLE norium_documents(store_key TEXT PRIMARY KEY,payload JSONB);
CREATE TABLE norium_blobs(object_key TEXT PRIMARY KEY,content BYTEA);
CREATE TABLE norium_outbound_receipts(user_id TEXT,workspace TEXT,operation_id TEXT,status TEXT);
INSERT INTO norium_documents VALUES ('user_deleted/profile', '{"synthetic":true}'),('user_neighbor/profile','{"synthetic":true}');
INSERT INTO norium_blobs VALUES ('user_deleted/file', decode('010203','hex')),('user_neighbor/file',decode('040506','hex'));
INSERT INTO norium_outbound_receipts VALUES ('deleted','primary','op_deleted','SENT'),('neighbor','primary','op_neighbor','SENT');
"""
            docker("exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "dr_operator", "-d", "source_fixture", stdin=fixture)
            snapshot_sql = b"""SELECT json_build_object('documents',(SELECT count(*) FROM norium_documents),'blobs',(SELECT count(*) FROM norium_blobs),'receipts',(SELECT count(*) FROM norium_outbound_receipts),'digest',md5((SELECT string_agg(store_key||payload::text,'|' ORDER BY store_key) FROM norium_documents)||(SELECT string_agg(object_key||encode(content,'hex'),'|' ORDER BY object_key) FROM norium_blobs)));"""
            before = docker("exec", "-i", name, "psql", "-X", "-At", "-U", "dr_operator", "-d", "source_fixture", stdin=snapshot_sql).strip()
            dump = docker("exec", name, "pg_dump", "-U", "dr_operator", "-d", "source_fixture", "-Fc", "--no-owner", "--no-acl")
            key = Fernet.generate_key()
            encrypted_dump = Fernet(key).encrypt(dump)
            (base / "postgres.dump.enc").write_bytes(encrypted_dump)
            volume = base / "source-volume"
            volume.mkdir()
            for owner in ("deleted", "neighbor"):
                folder = volume / f"user_{owner}"
                folder.mkdir()
                (folder / "attachment.bin").write_bytes(f"synthetic-{owner}".encode())
            with closing(sqlite3.connect(volume / "ai_costs.sqlite3")) as db:
                db.execute("CREATE TABLE usage(user_id TEXT, amount INTEGER)")
                db.executemany("INSERT INTO usage VALUES (?,?)", [("deleted", 7), ("neighbor", 9)])
                db.commit()
            volume_info = backup.create_backup(volume, base / "volume.enc", key)
            restore_started = time.monotonic()
            docker("exec", name, "createdb", "-U", "dr_operator", "restored_fixture")
            verified_dump = Fernet(key).decrypt((base / "postgres.dump.enc").read_bytes())
            if hashlib.sha256(verified_dump).digest() != hashlib.sha256(dump).digest():
                raise RuntimeError("postgres_dump_hash_mismatch")
            docker("exec", "-i", name, "pg_restore", "-U", "dr_operator", "-d", "restored_fixture", "--no-owner", "--no-acl", "--exit-on-error", stdin=verified_dump)
            restored = base / "restored-volume"
            volume_restore = backup.restore_backup(base / "volume.enc", restored, key)
            after = docker("exec", "-i", name, "psql", "-X", "-At", "-U", "dr_operator", "-d", "restored_fixture", stdin=snapshot_sql).strip()
            if before != after:
                raise RuntimeError("postgres_restore_count_or_hash_mismatch")
            receipt.update({"postgres": json.loads(after), "dumpSha256": hashlib.sha256(dump).hexdigest(),
                            "encryptedDumpSha256": hashlib.sha256(encrypted_dump).hexdigest(),
                            "volume": volume_info, "volumeRestore": volume_restore,
                            "restoreSeconds": round(time.monotonic() - restore_started, 3)})
            # An exclusion occurred AFTER the archived snapshot; reapply it.
            deletion_sql = b"""BEGIN; DELETE FROM norium_documents WHERE store_key LIKE 'user_deleted/%'; DELETE FROM norium_blobs WHERE object_key LIKE 'user_deleted/%'; DELETE FROM norium_outbound_receipts WHERE user_id='deleted'; COMMIT;"""
            docker("exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "dr_operator", "-d", "restored_fixture", stdin=deletion_sql)
            old_env = os.environ.copy()
            os.environ.update({"ENVIRONMENT": "test", "APP_ENV": "test", "NORIUM_DATA_DIR": str(restored), "NORIUM_DATABASE_URL": "", "NORIUM_POSTGRES_REQUIRED": "0"})
            sys.path.insert(0, str(REPO / "norium-back-end"))
            from app.modules.privacy.deletion_ledger import record_deletion, read_ledger
            from app.modules.privacy.router import _purge_personal_files
            record_deletion("deleted")
            for row in read_ledger():
                _purge_personal_files(row["userId"])
            os.environ.clear()
            os.environ.update(old_env)
            if (restored / "user_deleted").exists() or not (restored / "user_neighbor" / "attachment.bin").exists():
                raise RuntimeError("deletion_reapplication_failed")
            with closing(sqlite3.connect(restored / "ai_costs.sqlite3")) as db:
                rows = db.execute("SELECT user_id,amount FROM usage").fetchall()
                if rows != [("neighbor", 9)]:
                    raise RuntimeError("deletion_sqlite_isolation_failed")
            after_delete = json.loads(docker("exec", "-i", name, "psql", "-X", "-At", "-U", "dr_operator", "-d", "restored_fixture", stdin=snapshot_sql))
            if any(after_delete[key] != 1 for key in ("documents", "blobs", "receipts")):
                raise RuntimeError("deletion_postgres_isolation_failed")
            receipt["deletionsReapplied"] = {"scopes": 1, "neighborPreserved": True, "postgresCounts": after_delete}
            receipt["status"] = "restored_verified_and_deletions_reapplied"
    except Exception as exc:
        receipt.update({"status": "failed", "errorType": type(exc).__name__, "errorCode": str(exc) if isinstance(exc, RuntimeError) else "operation_failed"})
    finally:
        if created:
            try:
                docker("rm", "-f", name)
                receipt["fixtureRemoved"] = True
            except RuntimeError:
                receipt["fixtureRemoved"] = False
        receipt["durationSeconds"] = round(time.monotonic() - started, 3)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        print(json.dumps(receipt))
    return 0 if receipt.get("status") == "restored_verified_and_deletions_reapplied" else 1


if __name__ == "__main__":
    raise SystemExit(main())
