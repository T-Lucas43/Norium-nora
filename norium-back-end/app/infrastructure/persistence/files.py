"""Binary persistence compatibility layer backed by PostgreSQL in cutover mode."""
from __future__ import annotations

import mimetypes
import stat
import uuid
from threading import RLock
from pathlib import Path
from typing import Any
from contextlib import contextmanager

from . import postgres_store

_local_binary_lock = RLock()


def _postgres() -> bool:
    return postgres_store.configured() or postgres_store.required()


@contextmanager
def local_write_budget(target: Path, incoming: int):
    from app.core.tenant import get_data_root
    from app.infrastructure.storage_limits import scope_prefixes, enforce_growth
    key = postgres_store.canonical_key(target)
    prefix, excluded = scope_prefixes(key)
    root = get_data_root().resolve()
    with _local_binary_lock:
        global_used = workspace_used = 0
        for stored in root.rglob("*"):
            try:
                metadata = stored.lstat()
            except FileNotFoundError:
                continue
            # One uncached metadata lookup per entry preserves the complete
            # scan under the same writer lock. Never follow a symlink while
            # accounting, including dangling links and temporary names.
            if stat.S_ISLNK(metadata.st_mode):
                raise OSError("storage_symlink_not_supported")
            if not stat.S_ISREG(metadata.st_mode) or ".tmp-" in stored.name:
                continue
            size = metadata.st_size
            global_used += size
            relative = stored.relative_to(root).as_posix()
            if prefix and relative.startswith(prefix) and not (excluded and relative.startswith(excluded)):
                workspace_used += size
        previous = target.stat().st_size if target.exists() else 0
        if prefix:
            from app.modules.privacy.storage_catalog import personal_documents, legacy_uploads
            owner = prefix.split("/", 1)[0].removeprefix("user_")
            documents = [(key, payload) for key, payload in personal_documents(owner)
                         if key.startswith(prefix) and not (excluded and key.startswith(excluded))]
            workspace_used += sum(path.stat().st_size for path in legacy_uploads(owner, documents=documents))
        enforce_growth(global_used, workspace_used, previous, incoming, has_workspace=bool(prefix))
        yield


def write(path: str | Path, content: bytes, *, content_type: str = "", metadata: dict[str, Any] | None = None) -> None:
    target = Path(path)
    if _postgres():
        postgres_store.write_blob(
            postgres_store.canonical_key(target), content,
            content_type or mimetypes.guess_type(target.name)[0] or "application/octet-stream", metadata,
        )
        return
    # Local/development storage has one process writer. Shared deployments
    # use the transaction in write_blob instead of this process-local lock.
    with local_write_budget(target, len(content)):
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.tmp-{uuid.uuid4().hex}")
        try:
            temporary.write_bytes(content)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)


def read(path: str | Path) -> bytes:
    target = Path(path)
    if _postgres():
        blob = postgres_store.read_blob(postgres_store.canonical_key(target))
        if blob is None:
            raise FileNotFoundError(target.name)
        return bytes(blob["content"])
    return target.read_bytes()


def info(path: str | Path) -> dict[str, Any] | None:
    target = Path(path)
    if _postgres():
        blob = postgres_store.read_blob(postgres_store.canonical_key(target))
        return None if blob is None else {
            "size": int(blob["byte_size"]), "contentType": blob["content_type"],
            "metadata": blob["metadata"], "revision": int(blob["revision"]),
            "sha256": bytes(blob["sha256"]).hex(), "updatedAt": blob["updated_at"],
        }
    if not target.is_file():
        return None
    return {"size": target.stat().st_size, "contentType": mimetypes.guess_type(target.name)[0] or "application/octet-stream", "metadata": {}}


def exists(path: str | Path) -> bool:
    return info(path) is not None


def delete(path: str | Path) -> bool:
    target = Path(path)
    if _postgres():
        return postgres_store.delete_blob(postgres_store.canonical_key(target))
    existed = target.is_file()
    target.unlink(missing_ok=True)
    return existed


def list_paths(root: str | Path) -> list[Path]:
    directory = Path(root)
    if _postgres():
        from app.core.tenant import get_data_root
        prefix = postgres_store.canonical_key(directory).rstrip("/") + "/"
        return [get_data_root() / key for key in postgres_store.list_blob_keys(prefix)]
    return sorted(path for path in directory.rglob("*") if path.is_file())
