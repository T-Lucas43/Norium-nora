"""Persistencia JSON atomica reutilizavel pelos dominios do Norium."""

from __future__ import annotations

import copy
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)
_locks_guard = threading.Lock()
_path_locks: dict[str, threading.RLock] = {}


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
    """Lê um banco JSON sem compartilhar por engano o objeto de fallback."""
    file_path = Path(path)
    with _lock_for(file_path):
        if not file_path.exists():
            return _fallback_copy(fallback)
        try:
            return json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            logger.warning("Falha ao ler banco JSON %s: %s", file_path, exc)
            return _fallback_copy(fallback)


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
                json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
                temporary_path = Path(temporary_file.name)

            for attempt in range(7):
                try:
                    os.replace(temporary_path, file_path)
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
