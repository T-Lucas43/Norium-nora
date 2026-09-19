"""One durable transition per tick; no hidden retries or success inferred from text."""
from __future__ import annotations

import asyncio
import time
import uuid

from .budget import Budget
from .contracts import BrainError, InformationRequired, Outcome, PROFILES, Scope, TERMINAL
from .policy import live_identity, operation


class Engine:
    def __init__(self, repository, registry, planner, *, identity=live_identity, budget=None):
        self.repo, self.registry, self.planner = repository, registry, planner
        self.identity = identity
        self.budget = budget or Budget(repository)

    async def tick(self):
        job = self.repo.claim()
        if job is None:
            return False
        lease, job_id = job["lease"], job["id"]
        started = time.monotonic()
        scope = Scope(**job["scope"])
        from app.core.request_context import set_request_context, reset_request_context
        context = set_request_context("nora:" + job_id, scope.workspace)
        try:
            user = await self.identity(scope)
            if job["cancelRequested"]:
                self._state(job_id, lease, "cancelled", "Trabalho cancelado. As etapas concluídas foram preservadas.")
            elif job["budget"]["seconds"] >= PROFILES[job["profile"]].seconds:
                self._state(job_id, lease, "budget_paused", "Limite de tempo ativo atingido.")
            else:
                pending = next((s for s in job["steps"] if s["status"] not in {"succeeded", "cancelled"}), None)
                if pending is not None:
                    await self._execute(job, pending, user)
                else:
                    await self._plan(job, user)
        except BrainError as error:
            state = "budget_paused" if "budget" in error.code else "blocked"
            self._state(job_id, lease, state, error.code)
        except Exception:
            # No raw exception, response body or credential becomes model context/audit.
            self._state(job_id, lease, "blocked", "Falha técnica. Progresso preservado para revisão.")
        finally:
            try:
                def elapsed(current, connection):
                    current["budget"]["seconds"] += max(0, time.monotonic() - started)
                self.repo.mutate(job_id, None, elapsed, lease=lease)
                self.repo.release(job_id, lease)
            except BrainError:
                pass  # A fenced executor cannot overwrite a newer owner.
            reset_request_context(context)
        return True

    def _state(self, job_id, lease, state, message):
        def change(job, connection):
            # A failed observation after intent must never become a retryable failure.
            if any(s["status"] == "executing" for s in job["steps"]):
                for step in job["steps"]:
                    if step["status"] == "executing":
                        step["status"] = "unknown"
                state_value = "unknown"
            else:
                state_value = state
            job["status"], job["result"] = state_value, message
            self.repo.event(connection, job, "state", {"status": state_value, "reason": message})
        return self.repo.mutate(job_id, None, change, lease=lease)

    async def _plan(self, job, user):
        limit = PROFILES[job["profile"]]
        remaining = limit.tokens - job["budget"]["tokens"] - job["budget"]["reserved"]
        catalogue, context = self.planner.context(job, user, self.registry)
        reserve, output = self.planner.reservation(context, catalogue, remaining, limit.context)
        if hasattr(self.planner, "preflight"):
            self.planner.preflight(job["profile"])
        job = self.budget.reserve(job["id"], job["lease"], reserve)
        try:
            reply = await asyncio.wait_for(self.planner.decide(context, catalogue, job["profile"], output), timeout=60)
            settled = self.budget.settle(job["id"], job["lease"], reply.input_tokens, reply.output_tokens, reply.model)
        except BaseException:
            # The provider may have accepted work even when usage was not returned.
            # Charge the persisted reservation instead of leaking it forever or
            # pretending the failed observation cost zero.
            self.budget.forfeit(job["id"], job["lease"], "provider_usage_unknown")
            raise
        if settled["status"] == "budget_paused":
            return
        # Permissions might have changed during the model call.
        user = await self.identity(Scope(**job["scope"]))
        decision = reply.decision
        if decision.kind == "tool":
            tool = self.registry.require(decision.tool, user)
            args = tool.schema.model_validate(decision.arguments).model_dump()
            def change(current, connection):
                if current["cancelRequested"]:
                    current["status"] = "cancelled"
                    return
                if len(current["steps"]) >= limit.tools:
                    raise BrainError("tool_budget_exhausted")
                current["steps"].append({"id": uuid.uuid4().hex, "tool": tool.name, "version": tool.version,
                                         "arguments": args, "status": "planned", "attempts": 0})
                self.repo.event(connection, current, "planned", {"tool": tool.name})
            self.repo.mutate(job["id"], None, change, lease=job["lease"])
        else:
            self._state(job["id"], job["lease"], "needs_information" if decision.kind == "question" else "completed", decision.text)

    async def _execute(self, job, step, user):
        scope, lease = Scope(**job["scope"]), job["lease"]
        tool = self.registry.require(step["tool"], user)
        if step["version"] != tool.version:
            raise BrainError("tool_version_changed")
        if step["status"] == "unknown":
            raise BrainError("reconciliation_required")
        if step["status"] == "executing":
            raise BrainError("reconciliation_required")
        args = tool.schema.model_validate(step["arguments"])
        try:
            prepared = await tool.prepare(user, args, {**job, "operationId": step["id"]})
        except InformationRequired as error:
            def wait_for_information(current, connection):
                target = next(s for s in current["steps"] if s["id"] == step["id"])
                target["status"] = "needs_information"
                target["result"] = {"code": error.code, "details": error.details}
                current["status"], current["result"] = "needs_information", error.prompt
                self.repo.event(connection, current, "information_requested", {
                    "step": target["id"], "code": error.code, "details": error.details,
                })
            self.repo.mutate(job["id"], scope, wait_for_information, lease=lease)
            return
        exact = operation(tool, prepared, scope, user)
        def prepare(current, connection):
            target = next(s for s in current["steps"] if s["id"] == step["id"])
            if current["cancelRequested"]:
                current["status"] = "cancelled"
                return
            approval = target.get("approval", {})
            valid = (approval.get("digest") == exact["digest"] and approval.get("approvedAt") is not None
                     and approval.get("expiresAt", 0) > self.repo.clock() and not approval.get("consumedAt"))
            target["prepared"] = exact
            if exact["policy"] == "R" and not valid:
                target["approval"] = {"id": uuid.uuid4().hex, "digest": exact["digest"], "createdAt": self.repo.clock(),
                                      "expiresAt": self.repo.clock() + 86400}
                target["status"], current["status"] = "awaiting_approval", "awaiting_approval"
                current["result"] = "Revise a operação exata antes de aprovar."
                self.repo.event(connection, current, "review_prepared", {
                    "step": target["id"], "operationId": target["id"], "operation": exact,
                })
                return
            if target["attempts"] >= 2 or current["budget"]["tools"] >= PROFILES[current["profile"]].tools:
                raise BrainError("tool_budget_exhausted")
            if target.get("approval", {}).get("approvedAt") is not None:
                target["approval"]["consumedAt"] = self.repo.clock()
            target["status"], target["attempts"] = "executing", target["attempts"] + 1
            current["budget"]["tools"] += 1
            self.repo.event(connection, current, "operation_intent", {"step": target["id"], "operation": exact})
        current = self.repo.mutate(job["id"], scope, prepare, lease=lease)
        if current["status"] != "running":
            return
        user = await self.identity(scope)
        self.registry.require(step["tool"], user)
        try:
            result = await asyncio.wait_for(tool.execute(user, prepared, {**job, "operationId": step["id"]}), timeout=45)
            if not isinstance(result, Outcome) or (result.status == "succeeded" and not result.evidence):
                result = Outcome("unknown", {}, {"reason": "unverified_result"})
        except Exception:
            result = Outcome("unknown" if exact["policy"] != "C" else "rejected", {}, {"reason": "tool_failed"})
        def finish(current, connection):
            target = next(s for s in current["steps"] if s["id"] == step["id"])
            target["status"], target["result"] = result.status, {"data": result.data, "evidence": result.evidence}
            self.repo.event(connection, current, "operation_result", {"step": step["id"], "status": result.status, "evidence": result.evidence})
            if result.status != "succeeded":
                current["status"] = {"unknown": "unknown", "rejected": "blocked", "needs_information": "needs_information"}[result.status]
                current["result"] = "Resultado pendente; as etapas já concluídas foram preservadas."
            elif current["cancelRequested"]:
                current["status"] = "cancelled"
        self.repo.mutate(job["id"], scope, finish, lease=lease)

    async def approve(self, job_id, scope, approval_id, digest):
        user = await self.identity(scope)
        def change(job, connection):
            if job["cancelRequested"] or job["status"] != "awaiting_approval":
                raise BrainError("approval_not_pending")
            step = next((s for s in job["steps"] if s.get("approval", {}).get("id") == approval_id), None)
            if step is None:
                raise BrainError("approval_not_found", 404)
            tool = self.registry.require(step["tool"], user)
            if tool.responsible_role and user.get("role") != tool.responsible_role:
                raise BrainError("responsible_approval_required", 403)
            approval = step["approval"]
            if approval["digest"] != digest or approval["expiresAt"] <= self.repo.clock() or approval.get("consumedAt"):
                raise BrainError("approval_expired_or_changed")
            approval["approvedAt"], approval["approver"] = self.repo.clock(), scope.user
            step["status"], job["status"] = "planned", "queued"
            self.repo.event(connection, job, "approved", {
                "step": step["id"], "operationId": step["id"],
                "approval": approval, "operation": step["prepared"],
            })
        return self.repo.mutate(job_id, scope, change)

    async def reject(self, job_id, scope, approval_id, digest):
        await self.identity(scope)
        def change(job, connection):
            if job["cancelRequested"] or job["status"] != "awaiting_approval":
                raise BrainError("approval_not_pending")
            step = next((s for s in job["steps"] if s.get("approval", {}).get("id") == approval_id), None)
            if step is None:
                raise BrainError("approval_not_found", 404)
            approval = step["approval"]
            if approval.get("digest") != digest or approval.get("consumedAt"):
                raise BrainError("approval_changed")
            now = self.repo.clock()
            approval["rejectedAt"], approval["rejector"] = now, scope.user
            step["status"], job["status"] = "cancelled", "cancelled"
            job["cancelRequested"], job["closedAt"] = True, now
            job["result"] = "Operação não aprovada. As etapas concluídas foram preservadas."
            self.repo.event(connection, job, "approval_rejected", {
                "step": step["id"], "operationId": step["id"],
                "approval": approval, "operation": step.get("prepared", {}),
            })
        return self.repo.mutate(job_id, scope, change)

    async def resume(self, job_id, scope, message):
        await self.identity(scope)
        def change(job, connection):
            if job["status"] != "needs_information" or job["cancelRequested"]:
                raise BrainError("job_not_waiting_for_information")
            if len(job["notes"]) >= 10:
                raise BrainError("context_limit")
            job["notes"].append(message)
            # The clarification can change a target. Preserve the old attempt and
            # let the planner create a newly validated step instead of mutating it.
            for step in job["steps"]:
                if step["status"] == "needs_information":
                    step["status"] = "cancelled"
            job["status"] = "queued"
            self.repo.event(connection, job, "information_received", {})
        return self.repo.mutate(job_id, scope, change)

    async def reconcile(self, job_id, scope):
        user = await self.identity(scope)
        job = self.repo.get(job_id, scope)
        if job["status"] != "unknown":
            raise BrainError("job_not_unknown")
        step = next((item for item in job["steps"] if item["status"] == "unknown"), None)
        if step is None:
            raise BrainError("unknown_step_not_found")
        tool = self.registry.require(step["tool"], user)
        if tool.reconcile is None:
            raise BrainError("manual_reconciliation_required")
        prepared = step.get("prepared", {}).get("prepared")
        if not isinstance(prepared, dict):
            raise BrainError("reconciliation_evidence_missing")
        outcome = await tool.reconcile(user, prepared, {**job, "operationId": step["id"]})
        if not isinstance(outcome, Outcome):
            raise BrainError("invalid_reconciliation_result")

        def change(current, connection):
            target = next(item for item in current["steps"] if item["id"] == step["id"])
            if outcome.status == "succeeded":
                target["status"] = "succeeded"
                target["result"] = {"data": outcome.data, "evidence": outcome.evidence}
                current["status"] = "queued"
                current["result"] = "Efeito anterior confirmado; execução pode continuar."
            elif outcome.status == "rejected" and outcome.evidence.get("confirmedNotApplied") is True:
                target["status"] = "planned"
                current["status"] = "queued"
                current["result"] = "Ausência do efeito comprovada; a mesma operação pode ser retomada."
            else:
                current["result"] = "Resultado ainda desconhecido. Nenhuma repetição foi autorizada."
            self.repo.event(connection, current, "reconciled", {
                "step": target["id"], "status": outcome.status, "evidence": outcome.evidence,
            })

        return self.repo.mutate(job_id, scope, change)

    async def extend_budget(self, job_id, scope, profile, acknowledged):
        await self.identity(scope)
        order = {"routine": 0, "document": 1, "complex": 2}
        def change(job, connection):
            if job["status"] != "budget_paused" or job["cancelRequested"] or job.get("lease"):
                raise BrainError("budget_extension_not_available")
            if profile not in order or order[profile] <= order[job["profile"]]:
                raise BrainError("budget_profile_must_increase", 422)
            if not acknowledged or (profile == "complex" and acknowledged is not True):
                raise BrainError("budget_extension_confirmation_required", 422)
            previous = job["profile"]
            job["profile"], job["status"] = profile, "queued"
            job["result"] = "Orçamento ampliado pelo usuário; o consumo anterior foi preservado."
            self.repo.event(connection, job, "budget_extended", {
                "from": previous, "to": profile, "approver": scope.user,
                "tokensAlreadyUsed": job["budget"]["tokens"], "callsAlreadyUsed": job["budget"]["calls"],
            })
        return self.repo.mutate(job_id, scope, change)
