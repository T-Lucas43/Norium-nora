"""Server-owned rollout and bounded resource policy for team calls."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from collections.abc import Mapping

from app.modules.team.call_configuration import CallConfigurationError
from app.core.tenant import is_shared_environment


def bounded_int(source: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(source.get(name, str(default)))
    except (ValueError, TypeError) as exc:
        raise CallConfigurationError(f"{name}: inteiro obrigatorio.") from exc
    if not low <= value <= high:
        raise CallConfigurationError(f"{name}: fora do intervalo {low}..{high}.")
    return value


def flag(source: Mapping[str, str], name: str, default: bool) -> bool:
    raw = source.get(name, str(default)).lower()
    if raw not in {"true", "false"}:
        raise CallConfigurationError(f"{name}: use true ou false.")
    return raw == "true"


@dataclass(frozen=True)
class CallReleasePolicy:
    enabled: bool
    percent: int
    internal_teams: frozenset[str]
    recording_enabled: bool
    max_team_calls: int
    max_total_calls: int
    max_sockets: int
    max_team_sockets: int
    max_user_sockets: int

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> CallReleasePolicy:
        source = os.environ if environ is None else environ
        production = is_shared_environment(source)
        token = source.get("TEAM_CALL_METRICS_TOKEN", "")
        if token and (len(token) < 32 or not token.isascii() or any(c.isspace() for c in token)):
            raise CallConfigurationError("TEAM_CALL_METRICS_TOKEN: minimo 32 caracteres ASCII sem espacos.")
        teams = source.get("TEAM_CALL_INTERNAL_TEAMS", "")
        if len(teams) > 8192:
            raise CallConfigurationError("TEAM_CALL_INTERNAL_TEAMS: lista acima do limite.")
        return cls(
            enabled=flag(source, "TEAM_CALL_ENABLED", not production),
            percent=bounded_int(source, "TEAM_CALL_ROLLOUT_PERCENT", 0 if production else 100, 0, 100),
            internal_teams=frozenset(t.strip() for t in teams.split(",") if t.strip()),
            recording_enabled=flag(source, "TEAM_CALL_RECORDING_ENABLED", not production),
            max_team_calls=bounded_int(source, "TEAM_CALL_MAX_ACTIVE_PER_TEAM", 8, 1, 100),
            max_total_calls=bounded_int(source, "TEAM_CALL_MAX_ACTIVE_TOTAL", 100, 1, 1000),
            max_sockets=bounded_int(source, "TEAM_CALL_MAX_SOCKETS", 1000, 100, 5000),
            max_team_sockets=bounded_int(source, "TEAM_CALL_MAX_SOCKETS_PER_TEAM", 100, 4, 1000),
            max_user_sockets=bounded_int(source, "TEAM_CALL_MAX_SOCKETS_PER_USER", 4, 2, 16),
        )

    def allows_new_call(self, team_id: str) -> bool:
        # Stable, monotonic cohort; no identifiers escape into metrics or logs.
        bucket = int.from_bytes(hashlib.sha256(("team-call-v1:" + team_id).encode()).digest()[:4], "big") % 100
        return self.enabled and (team_id in self.internal_teams or bucket < self.percent)
