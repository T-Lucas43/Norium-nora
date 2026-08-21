"""Metricas leves de latencia e erro sem depender de um provedor externo."""

from __future__ import annotations

import threading
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any


MAX_SAMPLES = 300
_lock = threading.RLock()
_started_at = datetime.now(timezone.utc)
_samples: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=MAX_SAMPLES))


def integration_for_path(path: str) -> str:
    normalized = path.casefold()
    mappings = (
        (("gmail", "email", "mail"), "gmail"),
        (("agenda", "calendar", "google"), "calendar"),
        (("whatsapp", "/chat"), "messaging"),
        (("tarefas", "task"), "tasks"),
        (("financeiro", "gastos"), "finance"),
        (("automacoes", "automation"), "automations"),
        (("brainstorm",), "brainstorm"),
        (("equipe", "team"), "team"),
        (("clientes", "portal"), "clients"),
        (("nora",), "nora"),
    )
    return next((name for needles, name in mappings if any(needle in normalized for needle in needles)), "system")


def record_request(path: str, method: str, status_code: int, duration_ms: float, request_id: str) -> None:
    sample = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": path,
        "method": method,
        "status": status_code,
        "durationMs": round(duration_ms, 2),
        "requestId": request_id,
    }
    with _lock:
        _samples[integration_for_path(path)].append(sample)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return round(ordered[index], 2)


def diagnostics_snapshot() -> dict[str, Any]:
    with _lock:
        groups = {name: list(items) for name, items in _samples.items()}

    integrations: list[dict[str, Any]] = []
    total_requests = 0
    total_errors = 0
    for name, items in sorted(groups.items()):
        durations = [float(item["durationMs"]) for item in items]
        errors = len([item for item in items if int(item["status"]) >= 400])
        total_requests += len(items)
        total_errors += errors
        integrations.append(
            {
                "id": name,
                "requests": len(items),
                "errors": errors,
                "errorRate": round((errors / len(items)) * 100, 2) if items else 0,
                "averageMs": round(sum(durations) / len(durations), 2) if durations else 0,
                "p95Ms": _percentile(durations, 0.95),
                "lastRequestAt": items[-1]["timestamp"] if items else None,
                "lastStatus": items[-1]["status"] if items else None,
            }
        )
    return {
        "status": "ok",
        "startedAt": _started_at.isoformat(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "requests": total_requests,
        "errors": total_errors,
        "integrations": integrations,
    }
