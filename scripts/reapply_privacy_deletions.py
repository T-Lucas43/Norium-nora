"""Reaplica ledger atual sobre um restore offline antes de reabrir acessos.

Não chama provedores: credenciais restauradas são apagadas e sessões revogadas.
Use somente no ambiente isolado restaurado, com --apply e confirmação explícita.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone


async def apply_ledger(ledger: Path) -> dict[str, int]:
    from app.modules.privacy.deletion_ledger import read_ledger
    from app.modules.privacy.router import _purge_personal_files, _anonymize, _purge_due_workspace_directories
    from app.modules.auth import router as auth
    from app.core.tenant import get_data_root, safe_tenant_id, read_json_file, write_json_file
    from app.infrastructure.auth_sessions import erase_personal_sessions
    if not ledger.is_file() or ledger.resolve().is_relative_to(get_data_root().resolve()):
        raise RuntimeError("current_external_deletion_ledger_required")
    rows = read_ledger(ledger)
    accounts, workspaces = 0, 0
    store = await auth.read_user_store()
    for row in rows:
        user_id, workspace_id = row["userId"], row.get("workspaceId", "")
        if not workspace_id:
            _purge_personal_files(user_id)
            erase_personal_sessions(user_id)
            target = auth.find_user(store, user_id)
            if target:
                _anonymize(store, target, row["requestedAt"])
            accounts += 1
        else:
            path = get_data_root() / f"user_{safe_tenant_id(user_id)}" / "plataforma_db.json"
            payload = read_json_file(path, {})
            found = False
            for workspace in payload.get("workspaces", []) if isinstance(payload, dict) else []:
                if str(workspace.get("id") or "") == workspace_id:
                    workspace.update({"active": False, "deletionDueAt": row["requestedAt"]})
                    workspace.pop("purgedAt", None)
                    found = True
            if found:
                write_json_file(path, payload)
                workspaces += _purge_due_workspace_directories()
    await auth.write_user_store(store)
    return {"accountsReapplied": accounts, "workspacesReapplied": workspaces}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--isolated-restore", action="store_true")
    args = parser.parse_args()
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "norium-back-end"))
    from app.modules.privacy.deletion_ledger import read_ledger
    if not args.ledger.is_file():
        parser.error("ledger atual externo obrigatório; ausência não significa nenhuma exclusão")
    rows = read_ledger(args.ledger)
    if not args.apply:
        print(json.dumps({"pendingScopes": len(rows), "dryRun": True}))
        return 0
    if not args.isolated_restore:
        parser.error("--apply exige --isolated-restore; nunca execute no serviço ativo")
    print(json.dumps(asyncio.run(apply_ledger(args.ledger))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
