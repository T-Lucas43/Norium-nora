"""Prepare a backup secret or download/restore-check the encrypted Actions artifact.

Run only on the operator's computer. Prints aggregate results, never credentials
or records. The destination directory must already have owner-only permissions.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path

import requests
from cryptography.fernet import Fernet
from nacl.public import PublicKey, SealedBox

from backup_archive import restore_backup

REPOSITORY = "T-Lucas43/Norium-nora"
API = f"https://api.github.com/repos/{REPOSITORY}"


def github_session() -> requests.Session:
    result = subprocess.run(["git", "credential", "fill"],
                            input="protocol=https\nhost=github.com\nusername=T-Lucas43\n\n",
                            capture_output=True, text=True, check=True)
    credential = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {credential['password']}",
                            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    return session


def initialize_key(destination: Path) -> bytes:
    key_path = destination / "recovery.key"
    if key_path.exists():
        key = key_path.read_bytes()
        Fernet(key)  # Reject a damaged key rather than rotate an existing backup.
    else:
        key = Fernet.generate_key()
        with key_path.open("xb") as stream:
            stream.write(key)
    return key


def prepare(session: requests.Session, destination: Path) -> None:
    key = initialize_key(destination)
    response = session.get(f"{API}/actions/secrets/public-key", timeout=30)
    response.raise_for_status()
    public = response.json()
    encrypted = SealedBox(PublicKey(base64.b64decode(public["key"]))).encrypt(key)
    response = session.put(f"{API}/actions/secrets/NORIUM_PRODUCTION_BACKUP_KEY", timeout=30,
                           json={"key_id": public["key_id"], "encrypted_value": base64.b64encode(encrypted).decode()})
    response.raise_for_status()
    print(json.dumps({"status": "backup_secret_ready", "localKeyStored": True}))


def retrieve(session: requests.Session, destination: Path, run_id: int) -> None:
    response = session.get(f"{API}/actions/runs/{run_id}", timeout=30)
    response.raise_for_status()
    if response.json().get("conclusion") != "success":
        raise ValueError("backup workflow must succeed first")
    response = session.get(f"{API}/actions/runs/{run_id}/artifacts", timeout=30)
    response.raise_for_status()
    candidates = [a for a in response.json()["artifacts"] if a["name"] == f"production-backup-{run_id}" and not a["expired"]]
    if len(candidates) != 1:
        raise ValueError("backup artifact missing or ambiguous")
    response = session.get(f"{API}/actions/artifacts/{candidates[0]['id']}/zip", timeout=180)
    response.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        if set(archive.namelist()) != {"production-data.enc", "report.json"}:
            raise ValueError("unexpected backup artifact contents")
        report = json.loads(archive.read("report.json"))
        payload = archive.read("production-data.enc")
    if hashlib.sha256(payload).hexdigest() != report["sha256"]:
        raise ValueError("downloaded encrypted package hash mismatch")
    package = destination / "production-data.enc"
    with package.open("xb") as stream:
        stream.write(payload)
    result = restore_backup(package, destination / "restore-verification", (destination / "recovery.key").read_bytes())
    report["localVerification"] = result
    (destination / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "local_backup_restored_and_verified", "files": result["files"],
                      "sqliteChecked": result["sqliteChecked"], "sha256": report["sha256"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("init", "prepare", "retrieve"))
    parser.add_argument("destination", type=Path)
    parser.add_argument("--run-id", type=int)
    args = parser.parse_args()
    if not args.destination.is_dir():
        parser.error("create a private destination directory first")
    if args.mode == "init":
        initialize_key(args.destination)
        print(json.dumps({"status": "local_recovery_key_ready"}))
    else:
        with github_session() as session:
            if args.mode == "prepare":
                prepare(session, args.destination)
            elif args.run_id:
                retrieve(session, args.destination, args.run_id)
            else:
                parser.error("--run-id is required for retrieval")
