"""Bound Gmail reads and surface throttling without retaining message contents."""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections import deque
from googleapiclient.errors import HttpError


class GmailRateLimitError(RuntimeError):
    def __init__(self, retry_after: int = 30):
        self.retry_after = max(1, min(int(retry_after), 120))
        super().__init__("O Gmail limitou temporariamente as consultas. Aguarde alguns segundos e tente novamente.")


RATE_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"})
_lock = threading.Lock()
_budgets: dict[str, deque[tuple[float, int]]] = {}
_paused: dict[str, float] = {}
# Leave a margin below the current 6,000 units/user/min for sends and other clients.
READ_UNITS_PER_MINUTE = 4_000


def provider_throttle(error: Exception) -> GmailRateLimitError | None:
    if not isinstance(error, HttpError):
        return None
    try:
        status = int(error.resp.status)
    except (ValueError, TypeError, AttributeError):
        return None
    if status != 429:
        try:
            payload = json.loads(error.content)
            reasons = {str(item.get("reason")) for item in payload.get("error", {}).get("errors", []) if isinstance(item, dict)}
        except (ValueError, TypeError, AttributeError):
            return None
        if not (status == 403 and reasons & RATE_REASONS):
            return None
    try:
        delay = int(error.resp.get("retry-after", 30))
    except (TypeError, ValueError):
        delay = 30
    return GmailRateLimitError(delay)


def reserve_read(user_id: str, units: int, *, background: bool = False) -> None:
    key = hashlib.sha256(str(user_id).encode()).hexdigest()
    now = time.monotonic()
    with _lock:
        # Only counters, no credentials, IDs, headers or bodies. Bound idle-account entries.
        for stale in [item for item, entries in _budgets.items() if not entries or entries[-1][0] <= now - 120]:
            _budgets.pop(stale, None)
            _paused.pop(stale, None)
        budget = _budgets.setdefault(key, deque())
        while budget and budget[0][0] <= now - 60:
            budget.popleft()
        paused = _paused.get(key, 0) - now
        if paused > 0:
            raise GmailRateLimitError(math.ceil(paused))
        ceiling = READ_UNITS_PER_MINUTE - 500 if background else READ_UNITS_PER_MINUTE
        if sum(cost for _, cost in budget) + units > ceiling:
            raise GmailRateLimitError(math.ceil(60 - (now - budget[0][0])) if budget else 60)
        budget.append((now, units))


def raise_if_throttled(user_id: str, error: Exception) -> None:
    throttle = provider_throttle(error)
    if throttle:
        key = hashlib.sha256(str(user_id).encode()).hexdigest()
        with _lock:
            _paused[key] = time.monotonic() + throttle.retry_after
        raise throttle from None


def execute_read(user_id: str, request, units: int = 20):
    reserve_read(user_id, units)
    try:
        return request.execute()
    except Exception as error:
        raise_if_throttled(user_id, error)
        raise
