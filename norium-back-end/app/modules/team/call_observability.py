"""Bounded, aggregate-only telemetry. Never accepts labels or diagnostic text."""

from __future__ import annotations

import json
import logging
import math
import time
from collections import Counter


COUNTERS = frozenset({
    "join_attempts", "join_admitted", "join_rejected", "control_errors",
    "client_connected", "client_ice_failed", "client_reconnecting", "client_reconnected",
    "client_sfu_failed", "turn_issued", "turn_errors", "sfu_token_issued", "sfu_errors",
    "recording_started", "recording_stopped", "recording_failed", "recording_deleted",
    "recording_http_errors", "recording_quota_errors", "cleanup_runs", "cleanup_errors",
    "cleanup_expired_active", "cleanup_deleted_completed", "cleanup_deleted_orphans",
    "socket_quota_errors", "socket_rate_errors", "telemetry_rejected",
})
CLIENT_EVENTS = frozenset({"connected", "ice_failed", "reconnecting", "reconnected", "sfu_failed"})
BUCKETS = (0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120)
GAUGES = frozenset({"active_calls", "active_participants", "active_sockets", "call_limit", "socket_limit"})
logger = logging.getLogger("norium.team_calls")


class CallAccessPrivacyFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Uvicorn's HTTP and WS access records contain IPs and WS query tickets.
        # Aggregated application metrics replace these records for call routes.
        return "/api/team-chat" not in record.getMessage()


def configure_call_logging() -> None:
    for name in ("uvicorn.access", "uvicorn.error"):
        target = logging.getLogger(name)
        if not any(isinstance(item, CallAccessPrivacyFilter) for item in target.filters):
            target.addFilter(CallAccessPrivacyFilter())
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


class CallMetrics:
    def __init__(self) -> None:
        self.counters: Counter[str] = Counter()
        self.buckets: Counter[float] = Counter()
        self.connect_count = 0
        self.connect_sum = 0.0
        self.cleanup_last_success = 0.0

    def increment(self, name: str, count: int = 1) -> None:
        if name not in COUNTERS or type(count) is not int or not 0 <= count <= 1_000_000:
            raise ValueError("Unknown metric or invalid count")
        self.counters[name] += count
        if name == "cleanup_runs":
            self.cleanup_last_success = time.time()

    def client_event(self, event: str, duration_ms: int | None = None) -> None:
        if event not in CLIENT_EVENTS:
            raise ValueError("Unknown client event")
        if duration_ms is not None and (type(duration_ms) is not int or not 0 <= duration_ms <= 120_000):
            raise ValueError("Invalid duration")
        self.increment("client_" + event)
        if event == "connected" and duration_ms is not None:
            seconds = duration_ms / 1000
            self.connect_count += 1
            self.connect_sum += seconds
            for boundary in BUCKETS:
                if seconds <= boundary:
                    self.buckets[boundary] += 1

    @staticmethod
    def _gauges(values: dict[str, int]) -> dict[str, int]:
        return {key: value for key, value in values.items() if key in GAUGES and type(value) is int and value >= 0}

    def prometheus(self, gauges: dict[str, int]) -> str:
        lines: list[str] = []
        for name in sorted(COUNTERS):
            metric = f"team_call_{name}_total"
            lines.extend((f"# TYPE {metric} counter", f"{metric} {self.counters[name]}"))
        for name, value in sorted(self._gauges(gauges).items()):
            lines.extend((f"# TYPE team_call_{name} gauge", f"team_call_{name} {value}"))
        prefix = "team_call_connect_seconds"
        lines.append(f"# TYPE {prefix} histogram")
        for boundary in BUCKETS:
            lines.append(f'{prefix}_bucket{{le="{boundary}"}} {self.buckets[boundary]}')
        lines.extend((f'{prefix}_bucket{{le="+Inf"}} {self.connect_count}',
                      f"{prefix}_count {self.connect_count}", f"{prefix}_sum {self.connect_sum:.3f}",
                      "# TYPE team_call_cleanup_last_success_seconds gauge",
                      f"team_call_cleanup_last_success_seconds {self.cleanup_last_success:.3f}"))
        return "\n".join(lines) + "\n"

    def log_snapshot(self, gauges: dict[str, int]) -> None:
        logger.info(json.dumps({"event": "team_call_metrics", "schema": 1,
                               "counters": {k: self.counters[k] for k in sorted(COUNTERS)},
                               "gauges": self._gauges(gauges),
                               "connectCount": self.connect_count, "connectSumSeconds": round(self.connect_sum, 3),
                               "cleanupLastSuccessSeconds": self.cleanup_last_success}, separators=(",", ":")))


class EventBudget:
    """Constant memory sliding refill budget, owned and discarded by a socket."""
    def __init__(self, capacity: int, per_second: float) -> None:
        self.capacity = capacity
        self.per_second = per_second
        self.tokens = float(capacity)
        self.updated = time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + max(0, now - self.updated) * self.per_second)
        self.updated = now
        if not math.isfinite(self.tokens) or self.tokens < 1:
            return False
        self.tokens -= 1
        return True


call_metrics = CallMetrics()
