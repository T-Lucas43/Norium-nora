"""Authenticated bridge from the separate executor to the singleton web writer."""
from __future__ import annotations

import hashlib
import hmac
import os
import time
import uuid
from contextvars import ContextVar

import httpx

from app.core.tenant import is_local_or_test_environment

from .contracts import BrainError, InformationRequired, Outcome, canonical
from .policy import Tool


_inside_writer: ContextVar[bool] = ContextVar("nora_brain_inside_writer", default=False)


def writer_context():
    token = _inside_writer.set(True)

    class Reset:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            _inside_writer.reset(token)

    return Reset()


def _must_dispatch() -> bool:
    return os.getenv("NORA_BRAIN_EXECUTOR_ENABLED") == "1" and not _inside_writer.get()


def _configuration():
    url = os.getenv("NORA_BRAIN_INTERNAL_URL", "").strip()
    secret = os.getenv("NORA_BRAIN_INTERNAL_SECRET", "").strip()
    if not url or len(secret) < 32:
        raise BrainError("legacy_tool_dispatch_not_configured", 503)
    return url.rstrip("/"), secret


async def signed_post(path: str, payload: dict):
    url, secret = _configuration()
    timestamp = str(int(time.time()))
    body = canonical(payload)
    signature = hmac.new(secret.encode(), (timestamp + "\n" + body).encode(), hashlib.sha256).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=50, follow_redirects=False) as client:
            response = await client.post(
                url + path,
                content=body.encode(),
                headers={"Content-Type": "application/json", "X-Nora-Timestamp": timestamp,
                         "X-Nora-Signature": signature},
            )
    except httpx.HTTPError as exc:
        raise BrainError("legacy_tool_dispatch_unavailable", 503) from exc
    if response.status_code != 200:
        try:
            detail = response.json().get("detail", {})
            if not isinstance(detail, dict):
                detail = {}
            code = detail.get("code")
        except ValueError:
            detail, code = {}, None
        if isinstance(detail, dict) and isinstance(detail.get("prompt"), str):
            raise InformationRequired(str(code or "information_required"), detail["prompt"], detail.get("details"))
        raise BrainError(str(code or "legacy_tool_dispatch_failed"), response.status_code)
    return response.json()


async def remote_identity(scope):
    payload = {**scope.as_dict(), "nonce": uuid.uuid4().hex}
    response = await signed_post("/api/nora/brain/internal/identity", payload)
    user = response.get("user")
    if not isinstance(user, dict):
        raise BrainError("invalid_internal_identity")
    return user


async def invoke(tool: Tool, phase: str, direct, user, value, job):
    if not _must_dispatch():
        if not (_inside_writer.get() or is_local_or_test_environment(require_explicit=True)
                or os.getenv("NORA_LEGACY_WRITER_SINGLETON") == "1"):
            raise BrainError("legacy_writer_singleton_required", 503)
        return await direct(user, value, job)

    payload = {
        "jobId": job["id"],
        "stepId": job.get("operationId") or next(
            (step["id"] for step in job.get("steps", []) if step.get("tool") == tool.name
             and step.get("status") not in {"succeeded", "cancelled"}),
            "",
        ),
        "phase": phase,
        "lease": job.get("lease", ""),
        "nonce": uuid.uuid4().hex,
    }
    result = (await signed_post("/api/nora/brain/internal/tool", payload)).get("result")
    if phase == "prepare":
        if not isinstance(result, dict):
            raise BrainError("invalid_prepared_operation")
        return result
    if not isinstance(result, dict):
        raise BrainError("invalid_tool_outcome")
    return Outcome(result.get("status"), result.get("data") or {}, result.get("evidence") or {})


def web_tool(tool: Tool) -> Tool:
    direct_prepare, direct_execute, direct_reconcile = tool.prepare, tool.execute, tool.reconcile

    async def prepare(user, args, job):
        return await invoke(tool, "prepare", direct_prepare, user, args, job)

    async def execute(user, prepared, job):
        return await invoke(tool, "execute", direct_execute, user, prepared, job)

    reconcile = None
    if direct_reconcile is not None:
        async def reconcile(user, prepared, job):
            return await invoke(tool, "reconcile", direct_reconcile, user, prepared, job)

    return Tool(tool.name, tool.description, tool.permission, tool.policy, tool.schema,
                prepare, execute, tool.version, tool.responsible_role, reconcile)
