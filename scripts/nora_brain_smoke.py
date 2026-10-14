"""Exercise the real worker loop with synthetic adapters and loopback PostgreSQL.

No dotenv, model, Gmail, WhatsApp or legacy business writer is used. Credentials
are read from an ignored local JSON file, never emitted. The database must be
dedicated to this smoke; existing databases and application accounts are refused.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid


def environment(credentials: Path, output: Path) -> str:
    url = json.loads(credentials.read_text(encoding="utf-8"))["dsn"]
    parsed = urlsplit(url)
    if (parsed.scheme != "postgresql" or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.path != "/norium_brain_smoke" or parsed.username != "norium_smoke"):
        raise ValueError("A dedicated loopback norium_brain_smoke database is required")
    inherited = {key: os.environ[key] for key in (
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LOCALAPPDATA", "TEMP", "TMP",
    ) if key in os.environ}
    os.environ.clear()
    os.environ.update(inherited)
    os.environ.update({"ENVIRONMENT": "test", "APP_ENV": "test",
        "PYTHON_DOTENV_DISABLED": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "NORIUM_DATA_DIR": str(output / "synthetic-data"),
        "NORA_BRAIN_DATABASE_URL": url, "NORA_BRAIN_EXECUTOR_ENABLED": "1"})
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "norium-back-end"))
    return url


def components(url: str, run: str):
    from app.modules.nora.brain.contracts import Decision, ModelReply, Outcome, Scope, Strict
    from app.modules.nora.brain.engine import Engine
    from app.modules.nora.brain.policy import Registry, Tool
    from app.modules.nora.brain.repository import Repository
    from typing import Literal

    class Args(Strict):
        mode: Literal["read", "review", "crash"]

    repo = Repository(url)
    repo.initialize()
    scope = Scope("smoke-" + run, "smoke-user-" + run, "primary")
    user = {"id": scope.user, "teamOwnerId": scope.tenant,
            "permissions": {"nora": True, "tarefas": True}}

    async def identity(current):
        if current != scope:
            raise ValueError("Synthetic identity is scoped to this run")
        return user

    with repo.transaction() as connection:
        repo.sql(connection, "CREATE TABLE IF NOT EXISTS nora_smoke_effects "
            "(operation_id TEXT PRIMARY KEY, run TEXT NOT NULL, mode TEXT NOT NULL)")
        repo.sql(connection, "CREATE TABLE IF NOT EXISTS nora_smoke_observations "
            "(job_id TEXT PRIMARY KEY, run TEXT NOT NULL, state TEXT NOT NULL)")

    class Planner:
        def context(self, job, user, registry):
            with repo.transaction() as connection:
                repo.sql(connection, "INSERT INTO nora_smoke_observations(job_id,run,state) "
                    "VALUES (?,?,?) ON CONFLICT DO NOTHING", (job["id"], run, job["status"]))
            return [], job

        def reservation(self, context, catalogue, remaining, context_limit):
            self.current = context
            return 100, 50

        async def decide(self, context, catalogue, profile, max_output):
            mode = context["message"]
            decision = (Decision(kind="answer", text="Concluído com evidência sintética.")
                if context["steps"] else Decision(kind="tool", tool="smoke_read" if mode == "read" else "smoke_review",
                    arguments={"mode": mode}))
            return ModelReply(decision, 20, 10, "synthetic-no-provider")

    async def prepare(user, args, job):
        return {"mode": args.mode, "effects": [] if args.mode == "read" else ["synthetic_receipt"]}

    async def execute(user, prepared, job):
        if prepared["mode"] != "read":
            with repo.transaction() as connection:
                # Deliberately no ON CONFLICT: duplicate execution fails the smoke.
                repo.sql(connection, "INSERT INTO nora_smoke_effects(operation_id,run,mode) VALUES (?,?,?)",
                    (job["operationId"], run, prepared["mode"]))
        if prepared["mode"] == "crash":
            os._exit(23)  # committed synthetic effect; no observed outcome
        return Outcome("succeeded", {}, {"operationId": job["operationId"], "synthetic": True})

    registry = Registry([
        Tool("smoke_read", "Consulta sintética", "tarefas", "C", Args, prepare, execute),
        Tool("smoke_review", "Efeito sintético", "tarefas", "R", Args, prepare, execute),
    ])
    return repo, scope, Engine(repo, registry, Planner(), identity=identity)


def wait_for(repo, job_id, scope, expected, process, timeout=25):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        job = repo.get(job_id, scope)
        if job["status"] == expected:
            return job
        if process.poll() is not None:
            raise RuntimeError("Synthetic worker stopped before the expected state")
        if job["status"] in {"blocked", "failed", "budget_paused"}:
            raise RuntimeError("Synthetic job did not progress: " + job["status"])
        time.sleep(0.1)
    raise RuntimeError("Timed out waiting for synthetic job state " + expected)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run", default="")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    url = environment(args.credentials_file.resolve(), args.output)
    run = args.run or uuid.uuid4().hex
    repo, scope, executor = components(url, run)
    if args.worker:
        from app.modules.nora.brain import worker
        worker.repository = lambda: repo
        worker.engine = lambda: executor
        asyncio.run(worker.run())
        return 0

    from app.modules.nora.brain.contracts import BrainError, Submit
    started = time.monotonic()
    children = []
    log = (args.output / "synthetic-worker.log").open("ab")

    def start():
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
            "--credentials-file", str(args.credentials_file.resolve()), "--output", str(args.output),
            "--run", run, "--worker"], stdout=log, stderr=log, env=os.environ.copy())
        children.append(child)
        return child

    def count(mode):
        with repo.transaction() as connection:
            return repo.sql(connection, "SELECT COUNT(*) AS total FROM nora_smoke_effects WHERE run=? AND mode=?",
                (run, mode)).fetchone()["total"]

    try:
        health = repo.ping()
        assert health == {"status": "ready", "driver": "postgresql"}
        read = repo.create(scope, Submit(requestId="read-" + run, message="read"))
        assert read["status"] == "queued"
        child = start()
        wait_for(repo, read["id"], scope, "completed", child)
        with repo.transaction() as connection:
            observation = repo.sql(connection, "SELECT state FROM nora_smoke_observations WHERE job_id=?", (read["id"],)).fetchone()
        assert observation["state"] == "running"
        review = repo.create(scope, Submit(requestId="review-" + run, message="review"))
        pending = wait_for(repo, review["id"], scope, "awaiting_approval", child)
        assert count("review") == 0
        approval = pending["steps"][0]["approval"]
        try:
            asyncio.run(executor.approve(review["id"], scope, approval["id"], "0" * 64))
        except BrainError:
            pass
        else:
            raise AssertionError("Changed digest was accepted")
        assert count("review") == 0
        asyncio.run(executor.approve(review["id"], scope, approval["id"], approval["digest"]))
        wait_for(repo, review["id"], scope, "completed", child)
        assert count("review") == 1
        crash = repo.create(scope, Submit(requestId="crash-" + run, message="crash"))
        pending = wait_for(repo, crash["id"], scope, "awaiting_approval", child)
        approval = pending["steps"][0]["approval"]
        assert count("crash") == 0
        asyncio.run(executor.approve(crash["id"], scope, approval["id"], approval["digest"]))
        assert child.wait(timeout=25) == 23
        assert count("crash") == 1
        interrupted = repo.get(crash["id"], scope)
        assert interrupted["steps"][0]["status"] == "executing"
        # Expire only this synthetic lease; avoid a two-minute sleep.
        with repo.transaction() as connection:
            repo.sql(connection, "UPDATE nora_jobs SET lease_until=0 WHERE id=? AND tenant=? AND actor=?",
                (crash["id"], scope.tenant, scope.user))
        restarted = start()
        final = wait_for(repo, crash["id"], scope, "unknown", restarted)
        assert final["steps"][0]["status"] == "unknown"
        time.sleep(1.2)
        assert count("crash") == 1
        receipt = {"status": "passed", "driver": health["driver"], "synthetic": True,
            "worker": "actual worker.run loop with synthetic identity/model/tools",
            "transitions": ["queued", "running", "completed"],
            "effectsBeforeApproval": 0, "changedDigestRejected": True,
            "approvedEffects": count("review"), "restartState": final["status"],
            "effectsAfterRestart": count("crash"), "seconds": round(time.monotonic() - started, 3),
            "externalProvidersUsed": False, "liveAuthenticationChecked": False}
        (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(receipt))
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
        log.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # URLs and credentials never appear in diagnostics.
        print(json.dumps({"status": "failed", "errorClass": type(error).__name__}))
        raise SystemExit(1) from None
