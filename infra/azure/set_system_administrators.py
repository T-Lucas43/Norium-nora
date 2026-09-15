"""Apply the explicitly requested administrator roles to the recovered accounts."""
import json
import os
from pathlib import Path
import time
from restore_local_data import az, connect, write_report


def main():
    share, app = connect()
    rg, name = os.environ['RESOURCE_GROUP'], os.environ['APP_NAME']
    file = share.get_file_client('usuarios_db.json')
    store = json.loads(file.download_file().readall())
    users = {u['id']: u for u in store['users']}
    if 'lucas123' not in users or 'norium-admin' not in users:
        raise RuntimeError('expected_recovered_accounts_missing')
    active = [r['name'] for r in az('containerapp', 'revision', 'list', '-g', rg, '-n', name) if r['properties'].get('active')]
    if len(active) != 1:
        raise RuntimeError('expected_single_revision')
    Path('resume-revision.txt').write_text(active[0])
    az('containerapp', 'revision', 'deactivate', '-g', rg, '--revision', active[0])
    for _ in range(45):
        if not az('containerapp', 'replica', 'list', '-g', rg, '-n', name, '--revision', active[0]):
            break
        time.sleep(2)
    else:
        raise RuntimeError('shutdown_timeout')
    snapshot = share.create_snapshot()['snapshot']
    original = file.download_file().readall()
    store = json.loads(original)
    users = {u['id']: u for u in store['users']}
    for uid, role in [('lucas123', 'owner'), ('norium-admin', 'assistant')]:
        users[uid]['systemAdmin'] = True
        users[uid]['systemAdminRole'] = role
        users[uid]['sessionVersion'] = int(users[uid].get('sessionVersion', 0)) + 1
    store['systemOwnerId'] = 'lucas123'
    store.setdefault('adminAudit', []).append({'action': 'restore_requested_system_administrators', 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
    data = json.dumps(store, ensure_ascii=False, indent=2).encode()
    try:
        file.upload_file(data)
        if file.download_file().readall() != data:
            raise RuntimeError('role_write_verification_failed')
    except Exception:
        file.upload_file(original)
        raise
    # A identidade persistida e autoritativa. Retome a mesma revisao sem alinhar
    # variaveis de bootstrap, que so se aplicam a um armazenamento novo.
    az('containerapp', 'revision', 'activate', '-g', rg, '--revision', active[0])
    write_report({'status': 'verified', 'principal': 'lucas123', 'auxiliar': 'norium-admin', 'users': len(store['users']), 'snapshot': snapshot, 'passwordsChanged': False})
    Path('roles-completed.txt').write_text('ok')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        raise SystemExit(1)
