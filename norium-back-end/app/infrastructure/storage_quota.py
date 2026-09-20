"""Limites e escritas atomicas para artefatos mantidos no volume persistente."""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from threading import RLock

from fastapi import HTTPException

from app.core.tenant import get_data_root


storage_mutation_lock = RLock()
DEFAULT_GLOBAL_QUOTA_BYTES = 4 * 1024 * 1024 * 1024


def configured_bytes(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def directory_bytes(root: Path) -> int:
    if not root.exists():
        return 0
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file() and ".tmp-" not in path.name:
                total += path.stat().st_size
        except OSError:
            continue
    return total


def enforce_storage_quota(workspace_root: Path, incoming_bytes: int, *, workspace_limit: int) -> None:
    if incoming_bytes < 1:
        raise HTTPException(status_code=400, detail="O arquivo esta vazio.")
    workspace_used = directory_bytes(workspace_root)
    if workspace_used + incoming_bytes > workspace_limit:
        raise HTTPException(status_code=413, detail="A cota de armazenamento deste workspace foi atingida.")
    global_limit = configured_bytes("NORIUM_STORAGE_GLOBAL_QUOTA_BYTES", DEFAULT_GLOBAL_QUOTA_BYTES)
    if directory_bytes(get_data_root()) + incoming_bytes > global_limit:
        raise HTTPException(status_code=413, detail="A cota global de armazenamento foi atingida.")


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        temporary.write_bytes(content)
        temporary.replace(path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def remove_managed_file(path: Path, root: Path) -> None:
    try:
        resolved = path.resolve()
        resolved.relative_to(root.resolve())
        resolved.unlink(missing_ok=True)
    except (OSError, ValueError):
        return
