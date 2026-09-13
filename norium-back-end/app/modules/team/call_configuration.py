"""Configuracao validada do transporte mesh das chamadas de equipe."""

from __future__ import annotations

import os
from collections.abc import Mapping


# Limite conservador enquanto o transporte padrao replica midia entre peers.
DEFAULT_MESH_MAX_PARTICIPANTS = 6
MIN_MESH_MAX_PARTICIPANTS = 2
MAX_MESH_MAX_PARTICIPANTS = 12
MESH_MAX_PARTICIPANTS_ENV = "TEAM_CALL_MESH_MAX_PARTICIPANTS"


class CallConfigurationError(RuntimeError):
    """Impede a inicializacao com uma configuracao de chamada insegura."""


def mesh_max_participants_from_environment(
    environ: Mapping[str, str] | None = None,
) -> int:
    source = os.environ if environ is None else environ
    raw_value = source.get(
        MESH_MAX_PARTICIPANTS_ENV,
        str(DEFAULT_MESH_MAX_PARTICIPANTS),
    )
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise CallConfigurationError(
            f"{MESH_MAX_PARTICIPANTS_ENV} deve ser um numero inteiro maior ou igual a "
            f"{MIN_MESH_MAX_PARTICIPANTS}."
        ) from exc
    if not MIN_MESH_MAX_PARTICIPANTS <= value <= MAX_MESH_MAX_PARTICIPANTS:
        raise CallConfigurationError(
            f"{MESH_MAX_PARTICIPANTS_ENV} deve estar entre "
            f"{MIN_MESH_MAX_PARTICIPANTS} e {MAX_MESH_MAX_PARTICIPANTS}."
        )
    return value


def validate_team_call_configuration(
    environ: Mapping[str, str] | None = None,
) -> None:
    mesh_max_participants_from_environment(environ)
    from app.modules.team.call_release import CallReleasePolicy
    CallReleasePolicy.from_env(environ)
    from app.modules.team.recording_coordinator import RecordingLimits
    RecordingLimits.from_env(environ)
