"""Shared accounting rules for binary storage; paths determine the scope."""
from __future__ import annotations

import os
from fastapi import HTTPException

GLOBAL_DEFAULT = 4 * 1024 * 1024 * 1024
WORKSPACE_DEFAULT = 512 * 1024 * 1024


def limit_bytes(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def scope_prefixes(object_key: str) -> tuple[str, str]:
    parts = object_key.split("/")
    if not parts[0].startswith("user_") or len(parts) < 2:
        return "", ""
    account = parts[0] + "/"
    if len(parts) > 2 and parts[1].startswith("workspace_"):
        return account + parts[1] + "/", ""
    # The primary workspace does not include sibling workspaces of the account.
    return account, account + "workspace_"


def enforce_growth(global_used: int, workspace_used: int, previous: int, incoming: int,
                   *, has_workspace: bool) -> None:
    growth = max(0, incoming - previous)
    if not growth:
        return
    if global_used + growth > limit_bytes("NORIUM_STORAGE_GLOBAL_QUOTA_BYTES", GLOBAL_DEFAULT):
        raise HTTPException(413, "A cota global de armazenamento foi atingida.")
    if has_workspace and workspace_used + growth > limit_bytes("NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES", WORKSPACE_DEFAULT):
        raise HTTPException(413, "A cota de armazenamento deste workspace foi atingida.")


# --- Uploads por dono -------------------------------------------------------
# Anexos de equipe, financeiro e tarefas eram gravados em pastas planas na raiz
# (``team_chat_uploads/``, ``finance_uploads/``, ``task_uploads/``) e por isso não
# entravam na cota do workspace. Novos arquivos vão para
# ``user_<dono>/[workspace_<id>/]<pasta>/<nome>``; o registro guarda essa chave
# em ``storageKey``. Arquivos antigos continuam legíveis pelo caminho plano.
QUOTA_WARNING_RATIO = 0.8


def owned_upload_path(base_dir, owner_id: str, name: str, workspace_id: str | None = None):
    from pathlib import Path
    from app.core.request_context import current_workspace_id, normalize_workspace_id
    from app.core.tenant import safe_tenant_id
    base = Path(base_dir)
    workspace = normalize_workspace_id(workspace_id) if workspace_id is not None else current_workspace_id()
    directory = base.parent / f"user_{safe_tenant_id(owner_id)}"
    if workspace != "primary":
        directory = directory / f"workspace_{workspace}"
    return directory / base.name / Path(name).name


def upload_storage_key(base_dir, path) -> str:
    from pathlib import Path
    return Path(path).relative_to(Path(base_dir).parent).as_posix()


def _valid_storage_key(base_dir, name: str, storage_key: str) -> bool:
    from pathlib import PurePosixPath
    parts = PurePosixPath(str(storage_key or "")).parts
    if not parts or str(storage_key).startswith("/") or ".." in parts or "\\" in str(storage_key):
        return False
    if len(parts) not in (3, 4) or not parts[0].startswith("user_"):
        return False
    if len(parts) == 4 and not parts[1].startswith("workspace_"):
        return False
    from pathlib import Path
    return parts[-2] == Path(base_dir).name and parts[-1] == name


def upload_candidates(base_dir, name: str, storage_key: str | None = None) -> list:
    """Caminhos possíveis do anexo: primeiro o do dono, depois o legado plano."""
    from pathlib import Path
    base = Path(base_dir)
    safe = Path(str(name or "")).name
    if not safe or safe != str(name):
        return []
    candidates = []
    if storage_key and _valid_storage_key(base, safe, storage_key):
        candidates.append(base.parent / storage_key)
    candidates.append(base / safe)
    return candidates


def resolve_upload_path(base_dir, name: str, storage_key: str | None = None):
    from app.infrastructure.persistence import files as persistent_files
    for candidate in upload_candidates(base_dir, name, storage_key):
        if persistent_files.exists(candidate):
            return candidate
    return None


def workspace_usage(owner_id: str, workspace_id: str = "primary") -> dict:
    """Uso da cota do escopo ``user_<dono>/[workspace_<id>/]`` (documentos + binários)."""
    from app.core.request_context import normalize_workspace_id
    from app.core.tenant import get_data_root, safe_tenant_id
    from app.infrastructure.persistence import postgres_store
    workspace = normalize_workspace_id(workspace_id)
    account = f"user_{safe_tenant_id(owner_id)}/"
    probe = account + ("" if workspace == "primary" else f"workspace_{workspace}/") + "probe"
    prefix, excluded = scope_prefixes(probe)
    quota = limit_bytes("NORIUM_STORAGE_WORKSPACE_QUOTA_BYTES", WORKSPACE_DEFAULT)
    used = 0
    if postgres_store.configured() or postgres_store.required():
        postgres_store.initialize()
        with postgres_store.connection() as db:
            used = int(postgres_store._storage_usage(db, probe, "blob")["workspace_used"])
    else:
        root = get_data_root().resolve()
        directory = root / prefix.rstrip("/")
        if directory.is_dir():
            for stored in directory.rglob("*"):
                if not stored.is_file() or stored.is_symlink() or ".tmp-" in stored.name:
                    continue
                relative = stored.relative_to(root).as_posix()
                if excluded and relative.startswith(excluded):
                    continue
                used += stored.stat().st_size
    # Legado plano: conte apenas arquivos referenciados por documentos deste
    # workspace, sem atribuir a ele anexos de uma empresa vizinha.
    from app.modules.privacy.storage_catalog import personal_documents, legacy_uploads
    from app.infrastructure.persistence import files
    documents = [(key, payload) for key, payload in personal_documents(owner_id)
                 if key.startswith(prefix) and not (excluded and key.startswith(excluded))]
    if not (postgres_store.configured() or postgres_store.required()):
        for path in legacy_uploads(owner_id, documents=documents):
            metadata = files.info(path)
            if metadata:
                used += int(metadata.get("size") or 0)
    ratio = used / quota if quota else 0.0
    return {
        "usedBytes": used,
        "quotaBytes": quota,
        "percent": round(ratio * 100, 1),
        "warning": ratio >= QUOTA_WARNING_RATIO,
    }
