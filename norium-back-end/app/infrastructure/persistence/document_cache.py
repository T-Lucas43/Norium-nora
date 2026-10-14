"""Cache em memória dos documentos do PostgreSQL com fila por usuário (LRU).

Cada usuário ocupa uma posição na fila. Quando um usuário novo entra e a fila está
cheia, o usuário usado há mais tempo sai com todos os seus documentos. Documentos do
sistema (fora de ``user_*``) ficam numa área própria. Há também um limite total de bytes.

É seguro porque o backend roda com um único processo web (``--workers 1``) e toda
gravação passa por ``postgres_store.write_document``/``delete_document``, que atualizam
o cache na mesma hora (write-through). Uma validade curta protege contra escritas
feitas fora deste processo (scripts de migração, manutenção).
"""

from __future__ import annotations

import copy
import json
import os
import threading
import time
from collections import OrderedDict
from typing import Any

_MISSING = object()
_SYSTEM = "__system__"
_guard = threading.Lock()
# dono -> (chave -> (expira_em, payload ou _MISSING, bytes))
_owners: "OrderedDict[str, OrderedDict[str, tuple[float, Any, int]]]" = OrderedDict()
_bytes = 0
stats = {"hits": 0, "misses": 0, "evicted_users": 0}


def enabled() -> bool:
    # Testes automatizados usam bancos falsos e reiniciados; ali o cache só liga se pedido.
    default = "0" if os.getenv("ENVIRONMENT", "").strip().lower() in {"test", "testing"} else "1"
    return os.getenv("NORIUM_DOCUMENT_CACHE", default).strip().lower() not in {"0", "false", "no", "off"}


def _max_users() -> int:
    try:
        return max(1, int(os.getenv("NORIUM_DOCUMENT_CACHE_USERS", "25")))
    except ValueError:
        return 25


def _max_bytes() -> int:
    try:
        return max(1, int(os.getenv("NORIUM_DOCUMENT_CACHE_MB", "24"))) * 1024 * 1024
    except ValueError:
        return 24 * 1024 * 1024


def _ttl_seconds() -> float:
    try:
        return max(1.0, float(os.getenv("NORIUM_DOCUMENT_CACHE_TTL", "300")))
    except ValueError:
        return 300.0


def owner_of(store_key: str) -> str:
    head = str(store_key).split("/", 1)[0]
    return head if head.startswith("user_") else _SYSTEM


def _size_of(payload: Any) -> int:
    if payload is _MISSING:
        return 64
    try:
        return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str))
    except (TypeError, ValueError):
        return 1024 * 1024


def _drop_owner(owner: str) -> None:
    global _bytes
    entries = _owners.pop(owner, None)
    if entries:
        _bytes -= sum(entry[2] for entry in entries.values())


def _drop_key(owner: str, store_key: str) -> None:
    global _bytes
    entries = _owners.get(owner)
    if entries is None:
        return
    entry = entries.pop(store_key, None)
    if entry is not None:
        _bytes -= entry[2]
    if not entries and owner != _SYSTEM:
        _owners.pop(owner, None)


def _evict_for(owner: str, incoming: int) -> None:
    """Fila de usuários: sai o usado há mais tempo até caber o novo."""
    users = [name for name in _owners if name != _SYSTEM]
    while owner != _SYSTEM and owner not in _owners and len(users) >= _max_users():
        oldest = users.pop(0)
        _drop_owner(oldest)
        stats["evicted_users"] += 1
    while _bytes + incoming > _max_bytes() and _owners:
        candidates = [name for name in _owners if name not in {owner, _SYSTEM}]
        if candidates:
            _drop_owner(candidates[0])
            stats["evicted_users"] += 1
            continue
        target = _owners.get(owner) or _owners.get(_SYSTEM)
        if not target:
            break
        oldest_key = next(iter(target))
        _drop_key(owner if owner in _owners else _SYSTEM, oldest_key)
        if not target:
            break


def get(store_key: str) -> tuple[bool, bool, Any]:
    """Retorna (encontrado_no_cache, existe, payload copiado)."""
    if not enabled():
        return False, False, None
    owner = owner_of(store_key)
    with _guard:
        entries = _owners.get(owner)
        entry = entries.get(store_key) if entries else None
        if entry is None or entry[0] < time.monotonic():
            if entry is not None:
                _drop_key(owner, store_key)
            stats["misses"] += 1
            return False, False, None
        _owners.move_to_end(owner)
        entries.move_to_end(store_key)
        stats["hits"] += 1
        payload = entry[1]
    if payload is _MISSING:
        return True, False, None
    return True, True, copy.deepcopy(payload)


def put(store_key: str, exists: bool, payload: Any) -> None:
    if not enabled():
        return
    global _bytes
    value = copy.deepcopy(payload) if exists else _MISSING
    size = _size_of(value)
    if size > _max_bytes() // 4:
        forget(store_key)
        return
    owner = owner_of(store_key)
    with _guard:
        _drop_key(owner, store_key)
        _evict_for(owner, size)
        entries = _owners.setdefault(owner, OrderedDict())
        entries[store_key] = (time.monotonic() + _ttl_seconds(), value, size)
        _owners.move_to_end(owner)
        _bytes += size


def forget(store_key: str) -> None:
    with _guard:
        _drop_key(owner_of(store_key), store_key)


def forget_prefix(prefix: str) -> int:
    """Invalida também documentos antigos que não existem mais no banco."""
    removed = 0
    with _guard:
        for owner, entries in list(_owners.items()):
            for key in list(entries):
                if key.startswith(prefix):
                    _drop_key(owner, key)
                    removed += 1
    return removed


def clear() -> None:
    global _bytes
    with _guard:
        _owners.clear()
        _bytes = 0


def snapshot() -> dict[str, Any]:
    with _guard:
        return {
            "users": len([name for name in _owners if name != _SYSTEM]),
            "documents": sum(len(entries) for entries in _owners.values()),
            "bytes": _bytes,
            **stats,
        }
