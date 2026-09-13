"""Read Azure Files databases in memory; emit aggregate counts, never contents."""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def azure(*args):
    result = subprocess.run(['az', *args, '--output', 'json'], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError('azure_inventory_query_failed')
    return json.loads(result.stdout)


def inspect_databases(entries, download):
    report = {'databaseFiles': 0, 'unreadableDatabases': 0, 'invalidJson': 0,
              'invalidTeamStores': 0, 'secondaryTeamStores': 0, 'recordings': 0,
              'emailConfigured': False}
    for name in entries:
        if not name.endswith('_db.json'):
            continue
        report['databaseFiles'] += 1
        try:
            document = json.loads(download(name).decode('utf-8-sig'))
        except (ValueError, UnicodeError):
            report['invalidJson'] += 1
            continue
        except Exception:
            report['unreadableDatabases'] += 1
            continue
        if name == 'system_email_config_db.json' and isinstance(document, dict):
            report['emailConfigured'] = bool(document.get('enabled') and document.get('passwordEncrypted') and document.get('publicUrl'))
        if name.rsplit('/', 1)[-1] == 'team_chat_db.json':
            if any(part.startswith('workspace_') for part in name.split('/')[:-1]):
                report['secondaryTeamStores'] += 1
            if not isinstance(document, dict) or not isinstance(document.get('recordings', []), list):
                report['invalidTeamStores'] += 1
            else:
                report['recordings'] += len(document.get('recordings', []))
    report['status'] = 'review_required' if any(report[key] for key in (
        'unreadableDatabases', 'invalidJson', 'invalidTeamStores', 'secondaryTeamStores')) else 'passed'
    return report


def list_database_paths(share):
    pending = ['']
    seen = 0
    while pending:
        directory = pending.pop()
        for item in share.list_directories_and_files(directory_name=directory or None):
            seen += 1
            if seen > 100_000:
                raise RuntimeError('storage_inventory_size_limit')
            name = '/'.join(filter(None, [directory, item['name']]))
            if item['is_directory']:
                pending.append(name)
            elif name.endswith('_db.json'):
                yield name


def run(resource_group, app_name):
    from azure.storage.fileshare import ShareServiceClient
    app = azure('containerapp', 'show', '--resource-group', resource_group, '--name', app_name,
                '--query', '{environment:properties.managedEnvironmentId,volumes:properties.template.volumes}')
    mounts = [item for item in app['volumes'] if item.get('storageType') == 'AzureFile' and item.get('name') == 'norium-data']
    if len(mounts) != 1:
        raise RuntimeError('application_data_mount_ambiguous')
    storage = azure('containerapp', 'env', 'storage', 'show', '--resource-group', resource_group,
                    '--name', app['environment'].rsplit('/', 1)[-1], '--storage-name', mounts[0]['storageName'],
                    '--query', '{account:properties.azureFile.accountName,share:properties.azureFile.shareName}')
    keys = azure('storage', 'account', 'keys', 'list', '--resource-group', resource_group,
                 '--account-name', storage['account'], '--query', '[0].value')
    with ShareServiceClient(f"https://{storage['account']}.file.core.windows.net", credential=keys) as service:
        share = service.get_share_client(storage['share'])

        def download(name):
            client = share.get_file_client(name)
            if client.get_file_properties().size > 32 * 1024 * 1024:
                raise RuntimeError('database_size_limit')
            return client.download_file(max_concurrency=1).readall()

        report = inspect_databases(list_database_paths(share), download)
        report['shareSnapshots'] = sum(1 for item in service.list_shares(
            name_starts_with=storage['share'], include_snapshots=True)
            if item.name == storage['share'] and item.snapshot)
    report['shareDeleteRetentionPolicy'] = azure('storage', 'account', 'file-service-properties', 'show',
        '--resource-group', resource_group, '--account-name', storage['account'],
        '--query', 'shareDeleteRetentionPolicy')
    vaults = azure('resource', 'list', '--resource-group', resource_group,
                  '--resource-type', 'Microsoft.RecoveryServices/vaults', '--query', 'length(@)')
    report['backupVaultsInProjectGroup'] = vaults
    report['backupInspectionScope'] = 'project_resource_group_only'
    report['readOnly'] = True
    report['rawDataPersisted'] = False
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resource-group', required=True)
    parser.add_argument('--app-name', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = run(args.resource_group, args.app_name)
    except Exception as error:
        result = {'status': 'failed', 'errorType': type(error).__name__, 'readOnly': True}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
