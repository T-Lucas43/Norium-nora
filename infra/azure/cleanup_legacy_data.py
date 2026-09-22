"""Remove the exact live Azure Files tree after a verified PostgreSQL cutover."""
from __future__ import annotations

import json
import os

from team_call_storage_audit import azure


def main() -> None:
    from azure.storage.fileshare import ShareServiceClient

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
    if storage.get("share") != "norium-data":
        raise RuntimeError("unexpected live share")
    credential = azure("storage", "account", "keys", "list", "-g", group,
                       "--account-name", storage["account"], "--query", "[0].value")
    files = directories = 0
    with ShareServiceClient(f"https://{storage['account']}.file.core.windows.net", credential=credential) as service:
        share = service.get_share_client(storage["share"])
        pending = [""]
        discovered: list[str] = []
        while pending:
            directory = pending.pop()
            for entry in share.list_directories_and_files(directory_name=directory or None):
                name = "/".join(filter(None, (directory, entry["name"])))
                if entry["is_directory"]:
                    pending.append(name)
                    discovered.append(name)
                else:
                    share.get_file_client(name).delete_file()
                    files += 1
        for name in sorted(discovered, key=lambda value: value.count("/"), reverse=True):
            share.get_directory_client(name).delete_directory()
            directories += 1
        if list(share.list_directories_and_files()):
            raise RuntimeError("legacy share is not empty after cleanup")
    print(json.dumps({"status": "legacy_live_data_removed", "files": files, "directories": directories}))


if __name__ == "__main__":
    main()
