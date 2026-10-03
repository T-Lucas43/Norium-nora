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
