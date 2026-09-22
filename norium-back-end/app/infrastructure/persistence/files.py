"""Binary persistence compatibility layer backed by PostgreSQL in cutover mode."""
from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from . import postgres_store


def _postgres() -> bool:
    return postgres_store.configured() or postgres_store.required()


def write(path: str | Path, content: bytes, *, content_type: str = "", metadata: dict[str, Any] | None = None) -> None:
    target = Path(path)
    if _postgres():
        postgres_store.write_blob(
            postgres_store.canonical_key(target), content,
            content_type or mimetypes.guess_type(target.name)[0] or "application/octet-stream", metadata,
        )
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


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
