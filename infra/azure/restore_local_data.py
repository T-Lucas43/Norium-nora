"""Restore an encrypted local recovery package without logging private data."""
from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import time


def az(*args):
    result = subprocess.run(['az', *args, '-o', 'json'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('azure_command_failed:' + ':'.join(args[:3]))
    return json.loads(result.stdout) if result.stdout.strip() else None


def merge_users(remote, incoming):
    merged = copy.deepcopy(remote)
    users = merged.setdefault('users', [])
    for source in incoming['users']:
        target = next((u for u in users if u['id'] == source['id']), None)
        email_match = next((u for u in users if u['email'].casefold() == source['email'].casefold()), None)
        if (target and target['email'].casefold() != source['email'].casefold()) or (email_match and email_match['id'] != source['id']):
            raise RuntimeError('user_identity_conflict')
        if target:
            # Preserve new-host metadata and any password absent from the backup.
            if source.get('passwordHash'):
                target['passwordHash'] = source['passwordHash']
                target['sessionVersion'] = int(target.get('sessionVersion', 0)) + 1
        else:
            users.append(copy.deepcopy(source))
    for key in ('teams', 'plans'):
        collection = merged.setdefault(key, [])
        identity_key = 'code' if key == 'plans' else 'id'
        known = {item[identity_key] for item in collection}
        collection.extend(copy.deepcopy(item) for item in incoming.get(key, []) if item[identity_key] not in known)
    if not merged.get('systemOwnerId'):
        merged['systemOwnerId'] = incoming.get('systemOwnerId')
    merged.setdefault('adminAudit', []).append({'action': 'local_data_recovery', 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': 'local-backup-2026-09-05'})
    return merged


def align_package(remote, incoming, files):
    """Keep destination IDs for the same email and remap source references."""
    mapping = {}
    for source in incoming['users']:
        target = next((u for u in remote.get('users', []) if u['email'].casefold() == source['email'].casefold()), None)
        if target and target['id'] != source['id']:
            if any(u['id'] == target['id'] for u in incoming['users']):
                raise RuntimeError('identity_mapping_collision')
            mapping[source['id']] = target['id']
    def transform(value):
        if isinstance(value, dict):
            return {mapping.get(k, k): transform(v) for k, v in value.items()}
        if isinstance(value, list):
            return [transform(v) for v in value]
        return mapping.get(value, value) if isinstance(value, str) else value
    normalized = {}
    for filename, data in files.items():
        parts = filename.split('/')
        parts = [mapping.get(p, 'user_' + mapping[p[5:]] if p.startswith('user_') and p[5:] in mapping else p) for p in parts]
        if mapping and filename.endswith('.json'):
            data = json.dumps(transform(json.loads(data.decode('utf-8-sig'))), ensure_ascii=False, indent=2).encode()
        normalized['/'.join(parts)] = data
    return transform(incoming), normalized, mapping


def decode_package():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    blob = Path('payload.enc').read_bytes()
    if hashlib.sha256(blob).hexdigest() != os.environ['PAYLOAD_SHA256']:
        raise RuntimeError('encrypted_package_hash_mismatch')
    document = json.loads(gzip.decompress(AESGCM(base64.b64decode(os.environ['RESTORE_KEY'])).decrypt(blob[:12], blob[12:], None)))
    if document['version'] != 1:
        raise RuntimeError('unsupported_package')
    ids = {u['id'] for u in document['store']['users']}
    files = {}
    for name, encoded in document['files'].items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name:
            raise RuntimeError('unsafe_package_path')
        allowed = path.parts[0] in {'user_' + uid for uid in ids}
        allowed |= len(path.parts) > 2 and path.parts[0] in {'uploads', 'task_uploads', 'finance_uploads', 'team_chat_uploads'} and path.parts[1] in ids
        if not allowed:
            raise RuntimeError('unexpected_package_path')
        data = base64.b64decode(encoded, validate=True)
        if name.endswith('.json'):
            json.loads(data.decode('utf-8-sig'))
        files[name] = data
    return document['store'], files


def connect():
    from azure.storage.fileshare import ShareServiceClient
    rg, app_name = os.environ['RESOURCE_GROUP'], os.environ['APP_NAME']
    app = az('containerapp', 'show', '-g', rg, '-n', app_name)
    if '/subscriptions/50606c6d-e274-4df6-898b-1b550eb6545c/' not in app['id'] or app_name != 'norium-b7bum6defpciy':
        raise RuntimeError('unexpected_destination')
    props = app['properties']
    volumes = [v for v in props['template']['volumes'] if v.get('name') == 'norium-data' and v.get('storageType') == 'AzureFile']
    if len(volumes) != 1:
        raise RuntimeError('ambiguous_data_volume')
    env = (props.get('environmentId') or props['managedEnvironmentId']).rsplit('/', 1)[-1]
    storage = az('containerapp', 'env', 'storage', 'show', '-g', rg, '-n', env, '--storage-name', volumes[0]['storageName'])['properties']['azureFile']
    key = az('storage', 'account', 'keys', 'list', '-g', rg, '--account-name', storage['accountName'], '--query', '[0].value')
    service = ShareServiceClient(f"https://{storage['accountName']}.file.core.windows.net", credential=key)
    return service.get_share_client(storage['shareName']), app


def write_report(report):
    Path('output').mkdir(exist_ok=True)
    Path('output/recovery-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


def main():
    incoming, files = decode_package()
    share, app = connect()
    rg, name = os.environ['RESOURCE_GROUP'], os.environ['APP_NAME']
    revisions = az('containerapp', 'revision', 'list', '-g', rg, '-n', name)
    active = [r['name'] for r in revisions if r['properties'].get('active')]
    if len(active) != 1:
        raise RuntimeError('expected_single_active_revision')
    user_file = share.get_file_client('usuarios_db.json')
    def read_users():
        if not user_file.exists():
            return {'users': [], 'teams': [], 'plans': []}
        return json.loads(user_file.download_file().readall().decode('utf-8-sig'))
    remote = read_users()
    incoming, files, mapping = align_package(remote, incoming, files)
    if os.environ['RESTORE_MODE'] == 'inspect':
        identities = []
        for user in remote.get('users', []):
            same_email = next((u for u in incoming['users'] if u['email'].casefold() == user['email'].casefold()), None)
            same_id = next((u for u in incoming['users'] if u['id'] == user['id']), None)
            identities.append({'destinationId': user['id'], 'sourceIdForSameEmail': (same_email or {}).get('id'), 'idCollision': bool(same_id and same_id['email'].casefold() != user['email'].casefold()), 'hasPasswordHash': bool(user.get('passwordHash')), 'hasTenantDirectory': share.get_directory_client('user_' + user['id']).exists()})
        try:
            merge_users(remote, incoming)
        except RuntimeError:
            write_report({'status': 'identity_review_required', 'identities': identities, 'existingUsers': len(remote.get('users', []))})
            return
    merged = merge_users(remote, incoming)
    report = {'mode': os.environ['RESTORE_MODE'], 'incomingUsers': len(incoming['users']), 'existingUsers': len(remote.get('users', [])), 'resultUsers': len(merged['users']), 'usersWithoutPassword': sum(not u.get('passwordHash') for u in merged['users']), 'mappedExistingIdentities': len(mapping), 'packageFiles': len(files), 'existingFileConflicts': 0, 'copiedFiles': 0}
    pending = {}
    for filename, data in files.items():
        file = share.get_file_client(filename)
        if file.exists():
            if hashlib.sha256(file.download_file().readall()).digest() != hashlib.sha256(data).digest():
                report['existingFileConflicts'] += 1
        else:
            pending[filename] = data
    report['newFiles'] = len(pending)
    if report['existingFileConflicts']:
        write_report(report)
        raise RuntimeError('business_data_conflicts_require_review')
    if os.environ['RESTORE_MODE'] == 'inspect':
        write_report(report)
        return
    # The workflow always reactivates this revision, including after failures.
    Path('resume-revision.txt').write_text(active[0])
    az('containerapp', 'revision', 'deactivate', '-g', rg, '--revision', active[0])
    for _ in range(45):
        replicas = az('containerapp', 'replica', 'list', '-g', rg, '-n', name, '--revision', active[0])
        if not replicas:
            break
        time.sleep(2)
    else:
        raise RuntimeError('replica_shutdown_timeout')
    snapshot = share.create_snapshot()['snapshot']
    report['snapshot'] = snapshot
    write_report(report)
    # Refresh after shutdown so no completed write is lost.
    remote = read_users()
    merged = merge_users(remote, incoming)
    old_users = user_file.download_file().readall() if user_file.exists() else None
    created = []
    wrote_users = False
    try:
        for filename, data in pending.items():
            file = share.get_file_client(filename)
            if file.exists():
                raise RuntimeError('destination_changed_after_preflight')
            parent = PurePosixPath(filename).parent
            for directory in reversed([parent, *parent.parents]):
                if str(directory) != '.':
                    client = share.get_directory_client(str(directory))
                    if not client.exists():
                        client.create_directory()
            created.append(filename)
            file.upload_file(data)
            if hashlib.sha256(file.download_file().readall()).digest() != hashlib.sha256(data).digest():
                raise RuntimeError('uploaded_file_hash_mismatch')
        encoded = json.dumps(merged, ensure_ascii=False, indent=2).encode()
        wrote_users = True
        user_file.upload_file(encoded)
        if user_file.download_file().readall() != encoded:
            raise RuntimeError('users_verification_failed')
    except Exception:
        if wrote_users:
            if old_users is not None:
                user_file.upload_file(old_users)
            else:
                user_file.delete_file()
        for filename in created:
            file = share.get_file_client(filename)
            if file.exists():
                file.delete_file()
        raise
    report.update(copiedFiles=len(created), status='restored_and_hash_verified')
    write_report(report)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # SDK errors may include URLs; keep logs limited to our fixed messages.
        print(str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        raise SystemExit(1)
