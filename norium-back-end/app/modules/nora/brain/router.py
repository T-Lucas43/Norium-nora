"""Authenticated control surface. Model calls and tool effects run in the worker."""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import Field

from app.core.request_context import current_workspace_id, reset_request_context, set_request_context
from app.modules.auth.router import current_user

from .contracts import BrainError, Outcome, Scope, Strict, Submit, canonical
from .dispatcher import writer_context
from .policy import live_user
from .runtime import engine, repository


router = APIRouter(prefix="/brain", tags=["Nora Brain"])


class Approval(Strict):
    approvalId: str = Field(min_length=8, max_length=80)
    digest: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")


class Information(Strict):
    message: str = Field(min_length=1, max_length=4000)


class InternalToolRequest(Strict):
    jobId: str = Field(min_length=16, max_length=80)
    stepId: str = Field(min_length=8, max_length=80)
    phase: Literal["prepare", "execute", "reconcile"]
    lease: str = Field(default="", max_length=80)
    nonce: str = Field(min_length=32, max_length=80, pattern=r"^[a-f0-9]+$")


class InternalIdentityRequest(Strict):
    tenant: str = Field(min_length=1, max_length=160)
    user: str = Field(min_length=1, max_length=160)
    workspace: str = Field(min_length=1, max_length=160)
    nonce: str = Field(min_length=32, max_length=80, pattern=r"^[a-f0-9]+$")


class BudgetExtension(Strict):
    profile: Literal["document", "complex"]
    acknowledged: bool


def brain_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    if user.get("systemAdmin") or permissions.get("nora"):
        return user
    raise HTTPException(status_code=403, detail={"code": "nora_permission_required"})


def scope(user):
    actor = str(user.get("id") or "").strip()
    return Scope(str(user.get("teamOwnerId") or actor).strip(), actor, current_workspace_id())


def exposed(job):
    return {key: value for key, value in job.items() if key not in {"lease", "leaseUntil"}}


def fail(error: BrainError):
    detail = {"code": error.code}
    if hasattr(error, "prompt"):
        detail.update({"prompt": error.prompt, "details": error.details})
    raise HTTPException(status_code=error.status, detail=detail) from error


def verify_internal(payload: Strict, timestamp: str, signature: str):
    secret = os.getenv("NORA_BRAIN_INTERNAL_SECRET", "").strip()
    if len(secret) < 32 or os.getenv("NORA_LEGACY_WRITER_SINGLETON") != "1":
        raise BrainError("internal_writer_not_configured", 503)
    try:
        instant = int(timestamp)
    except ValueError:
        raise BrainError("invalid_internal_signature", 401) from None
    if abs(time.time() - instant) > 60:
        raise BrainError("internal_request_expired", 401)
    expected = hmac.new(secret.encode(), (timestamp + "\n" + canonical(payload.model_dump())).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise BrainError("invalid_internal_signature", 401)
    repository().consume_nonce(payload.nonce, time.time() + 120)


@router.post("/internal/identity", include_in_schema=False)
async def internal_identity(
    payload: InternalIdentityRequest,
    x_nora_timestamp: str = Header(default=""),
    x_nora_signature: str = Header(default=""),
):
    try:
        verify_internal(payload, x_nora_timestamp, x_nora_signature)
        user = await live_user(Scope(payload.tenant, payload.user, payload.workspace))
        return {"user": user}
    except BrainError as error:
        fail(error)


@router.post("/internal/tool", include_in_schema=False)
async def internal_tool(
    payload: InternalToolRequest,
    x_nora_timestamp: str = Header(default=""),
    x_nora_signature: str = Header(default=""),
):
    try:
        verify_internal(payload, x_nora_timestamp, x_nora_signature)
        repo = repository()
        job = repo.get(payload.jobId)
        if job.get("lease") != payload.lease or job.get("leaseUntil", 0) <= repo.clock():
            raise BrainError("lease_lost")
        step = next((item for item in job["steps"] if item["id"] == payload.stepId), None)
        if step is None:
            raise BrainError("step_not_found", 404)
        expected_status = {"prepare": {"planned"}, "execute": {"executing"}, "reconcile": {"unknown"}}[payload.phase]
        if step["status"] not in expected_status:
            raise BrainError("step_state_changed")
        # The internal HTTP request does not carry the user's workspace header.
        # Bind the persisted scope before any legacy store is read or written.
        context = set_request_context("nora-internal:" + job["id"], job["scope"]["workspace"])
        try:
            user = await live_user(Scope(**job["scope"]))
            tool = engine().registry.require(step["tool"], user)
            if step["version"] != tool.version:
                raise BrainError("tool_version_changed")
            args = tool.schema.model_validate(step["arguments"])
            with writer_context():
                if payload.phase == "prepare":
                    result = await tool.prepare(user, args, job)
                else:
                    prepared = step.get("prepared", {}).get("prepared")
                    if not isinstance(prepared, dict):
                        raise BrainError("prepared_operation_missing")
                    operation_job = {**job, "operationId": step["id"]}
                    method = tool.execute if payload.phase == "execute" else tool.reconcile
                    if method is None:
                        raise BrainError("manual_reconciliation_required")
                    result = await method(user, prepared, operation_job)
                    if not isinstance(result, Outcome):
                        raise BrainError("invalid_tool_outcome")
                    result = {"status": result.status, "data": result.data, "evidence": result.evidence}
        finally:
            reset_request_context(context)
        return {"result": result}
    except BrainError as error:
        fail(error)


@router.get("/health")
async def health(_: dict[str, Any] = Depends(brain_user)):
    try:
        return repository().ping()
    except BrainError as error:
        fail(error)


@router.post("/jobs", status_code=202)
async def submit(payload: Submit, request: Request, user: dict[str, Any] = Depends(brain_user)):
    try:
        header_key = request.headers.get("Idempotency-Key", "").strip()
        if header_key and header_key != payload.requestId:
            raise BrainError("idempotency_key_mismatch", 422)
        return {"job": exposed(repository().create(scope(user), payload))}
    except BrainError as error:
        fail(error)


@router.get("/jobs")
async def list_jobs(cursor: str | None = Query(default=None, min_length=8, max_length=240), user: dict[str, Any] = Depends(brain_user)):
    try:
        result = repository().list(scope(user), cursor)
        return {**result, "items": [exposed(job) for job in result["items"]]}
    except BrainError as error:
        fail(error)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(repository().get(job_id, scope(user)))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/approval")
async def approve(job_id: str, payload: Approval, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(await engine().approve(job_id, scope(user), payload.approvalId, payload.digest))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/approval/reject")
async def reject(job_id: str, payload: Approval, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(await engine().reject(job_id, scope(user), payload.approvalId, payload.digest))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/information")
async def provide_information(job_id: str, payload: Information, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(await engine().resume(job_id, scope(user), payload.message))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/reconcile")
async def reconcile(job_id: str, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(await engine().reconcile(job_id, scope(user)))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/budget")
async def extend_budget(job_id: str, payload: BudgetExtension, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(await engine().extend_budget(
            job_id, scope(user), payload.profile, payload.acknowledged,
        ))}
    except BrainError as error:
        fail(error)


@router.post("/jobs/{job_id}/cancel")
async def cancel(job_id: str, user: dict[str, Any] = Depends(brain_user)):
    try:
        return {"job": exposed(repository().cancel(job_id, scope(user)))}
    except BrainError as error:
        fail(error)
