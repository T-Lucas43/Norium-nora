"""Registro mínimo e externo aos backups para reaplicar exclusões após restore.

IDs opacos são necessários para encontrar registros restaurados. Não guardar nome,
e-mail, conteúdo, credenciais ou motivo. Operador exporta este arquivo separadamente.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.core.tenant import get_data_root, is_shared_environment

_LOCK = threading.RLock()


def ledger_path() -> Path:
    configured = os.getenv("NORIUM_DELETION_LEDGER_PATH", "").strip()
    root = get_data_root().resolve()
    if not configured and is_shared_environment():
        raise RuntimeError("external_deletion_ledger_configuration_required")
    path = Path(configured).resolve() if configured else root.parent / f".{root.name}.privacy-deletions.jsonl"
    if path.is_relative_to(root):
        raise RuntimeError("deletion_ledger_must_be_outside_data_backups")
    return path


def record_deletion(user_id: str, workspace_id: str = "") -> dict:
    if not user_id or len(user_id) > 160 or len(workspace_id) > 120:
        raise RuntimeError("invalid deletion scope")
    entry = {"version": 1, "userId": user_id, "workspaceId": workspace_id,
             "requestedAt": datetime.now(timezone.utc).isoformat()}
    entry["id"] = hashlib.sha256(f"{user_id}\0{workspace_id}".encode()).hexdigest()
    with _LOCK:
        path = ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = read_ledger(path)
        if not any(item["id"] == entry["id"] for item in existing):
            with path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(entry, separators=(",", ":")) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            if os.name != "nt":
                path.chmod(0o600)
    return entry


def read_ledger(path: Path | None = None) -> list[dict]:
    target = path or ledger_path()
    if not target.exists():
        return []
    rows = []
    for line in target.read_text(encoding="utf-8").splitlines():
        item = json.loads(line)
        if (not isinstance(item, dict) or item.get("version") != 1 or not item.get("userId")
                or item.get("id") != hashlib.sha256(f"{item['userId']}\0{item.get('workspaceId', '')}".encode()).hexdigest()):
            raise RuntimeError("invalid deletion ledger")
        rows.append(item)
    return rows
