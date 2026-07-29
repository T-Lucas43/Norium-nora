"""Contexto isolado por requisicao para workspace, rastreio e auditoria."""

from __future__ import annotations

import contextvars
import re


_request_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "norium_request_id",
    default="",
)
_workspace_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "norium_workspace_id",
    default="primary",
)


def normalize_workspace_id(value: str | None) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value or "").strip())
    return cleaned.strip("._") or "primary"


def current_request_id() -> str:
    return _request_id.get()


def current_workspace_id() -> str:
    return normalize_workspace_id(_workspace_id.get())


def set_request_context(request_id: str, workspace_id: str | None):
    request_token = _request_id.set(request_id)
    workspace_token = _workspace_id.set(normalize_workspace_id(workspace_id))
    return request_token, workspace_token


def reset_request_context(tokens) -> None:
    request_token, workspace_token = tokens
    _request_id.reset(request_token)
    _workspace_id.reset(workspace_token)
