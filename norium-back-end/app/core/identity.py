"""Identidade da requisicao: sem usuario identificado, nada e lido ou gravado (falha fechada)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def require_user_id(user: dict[str, Any] | None) -> str:
    """Id do usuario autenticado; nunca cai em uma conta padrao."""
    user_id = str((user or {}).get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Sessao sem usuario identificado. Entre novamente.")
    return user_id


def require_team_id(user: dict[str, Any] | None) -> str:
    """Dono da equipe (tenant compartilhado) ou o proprio usuario quando nao ha equipe."""
    team_id = str((user or {}).get("teamOwnerId") or "").strip()
    return team_id or require_user_id(user)
