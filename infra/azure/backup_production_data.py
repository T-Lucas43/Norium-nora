"""Snapshot Azure Files and export only a verified encrypted recovery package.

No application writes/deletes or credential/content logging. The online snapshot
is crash-consistent, not a promise of cross-store business consistency.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path, PurePosixPath

from backup_archive import SQLITE_SUFFIXES, create_backup, restore_backup
from team_call_storage_audit import azure


def safe_relative(name: str) -> Path:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError("unsafe storage path")
    return Path(*path.parts)


def download_snapshot(share, destination: Path) -> dict:
    pending = [""]
    count = total = 0
    while pending:
        directory = pending.pop()
        for entry in share.list_directories_and_files(directory_name=directory or None):
            name = "/".join(filter(None, (directory, entry["name"])))
            target = destination / safe_relative(name)
            if entry["is_directory"]:
                pending.append(name)
                continue
            count += 1
            if count > 100_000:
                raise RuntimeError("backup file count limit exceeded")
            client = share.get_file_client(name)
            size = client.get_file_properties().size
            total += size
            if total > 6 * 1024**3:
                raise RuntimeError("backup size limit exceeded")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                client.download_file(max_concurrency=2).readinto(stream)
            if target.stat().st_size != size:
                raise RuntimeError("snapshot download size mismatch")
    return {"downloadedFiles": count, "downloadedBytes": total}


def recover_downloaded_sqlite(root: Path) -> None:
    # Recovery is applied ONLY to the disposable snapshot copy, never Azure.
    # Opening read/write lets SQLite roll back a hot journal from the snapshot.
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in SQLITE_SUFFIXES:
            with closing(sqlite3.connect(path, timeout=5)) as connection:
                if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise RuntimeError("snapshot sqlite integrity check failed")


def main() -> None:
    from azure.storage.fileshare import ShareServiceClient

    key = os.environ["NORIUM_BACKUP_KEY"].encode("ascii")
    group, app_name = os.environ["RESOURCE_GROUP"], os.environ["APP_NAME"]
    app = azure("containerapp", "show", "-g", group, "-n", app_name, "--query",
                "{environment:properties.managedEnvironmentId,volumes:properties.template.volumes}")
    mounts = [v for v in app["volumes"] if v.get("storageType") == "AzureFile" and v.get("name") == "norium-data"]
    if len(mounts) != 1:
        raise RuntimeError("application data mount ambiguous")
    storage = azure("containerapp", "env", "storage", "show", "-g", group,
                    "-n", app["environment"].rsplit("/", 1)[-1], "--storage-name", mounts[0]["storageName"],
                    "--query", "{account:properties.azureFile.accountName,share:properties.azureFile.shareName}")
    credential = azure("storage", "account", "keys", "list", "-g", group,
                       "--account-name", storage["account"], "--query", "[0].value")
    output = Path("output/production-backup")
    output.mkdir(parents=True, exist_ok=True)
    with ShareServiceClient(f"https://{storage['account']}.file.core.windows.net", credential=credential) as service:
        snapshot = service.get_share_client(storage["share"]).create_snapshot()["snapshot"]
        share = service.get_share_client(storage["share"], snapshot=snapshot)
        with tempfile.TemporaryDirectory(prefix="norium-backup-") as directory:
            root = Path(directory)
            source = root / "snapshot"
            source.mkdir()
            report = download_snapshot(share, source)
            recover_downloaded_sqlite(source)
            archive = output / "production-data.enc"
            report.update(create_backup(source, archive, key))
            report.update(restore_backup(archive, root / "restore-check", key))
            report.update({"snapshot": snapshot, "consistency": "online-crash-consistent",
                           "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                           "runId": os.environ.get("GITHUB_RUN_ID"), "sourceMutated": False})
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK exception messages can contain storage paths and signed URLs.
        print(json.dumps({"status": "failed", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
