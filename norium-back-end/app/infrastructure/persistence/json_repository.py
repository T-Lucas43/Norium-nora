"""Persistencia JSON atomica reutilizavel pelos dominios do Norium."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)
_locks_guard = threading.Lock()
_path_locks: dict[str, threading.RLock] = {}
_cache_guard = threading.Lock()
_cache: OrderedDict[str, tuple[tuple[int, int, int], Any, int]] = OrderedDict()
_cache_bytes = 0
_CACHE_BYTES_LIMIT = 16 * 1024 * 1024
_CACHE_ITEMS_LIMIT = 128


class PersistenceError(RuntimeError):
    """A store could not be read safely; callers must never replace it with defaults."""

    def __init__(self, path: str | Path, reason: str):
        self.reason = reason
        # Neither the path (which can contain account IDs) nor bytes/error text
        # belong in logs. This stable opaque identifier supports incident triage.
        self.store_id = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
        logger.error("storage_read_failed store=%s reason=%s", self.store_id, reason)
        super().__init__("Persistencia temporariamente indisponivel.")


def validate_shape(payload: Any, fallback: Any, path: str | Path) -> None:
    """Validate known container fields without rejecting additive legacy fields."""
    if isinstance(fallback, (dict, list)) and not isinstance(payload, type(fallback)):
        raise PersistenceError(path, "schema")
    if isinstance(payload, dict) and isinstance(fallback, dict):
        for key, expected in fallback.items():
            if key in payload and isinstance(expected, (dict, list)):
                validate_shape(payload[key], expected, path)


def _signature(path: Path) -> tuple[int, int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size, stat.st_ino


def _discard_cached(key: str) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= entry[2]


def _remember(key: str, signature: tuple[int, int, int], payload: Any) -> None:
    global _cache_bytes
    size = signature[1]
    with _cache_guard:
        _discard_cached(key)
        if size > _CACHE_BYTES_LIMIT // 2:
            return
        while _cache and (_cache_bytes + size > _CACHE_BYTES_LIMIT or len(_cache) >= _CACHE_ITEMS_LIMIT):
            _discard_cached(next(iter(_cache)))
        _cache[key] = (signature, payload, size)
        _cache_bytes += size


def _lock_for(path: Path) -> threading.RLock:
    normalized = str(path.resolve())
    with _locks_guard:
        return _path_locks.setdefault(normalized, threading.RLock())


def _fallback_copy(fallback: Any) -> Any:
    try:
        return copy.deepcopy(fallback)
    except Exception:
        return fallback


def read_json(path: str | Path, fallback: Any) -> Any:
    """Default only on an initially absent file; all invalid reads fail closed."""
    file_path = Path(path)
    key = str(file_path.resolve())
    with _lock_for(file_path):
        try:
            signature = _signature(file_path)
        except FileNotFoundError:
            with _cache_guard:
                _discard_cached(key)
            return _fallback_copy(fallback)
        except PermissionError as exc:
            raise PersistenceError(file_path, "permission") from exc
        except OSError as exc:
            raise PersistenceError(file_path, "io") from exc
        try:
            with _cache_guard:
                cached = _cache.get(key)
                if cached is not None and cached[0] == signature:
                    _cache.move_to_end(key)
                    validate_shape(cached[1], fallback, file_path)
                    return copy.deepcopy(cached[1])
                _discard_cached(key)
            payload = json.loads(file_path.read_text(encoding="utf-8"))
            validate_shape(payload, fallback, file_path)
            # None is the missing-file sentinel used by domain stores. JSON
            # null must not be confused with absence and initialized over.
            if payload is None:
                raise PersistenceError(file_path, "schema")
            # An external writer may replace the file while it is being read.
            if _signature(file_path) == signature:
                _remember(key, signature, copy.deepcopy(payload))
            else:
                raise PersistenceError(file_path, "changed")
            return payload
        except PermissionError as exc:
            raise PersistenceError(file_path, "permission") from exc
        except OSError as exc:
            raise PersistenceError(file_path, "io") from exc
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise PersistenceError(file_path, "corrupt") from exc


def write_json(path: str | Path, payload: Any) -> None:
    """Grava primeiro em arquivo temporário para nunca expor JSON parcial."""
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)

    with _lock_for(file_path):
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=file_path.parent,
                prefix=f".{file_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                json.dump(payload, temporary_file, ensure_ascii=False, separators=(",", ":"))
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
                temporary_path = Path(temporary_file.name)

            for attempt in range(7):
                try:
                    os.replace(temporary_path, file_path)
                    with _cache_guard:
                        _discard_cached(str(file_path.resolve()))
                    temporary_path = None
                    break
                except PermissionError:
                    if attempt == 6:
                        raise
                    # Leitores concorrentes podem bloquear o destino por poucos
                    # milissegundos no Windows.
                    time.sleep(0.015 * (2**attempt))
        finally:
            if temporary_path and temporary_path.exists():
                temporary_path.unlink(missing_ok=True)
