from __future__ import annotations

import os
import hashlib
import hmac
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.modules.nora.brain import router as routes
from app.modules.nora.brain.contracts import Outcome, Scope, Strict, Submit, canonical
from app.modules.nora.brain.policy import Registry, Tool
from app.modules.nora.brain.repository import Repository
from app.core.request_context import current_workspace_id
from pydantic import Field


class InternalArgs(Strict):
    value: str = Field(min_length=1)


class NoraBrainApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_environment = os.environ.get("ENVIRONMENT")
        os.environ["ENVIRONMENT"] = "test"
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Repository("sqlite:///" + str(Path(self.temporary.name) / "brain.sqlite3"))
        self.repo.initialize()
        self.user = {"id": "user-a", "teamOwnerId": "tenant-a", "permissions": {"nora": True}}
        self.app = FastAPI()
        self.app.include_router(routes.router, prefix="/api/nora")
        self.app.dependency_overrides[routes.brain_user] = lambda: self.user

    def tearDown(self):
        self.temporary.cleanup()
        if self.old_environment is None:
            os.environ.pop("ENVIRONMENT", None)
        else:
            os.environ["ENVIRONMENT"] = self.old_environment

    async def request(self, method, path, **kwargs):
        with patch.object(routes, "repository", return_value=self.repo):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
                return await client.request(method, path, **kwargs)

    async def test_submit_is_scoped_and_does_not_expose_executor_lease(self):
        payload = {"requestId": "request-api-1", "message": "Crie uma tarefa", "category": "routine",
                   "complexBudgetApproved": False, "attachmentIds": []}
        response = await self.request("POST", "/api/nora/brain/jobs", json=payload,
                                      headers={"Idempotency-Key": payload["requestId"]})
        self.assertEqual(202, response.status_code)
        job = response.json()["job"]
        self.assertNotIn("lease", job)
        self.assertNotIn("leaseUntil", job)

        self.user = {"id": "user-b", "teamOwnerId": "tenant-b", "permissions": {"nora": True}}
        hidden = await self.request("GET", f"/api/nora/brain/jobs/{job['id']}")
        self.assertEqual(404, hidden.status_code)

    async def test_header_and_body_idempotency_keys_must_match(self):
        response = await self.request("POST", "/api/nora/brain/jobs", json={
            "requestId": "request-api-2", "message": "Teste", "category": "routine",
            "complexBudgetApproved": False, "attachmentIds": [],
        }, headers={"Idempotency-Key": "request-api-other"})
        self.assertEqual(422, response.status_code)
        self.assertEqual("idempotency_key_mismatch", response.json()["detail"]["code"])

    async def test_internal_endpoint_rejects_invalid_signature(self):
        payload = {"jobId": "job-123456789012", "stepId": "step-12345678", "phase": "prepare",
                   "lease": "lease", "nonce": "a" * 32}
        with patch.dict(os.environ, {"NORA_BRAIN_INTERNAL_SECRET": "s" * 32,
                                     "NORA_LEGACY_WRITER_SINGLETON": "1"}, clear=False):
            response = await self.request("POST", "/api/nora/brain/internal/tool", json=payload,
                                          headers={"X-Nora-Timestamp": str(int(time.time())),
                                                   "X-Nora-Signature": "0" * 64})
        self.assertEqual(401, response.status_code)
        self.assertEqual("invalid_internal_signature", response.json()["detail"]["code"])

    async def test_internal_request_uses_persisted_step_and_rejects_replay(self):
        async def prepare(user, args, job):
            return {"value": args.value, "workspace": current_workspace_id(), "effects": []}
        async def execute(user, prepared, job):
            return Outcome("succeeded", {}, {"operationId": job["operationId"]})
        tool = Tool("tasks_internal", "Teste", "nora", "C", InternalArgs, prepare, execute)
        job = self.repo.create(Scope("tenant-a", "user-a", "workspace-b"),
                               Submit(requestId="internal-request-1", message="Teste"))
        def add_step(current, connection):
            current["steps"].append({"id": "step-12345678", "tool": tool.name, "version": tool.version,
                                     "arguments": {"value": "persistido"}, "status": "planned", "attempts": 0})
        self.repo.mutate(job["id"], None, add_step)
        claimed = self.repo.claim()
        payload = {"jobId": job["id"], "stepId": "step-12345678", "phase": "prepare",
                   "lease": claimed["lease"], "nonce": "b" * 32}
        timestamp, secret = str(int(time.time())), "s" * 32
        signature = hmac.new(secret.encode(), (timestamp + "\n" + canonical(payload)).encode(), hashlib.sha256).hexdigest()
        environment = {"NORA_BRAIN_INTERNAL_SECRET": secret, "NORA_LEGACY_WRITER_SINGLETON": "1"}
        fake_engine = SimpleNamespace(registry=Registry([tool]))
        with patch.dict(os.environ, environment, clear=False), patch.object(routes, "engine", return_value=fake_engine), \
             patch.object(routes, "live_user", AsyncMock(return_value=self.user)):
            first = await self.request("POST", "/api/nora/brain/internal/tool", content=canonical(payload),
                                       headers={"Content-Type": "application/json", "X-Nora-Timestamp": timestamp,
                                                "X-Nora-Signature": signature})
            replay = await self.request("POST", "/api/nora/brain/internal/tool", content=canonical(payload),
                                        headers={"Content-Type": "application/json", "X-Nora-Timestamp": timestamp,
                                                 "X-Nora-Signature": signature})
        self.assertEqual(200, first.status_code)
        self.assertEqual("persistido", first.json()["result"]["value"])
        self.assertEqual("workspace-b", first.json()["result"]["workspace"])
        self.assertEqual(409, replay.status_code)
        self.assertEqual("internal_request_replayed", replay.json()["detail"]["code"])


if __name__ == "__main__":
    unittest.main()
