from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path

from pydantic import Field

from app.modules.nora.brain.contracts import BrainError, Decision, InformationRequired, ModelReply, Outcome, Scope, Strict, Submit
from app.modules.nora.brain.engine import Engine
from app.modules.nora.brain.planner import Planner as ProviderPlanner, sanitize
from app.modules.nora.brain.policy import Registry, Tool, operation, strict_schema
from app.modules.nora.brain.repository import Repository


class Args(Strict):
    value: str = Field(min_length=1, max_length=50)


class Clock:
    def __init__(self):
        self.value = 1_800_000_000.0

    def __call__(self):
        return self.value


class Planner:
    def __init__(self, decisions):
        self.decisions = list(decisions)

    def context(self, job, user, registry):
        return registry.catalogue(user), {"request": job["message"]}

    def reservation(self, context, catalogue, remaining, context_limit):
        return 100, 50

    async def decide(self, context, catalogue, profile, max_output):
        return ModelReply(self.decisions.pop(0), 20, 10, "fake-model")


class NoraBrainTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_environment = os.environ.get("ENVIRONMENT")
        self.old_app_environment = os.environ.get("APP_ENV")
        os.environ["ENVIRONMENT"] = os.environ["APP_ENV"] = "test"
        self.temporary = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.repo = Repository("sqlite:///" + str(Path(self.temporary.name) / "brain.sqlite3"), clock=self.clock)
        self.repo.initialize()
        self.scope = Scope("tenant-a", "user-a", "primary")
        self.user = {"id": "user-a", "teamOwnerId": "tenant-a", "permissions": {"nora": True, "tarefas": True}}
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()
        if self.old_environment is None:
            os.environ.pop("ENVIRONMENT", None)
        else:
            os.environ["ENVIRONMENT"] = self.old_environment
        if self.old_app_environment is None:
            os.environ.pop("APP_ENV", None)
        else:
            os.environ["APP_ENV"] = self.old_app_environment

    def submit(self, key="request-123", message="faça o trabalho"):
        return self.repo.create(self.scope, Submit(requestId=key, message=message))

    def tool(self, policy="D", execute=None, reconcile=None):
        async def prepare(user, args, job):
            return {"value": args.value, "effects": ["send"] if policy == "R" else []}

        async def default_execute(user, prepared, job):
            self.calls.append((prepared["value"], job["operationId"]))
            return Outcome("succeeded", {"value": prepared["value"]}, {"operationId": job["operationId"]})

        return Tool("tasks_demo", "Ferramenta de teste.", "tarefas", policy, Args, prepare,
                    execute or default_execute, reconcile=reconcile)

    def engine(self, decisions, *, tool=None, identity=None):
        async def current(scope):
            return self.user
        return Engine(self.repo, Registry([tool or self.tool()]), Planner(decisions), identity=identity or current)

    def test_same_request_is_one_job_and_changed_payload_is_rejected(self):
        first = self.submit()
        second = self.submit()
        self.assertEqual(first["id"], second["id"])
        with self.assertRaisesRegex(BrainError, "request_key_conflict"):
            self.submit(message="outro trabalho")

    def test_scope_is_enforced_by_storage_query(self):
        job = self.submit()
        with self.assertRaisesRegex(BrainError, "job_not_found"):
            self.repo.get(job["id"], Scope("tenant-b", "user-a", "primary"))
        with self.assertRaisesRegex(BrainError, "job_not_found"):
            self.repo.get(job["id"], Scope("tenant-a", "user-a", "secondary"))

    def test_corrupt_record_fails_closed_without_replacement(self):
        job = self.submit()
        with self.repo.transaction() as connection:
            self.repo.sql(connection, "UPDATE nora_jobs SET payload=? WHERE id=?", ("{}", job["id"]))
        with self.assertRaisesRegex(BrainError, "brain_storage_invalid"):
            self.repo.get(job["id"], self.scope)
        with self.repo.transaction() as connection:
            row = self.repo.sql(connection, "SELECT payload FROM nora_jobs WHERE id=?", (job["id"],)).fetchone()
        self.assertEqual("{}", row["payload"])

    async def test_direct_tool_runs_once_and_finishes_with_verified_answer(self):
        job = self.submit()
        engine = self.engine([
            Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"}),
            Decision(kind="answer", text="Concluído com evidência."),
        ])
        self.assertTrue(await engine.tick())
        self.assertTrue(await engine.tick())
        self.assertTrue(await engine.tick())
        final = self.repo.get(job["id"], self.scope)
        self.assertEqual("completed", final["status"])
        self.assertEqual([("x", final["steps"][0]["id"])], self.calls)
        self.assertEqual("succeeded", final["steps"][0]["status"])
        self.assertEqual(2, final["budget"]["calls"])

    async def test_exact_approval_is_required_and_consumed_once(self):
        job = self.submit()
        engine = self.engine([
            Decision(kind="tool", tool="tasks_demo", arguments={"value": "mensagem"}),
            Decision(kind="answer", text="Envio confirmado."),
        ], tool=self.tool("R"))
        await engine.tick()
        await engine.tick()
        pending = self.repo.get(job["id"], self.scope)
        approval = pending["steps"][0]["approval"]
        self.assertEqual("awaiting_approval", pending["status"])
        self.assertEqual([], self.calls)
        with self.assertRaisesRegex(BrainError, "approval_expired_or_changed"):
            await engine.approve(job["id"], self.scope, approval["id"], "0" * 64)
        await engine.approve(job["id"], self.scope, approval["id"], approval["digest"])
        await engine.tick()
        after = self.repo.get(job["id"], self.scope)
        self.assertIsNotNone(after["steps"][0]["approval"]["consumedAt"])
        self.assertEqual(1, len(self.calls))
        with self.assertRaisesRegex(BrainError, "approval_not_pending"):
            await engine.approve(job["id"], self.scope, approval["id"], approval["digest"])

    async def test_expired_approval_preserves_work_and_never_executes(self):
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})], tool=self.tool("R"))
        await engine.tick()
        await engine.tick()
        pending = self.repo.get(job["id"], self.scope)
        approval = pending["steps"][0]["approval"]
        self.clock.value = approval["expiresAt"] + 1
        with self.assertRaisesRegex(BrainError, "approval_expired_or_changed"):
            await engine.approve(job["id"], self.scope, approval["id"], approval["digest"])
        self.assertEqual([], self.calls)
        self.assertEqual("awaiting_approval", self.repo.get(job["id"], self.scope)["status"])

    async def test_worker_replaces_expired_review_without_executing(self):
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})], tool=self.tool("R"))
        await engine.tick()
        await engine.tick()
        first = self.repo.get(job["id"], self.scope)["steps"][0]["approval"]
        self.clock.value = first["expiresAt"] + 1
        await engine.tick()
        refreshed = self.repo.get(job["id"], self.scope)
        second = refreshed["steps"][0]["approval"]
        self.assertEqual("awaiting_approval", refreshed["status"])
        self.assertNotEqual(first["id"], second["id"])
        self.assertGreater(second["expiresAt"], first["expiresAt"])
        self.assertEqual([], self.calls)

    async def test_rejecting_exact_review_cancels_only_future_work(self):
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})], tool=self.tool("R"))
        await engine.tick()
        await engine.tick()
        pending = self.repo.get(job["id"], self.scope)
        approval = pending["steps"][0]["approval"]
        rejected = await engine.reject(job["id"], self.scope, approval["id"], approval["digest"])
        self.assertEqual("cancelled", rejected["status"])
        self.assertEqual("cancelled", rejected["steps"][0]["status"])
        self.assertEqual([], self.calls)

    async def test_permission_revoked_after_planning_blocks_before_effect(self):
        job = self.submit()
        allowed = True
        async def identity(scope):
            if not allowed:
                raise BrainError("permission_revoked", 403)
            return self.user
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})], identity=identity)
        await engine.tick()
        allowed = False
        await engine.tick()
        self.assertEqual([], self.calls)
        self.assertEqual("blocked", self.repo.get(job["id"], self.scope)["status"])

    async def test_unknown_external_result_is_not_retried(self):
        async def fail_after_possible_effect(user, prepared, job):
            self.calls.append((prepared["value"], job["operationId"]))
            raise TimeoutError()
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})],
                             tool=self.tool(execute=fail_after_possible_effect))
        await engine.tick()
        await engine.tick()
        self.assertEqual("unknown", self.repo.get(job["id"], self.scope)["status"])
        self.assertFalse(await engine.tick())
        self.assertEqual(1, len(self.calls))

    async def test_reconciliation_can_prove_absence_before_same_operation_retries(self):
        first = True
        async def uncertain(user, prepared, job):
            nonlocal first
            self.calls.append((prepared["value"], job["operationId"]))
            if first:
                first = False
                raise TimeoutError()
            return Outcome("succeeded", {}, {"operationId": job["operationId"]})
        async def reconcile(user, prepared, job):
            return Outcome("rejected", {}, {"confirmedNotApplied": True})
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"}),
                              Decision(kind="answer", text="Pronto")],
                             tool=self.tool(execute=uncertain, reconcile=reconcile))
        await engine.tick()
        await engine.tick()
        await engine.reconcile(job["id"], self.scope)
        await engine.tick()
        await engine.tick()
        self.assertEqual("completed", self.repo.get(job["id"], self.scope)["status"])
        self.assertEqual(2, len(self.calls))
        self.assertEqual(self.calls[0][1], self.calls[1][1])

    def test_expired_executor_lease_marks_inflight_step_unknown(self):
        job = self.submit()
        claimed = self.repo.claim()
        def executing(current, connection):
            current["steps"].append({"id": "step-x", "tool": "tasks_demo", "version": "1",
                                     "arguments": {"value": "x"}, "status": "executing", "attempts": 1})
        self.repo.mutate(job["id"], None, executing, lease=claimed["lease"])
        self.clock.value += 121
        self.assertIsNone(self.repo.claim())
        recovered = self.repo.get(job["id"], self.scope)
        self.assertEqual("unknown", recovered["status"])
        self.assertEqual("unknown", recovered["steps"][0]["status"])

    def test_complex_budget_needs_explicit_request_authorization(self):
        with self.assertRaisesRegex(BrainError, "complex_budget_approval_required"):
            self.repo.create(self.scope, Submit(requestId="complex-1", message="analise", category="complex"))
        job = self.repo.create(self.scope, Submit(requestId="complex-2", message="analise", category="complex", complexBudgetApproved=True))
        self.assertEqual("complex", job["profile"])

    def test_sensitive_values_are_removed_before_model_context(self):
        provider_key = "sk-" + "abcdefghijklmnop"
        value = sanitize({"token": "secret", "text": f"Bearer abcdef api_key=xyz {provider_key} 123.456.789-00"})
        self.assertNotIn("token", value)
        self.assertNotIn("abcdef", value["text"])
        self.assertNotIn("123.456.789-00", value["text"])

    async def test_cancel_keeps_completed_steps_and_stops_future_work(self):
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})])
        await engine.tick()
        await engine.tick()
        cancelled = self.repo.cancel(job["id"], self.scope)
        self.assertEqual("cancelled", cancelled["status"])
        self.assertEqual("succeeded", cancelled["steps"][0]["status"])
        self.assertFalse(await engine.tick())

    def test_catalogue_requires_every_real_permission_and_uses_strict_schema(self):
        tool = Tool("email_demo", "Teste", ("emails", "integracao_gmail"), "R", Args,
                    self.tool().prepare, self.tool().execute)
        registry = Registry([tool])
        user = {"permissions": {"nora": True, "emails": True, "integracao_gmail": False}}
        self.assertEqual([], registry.catalogue(user))
        user["permissions"]["integracao_gmail"] = True
        schema = registry.catalogue(user)[0]
        self.assertTrue(schema["strict"])
        self.assertFalse(schema["parameters"]["additionalProperties"])
        self.assertEqual(["value"], schema["parameters"]["required"])

    def test_human_only_tool_cannot_be_unlocked_by_approval(self):
        tool = self.tool("H")
        with self.assertRaisesRegex(BrainError, "human_operation_required"):
            Registry([tool]).require(tool.name, self.user)

    async def test_clarification_cancels_stale_target_and_replans(self):
        async def prepare(user, args, job):
            if args.value == "ambiguous":
                raise InformationRequired("target_ambiguous", "Qual alvo?", {"candidates": ["A", "B"]})
            return {"value": args.value, "effects": []}

        base = self.tool()
        tool = Tool(base.name, base.description, base.permission, base.policy, base.schema,
                    prepare, base.execute)
        job = self.submit()
        engine = self.engine([
            Decision(kind="tool", tool="tasks_demo", arguments={"value": "ambiguous"}),
            Decision(kind="tool", tool="tasks_demo", arguments={"value": "A"}),
        ], tool=tool)
        await engine.tick()
        await engine.tick()
        waiting = self.repo.get(job["id"], self.scope)
        self.assertEqual("needs_information", waiting["status"])
        self.assertEqual([], self.calls)
        await engine.resume(job["id"], self.scope, "Use A")
        await engine.tick()
        after = self.repo.get(job["id"], self.scope)
        self.assertEqual("cancelled", after["steps"][0]["status"])
        self.assertEqual("planned", after["steps"][1]["status"])

    async def test_material_change_invalidates_an_existing_approval(self):
        version = "v1"
        async def prepare(user, args, job):
            return {"value": args.value, "version": version, "effects": ["send"]}
        base = self.tool("R")
        tool = Tool(base.name, base.description, base.permission, base.policy, base.schema,
                    prepare, base.execute)
        job = self.submit()
        engine = self.engine([Decision(kind="tool", tool="tasks_demo", arguments={"value": "x"})], tool=tool)
        await engine.tick()
        await engine.tick()
        first = self.repo.get(job["id"], self.scope)["steps"][0]["approval"]
        await engine.approve(job["id"], self.scope, first["id"], first["digest"])
        version = "v2"
        await engine.tick()
        changed = self.repo.get(job["id"], self.scope)
        second = changed["steps"][0]["approval"]
        self.assertEqual("awaiting_approval", changed["status"])
        self.assertNotEqual(first["digest"], second["digest"])
        self.assertEqual([], self.calls)

    def test_same_timestamp_pagination_does_not_skip_jobs(self):
        expected = {self.submit(f"request-{index:03d}")["id"] for index in range(25)}
        cursor = None
        found = set()
        while True:
            result = self.repo.list(self.scope, cursor)
            found.update(item["id"] for item in result["items"])
            cursor = result["nextCursor"]
            if cursor is None:
                break
        self.assertEqual(expected, found)
        with self.assertRaisesRegex(BrainError, "invalid_cursor"):
            self.repo.list(self.scope, "not-a-valid-cursor")

    def test_retention_boundaries_remove_context_then_summary_then_audit(self):
        job = self.submit()
        def complete(current, connection):
            current["status"] = "completed"
            current["result"] = "resultado"
            current["closedAt"] = self.clock()
            self.repo.event(connection, current, "completed", {"ok": True})
        self.repo.mutate(job["id"], self.scope, complete)
        self.clock.value += 7 * 86400
        self.repo.cleanup()
        seven = self.repo.get(job["id"], self.scope)
        self.assertEqual("", seven["message"])
        with self.repo.transaction() as connection:
            self.assertGreater(self.repo.sql(connection, "SELECT count(*) AS n FROM nora_events").fetchone()["n"], 0)
        self.clock.value += 83 * 86400
        self.repo.cleanup()
        self.assertEqual("Resultado expirado.", self.repo.get(job["id"], self.scope)["result"])
        self.clock.value += 275 * 86400
        self.repo.cleanup()
        with self.repo.transaction() as connection:
            self.assertEqual(0, self.repo.sql(connection, "SELECT count(*) AS n FROM nora_events").fetchone()["n"])

    def test_internal_nonce_is_single_use(self):
        self.repo.consume_nonce("a" * 32, self.clock() + 120)
        with self.assertRaisesRegex(BrainError, "internal_request_replayed"):
            self.repo.consume_nonce("a" * 32, self.clock() + 120)

    def test_delete_effect_is_always_reviewed(self):
        tool = self.tool("D")
        exact = operation(tool, {"value": "x", "effects": ["delete"]}, self.scope)
        self.assertEqual("R", exact["policy"])

    def test_real_catalogue_uses_the_application_permission_names(self):
        from app.modules.nora.brain.tools import registry
        permissions = {
            "nora": True, "tarefas": True, "central": True, "gastos": True,
            "agenda": True, "emails": True, "integracao_gmail": True,
            "chat": True, "integracao_whatsapp": True,
        }
        names = {item["name"] for item in registry(self.repo).catalogue({"permissions": permissions})}
        self.assertTrue({"tasks_query", "clients_query", "finance_query", "calendar_create",
                         "email_send", "whatsapp_send"}.issubset(names))
        permissions["integracao_gmail"] = False
        names = {item["name"] for item in registry(self.repo).catalogue({"permissions": permissions})}
        self.assertNotIn("email_send", names)

    def test_legacy_task_receipt_and_effect_are_written_once(self):
        from app.modules.nora.brain import task_bridge
        prepared = {"action": "create", "title": "Tarefa idempotente", "description": "", "dueDate": None}
        first = task_bridge.execute("user-a", prepared, "operation-task-1")
        second = task_bridge.execute("user-a", prepared, "operation-task-1")
        self.assertEqual(first, second)
        from app.services.task_store import load_workspace
        matches = [item for item in load_workspace("user-a")["tasks"] if item["title"] == "Tarefa idempotente"]
        self.assertEqual(1, len(matches))

    def test_local_calendar_operation_key_prevents_duplicate_event(self):
        from app.services.calendar_service import CalendarService
        service = CalendarService("user-a")
        values = dict(titulo="Compromisso", inicio="2027-01-02T10:00:00-03:00",
                      fim="2027-01-02T11:00:00-03:00", operation_id="operation-calendar-1")
        first = service.create_event(**values)
        second = service.create_event(**values)
        self.assertEqual(first["evento"]["id"], second["evento"]["id"])
        self.assertTrue(second["idempotentReplay"])

    async def test_openai_adapter_disables_storage_parallel_tools_and_sdk_retries(self):
        calls = []
        class Response:
            status_code = 200
            def json(self):
                return {"status": "completed", "output": [{"type": "message", "content": [
                    {"type": "output_text", "text": '{"kind":"answer","tool":"","arguments":{},"text":"ok"}'},
                ]}], "usage": {"input_tokens": 10, "output_tokens": 3}}
        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *_): return None
            async def post(self, url, **kwargs):
                calls.append((url, kwargs))
                return Response()
        old = {key: os.environ.get(key) for key in ("NORA_BRAIN_ALLOW_MODEL_CALLS", "NORA_BRAIN_PROVIDER", "OPENAI_API_KEY")}
        os.environ.update({"NORA_BRAIN_ALLOW_MODEL_CALLS": "1", "NORA_BRAIN_PROVIDER": "openai", "OPENAI_API_KEY": "synthetic"})
        try:
            reply = await ProviderPlanner(client_factory=lambda **_: Client()).decide(
                {"request": "teste"}, [{"type": "function", "name": "demo", "description": "d",
                                         "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}, "strict": True}],
                "routine", 100,
            )
        finally:
            for key, value in old.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value
        self.assertEqual("answer", reply.decision.kind)
        self.assertEqual(1, len(calls))
        payload = calls[0][1]["json"]
        self.assertIs(payload["store"], False)
        self.assertIs(payload["parallel_tool_calls"], False)

    async def test_budget_extension_preserves_consumption_and_requires_explicit_increase(self):
        job = self.submit()
        def pause(current, connection):
            current["status"] = "budget_paused"
            current["budget"].update({"tokens": 9000, "calls": 3, "tools": 2, "seconds": 120})
        self.repo.mutate(job["id"], self.scope, pause)
        engine = self.engine([])
        with self.assertRaisesRegex(BrainError, "budget_extension_confirmation_required"):
            await engine.extend_budget(job["id"], self.scope, "document", False)
        extended = await engine.extend_budget(job["id"], self.scope, "document", True)
        self.assertEqual("queued", extended["status"])
        self.assertEqual("document", extended["profile"])
        self.assertEqual({"tokens": 9000, "calls": 3, "tools": 2, "seconds": 120, "reserved": 0}, extended["budget"])

    async def test_unknown_provider_usage_charges_and_releases_reservation(self):
        class FailingPlanner(Planner):
            async def decide(self, context, catalogue, profile, max_output):
                raise TimeoutError()
        job = self.submit()
        async def current(scope):
            return self.user
        engine = Engine(self.repo, Registry([self.tool()]), FailingPlanner([]), identity=current)
        await engine.tick()
        failed = self.repo.get(job["id"], self.scope)
        self.assertEqual("blocked", failed["status"])
        self.assertEqual(100, failed["budget"]["tokens"])
        self.assertEqual(0, failed["budget"]["reserved"])
        self.assertNotIn("reservation", failed)
        with self.repo.transaction() as connection:
            rows = self.repo.sql(connection, "SELECT used,reserved FROM nora_budget").fetchall()
        self.assertTrue(rows)
        self.assertTrue(all(row["used"] == 100 and row["reserved"] == 0 for row in rows))

    def test_audit_events_are_scope_bound_and_form_an_ordered_chain(self):
        job = self.submit()
        def record(current, connection):
            self.repo.event(connection, current, "synthetic_check", {"step": "step-a", "ok": True})
        updated = self.repo.mutate(job["id"], self.scope, record)
        with self.repo.transaction() as connection:
            rows = self.repo.sql(connection, "SELECT id,tenant,actor,workspace,payload FROM nora_events WHERE job_id=? ORDER BY at,id", (job["id"],)).fetchall()
        self.assertEqual(2, len(rows))
        payloads = {row["id"]: json.loads(row["payload"]) for row in rows}
        latest = payloads[updated["lastEventId"]]
        self.assertIn(latest["previousEventId"], payloads)
        self.assertEqual({"tenant": "tenant-a", "user": "user-a", "workspace": "primary"}, latest["scope"])
        self.assertEqual("step-a", latest["operationId"])


if __name__ == "__main__":
    unittest.main()
