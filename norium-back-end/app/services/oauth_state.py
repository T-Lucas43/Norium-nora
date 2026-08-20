from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any


def oauth_attempts(payload: Any) -> list[dict[str, Any]]:
    """Normaliza o formato legado de tentativa unica e o formato concorrente."""
    if not isinstance(payload, dict):
        return []
    raw_attempts = payload.get("attempts")
    if isinstance(raw_attempts, list):
        return [item for item in raw_attempts if isinstance(item, dict)]
    if payload.get("state"):
        return [payload]
    return []


def active_oauth_attempts(
    payload: Any,
    *,
    ttl_seconds: int,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    current = now or datetime.now(timezone.utc)
    active: list[dict[str, Any]] = []
    for attempt in oauth_attempts(payload):
        try:
            created_at = datetime.fromisoformat(str(attempt.get("createdAt") or ""))
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if current - created_at <= timedelta(seconds=ttl_seconds):
            active.append(attempt)
    return active


def find_oauth_attempt(payload: Any, state: str | None) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    attempts = oauth_attempts(payload)
    if not state:
        return None, attempts
    match: dict[str, Any] | None = None
    remaining: list[dict[str, Any]] = []
    for attempt in attempts:
        saved_state = str(attempt.get("state") or "")
        if match is None and saved_state and secrets.compare_digest(state, saved_state):
            match = attempt
        else:
            remaining.append(attempt)
    return match, remaining


def oauth_attempts_payload(attempts: list[dict[str, Any]]) -> dict[str, Any]:
    return {"attempts": attempts} if attempts else {}
