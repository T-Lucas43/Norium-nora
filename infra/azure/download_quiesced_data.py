"""Snapshot and download an Azure Files data root after writers are stopped."""
from __future__ import annotations

import json
import os
from pathlib import Path

from backup_production_data import download_snapshot, recover_downloaded_sqlite
from team_call_storage_audit import azure


def main() -> None:
    from azure.storage.fileshare import ShareServiceClient

    destination = Path(os.environ.get("MIGRATION_SOURCE", "output/postgres-migration-source")).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise RuntimeError("migration source must be empty")
    group, app_name = os.environ["RESOURCE_GROUP"], os.environ["APP_NAME"]
    app = azure("containerapp", "show", "-g", group, "-n", app_name, "--query",
                "{environment:properties.managedEnvironmentId,volumes:properties.template.volumes}")
    mounts = [item for item in app["volumes"] if item.get("storageType") == "AzureFile" and item.get("name") == "norium-data"]
    if len(mounts) != 1:
        raise RuntimeError("application data mount ambiguous")
    environment = app["environment"].rsplit("/", 1)[-1]
    storage = azure("containerapp", "env", "storage", "show", "-g", group, "-n", environment,
                    "--storage-name", mounts[0]["storageName"],
                    "--query", "{account:properties.azureFile.accountName,share:properties.azureFile.shareName}")
    credential = azure("storage", "account", "keys", "list", "-g", group,
                       "--account-name", storage["account"], "--query", "[0].value")
    with ShareServiceClient(f"https://{storage['account']}.file.core.windows.net", credential=credential) as service:
        snapshot = service.get_share_client(storage["share"]).create_snapshot()["snapshot"]
        report = download_snapshot(service.get_share_client(storage["share"], snapshot=snapshot), destination)
    recover_downloaded_sqlite(destination)
    report.update({"snapshotCreated": True, "sqliteRecovered": True})
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
