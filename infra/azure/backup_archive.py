"""Encrypted full-volume backup and deterministic restore verification.

The public tenant export is intentionally redacted and is not a DR backup. This
tool preserves the complete data root, encrypts it before it leaves the host,
and verifies every restored byte plus SQLite integrity.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


MANIFEST = "norium-backup-manifest.json"
SQLITE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}


def _safe_files(root: Path):
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("backup source must not contain symbolic links")
        # The SQLite backup API folds committed WAL pages into the snapshot.
        # Restoring an old WAL/journal next to it can overwrite that snapshot.
        if any(path.name.endswith(suffix) and path.with_name(path.name[:-len(suffix)]).suffix.lower() in SQLITE_SUFFIXES
               for suffix in ("-wal", "-shm", "-journal")):
            continue
        if path.is_file() and ".tmp-" not in path.name and path.name != MANIFEST:
            yield path, path.relative_to(root).as_posix()


def _sqlite_snapshot(path: Path) -> bytes:
    with tempfile.TemporaryDirectory(prefix="norium-sqlite-backup-") as directory:
        target = Path(directory) / "snapshot.sqlite3"
        source_uri = path.resolve().as_uri() + "?mode=ro"
        deadline = time.monotonic() + 60
        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise TimeoutError("sqlite snapshot exceeded its time budget")
        with closing(sqlite3.connect(source_uri, uri=True, timeout=10)) as source, closing(sqlite3.connect(target)) as destination:
            with destination:
                source.backup(destination, pages=256, progress=progress)
        return target.read_bytes()


def create_backup(source: Path, destination: Path, key: bytes) -> dict:
    source = source.resolve()
    if not source.is_dir():
        raise ValueError("backup source must be a directory")
    if destination.resolve().is_relative_to(source):
        raise ValueError("backup destination must be outside the source")
    manifest = {"schema": 1, "files": []}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, relative in _safe_files(source):
            content = _sqlite_snapshot(path) if path.suffix.lower() in SQLITE_SUFFIXES else path.read_bytes()
            archive.writestr(relative, content)
            manifest["files"].append({
                "path": relative,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "kind": "sqlite" if path.suffix.lower() in SQLITE_SUFFIXES else "file",
            })
        archive.writestr(MANIFEST, json.dumps(manifest, sort_keys=True, separators=(",", ":")))
    encrypted = Fernet(key).encrypt(stream.getvalue())
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(encrypted)
    temporary.replace(destination)
    return {"files": len(manifest["files"]), "encryptedBytes": len(encrypted)}


def restore_backup(backup: Path, destination: Path, key: bytes) -> dict:
    try:
        decrypted = Fernet(key).decrypt(backup.read_bytes())
    except InvalidToken as exc:
        raise ValueError("backup authentication failed") from exc
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("restore destination must be empty")
    with zipfile.ZipFile(io.BytesIO(decrypted), "r") as archive:
        manifest = json.loads(archive.read(MANIFEST))
        expected = {item["path"]: item for item in manifest.get("files", [])}
        members = [item for item in archive.infolist() if item.filename != MANIFEST]
        if set(expected) != {item.filename for item in members}:
            raise ValueError("backup manifest does not match archive")
        for member in members:
            relative = Path(member.filename)
            if relative.is_absolute() or ".." in relative.parts or member.is_dir():
                raise ValueError("unsafe backup member")
            content = archive.read(member)
            item = expected[member.filename]
            if len(content) != item["size"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
                raise ValueError("backup hash mismatch")
            target = (destination / relative).resolve()
            target.relative_to(destination)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    sqlite_checked = 0
    for item in expected.values():
        if item["kind"] != "sqlite":
            continue
        with closing(sqlite3.connect(destination / item["path"])) as connection:
            result = connection.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise ValueError(f"SQLite integrity check failed: {item['path']}")
        sqlite_checked += 1
    return {"files": len(expected), "sqliteChecked": sqlite_checked, "status": "restored_and_verified"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("create", "restore"))
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    raw_key = os.environ.get("NORIUM_BACKUP_KEY", "").encode("ascii")
    if not raw_key:
        raise SystemExit("NORIUM_BACKUP_KEY is required")
    result = (
        create_backup(Path(args.source), Path(args.destination), raw_key)
        if args.mode == "create"
        else restore_backup(Path(args.source), Path(args.destination), raw_key)
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
