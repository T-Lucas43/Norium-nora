"""No real account, model call or external send is used by these regressions."""
import copy
import asyncio
from datetime import timedelta
import unittest
from unittest.mock import patch, AsyncMock

from fastapi import HTTPException
from app.modules.mail import productivity as work


class FakeGmail:
    send_error = False
    sends = []
    calls = []

    def __init__(self, user_id):
        self.user_id = user_id

    def status(self):
        return {"connected": True, "email": self.user_id + "@example.test"}

    def list_message_ids(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["folder"] == "sent":
            return {"messages": [{"id": "confirmed"}]}
        if kwargs.get("page_token"):
            return {"messages": [{"id": "two"}, {"id": "three"}], "resultSizeEstimate": 3}
        return {"messages": [{"id": "one"}, {"id": "two"}], "nextPageToken": "second", "resultSizeEstimate": 3}

    def get_message(self, message_id):
        return {"message": {"id": message_id, "subject": "Prazo", "fromEmail": "sender@example.test", "bodyText": "Texto " * 1000, "snippet": "Pergunta pendente", "unread": True}}

    def get_message_for_analysis(self, message_id, **kwargs):
        return self.get_message(message_id)

    def send_message(self, **kwargs):
        self.sends.append(kwargs)
        if self.send_error:
            raise TimeoutError("synthetic transport failure")
        return {"sent": True, "message": {"id": "provider-id"}}


class WorkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = {}
        def read(actor, name, fallback):
            return copy.deepcopy(self.store.get((actor, name), fallback))
        def write(actor, name, value):
            self.store[(actor, name)] = copy.deepcopy(value)
        for target, replacement in [("read_user_db", read), ("write_user_db", write), ("read_account_db", read), ("write_account_db", write), ("GmailService", FakeGmail)]:
            entered = patch.object(work, target, replacement)
            entered.start(); self.addCleanup(entered.stop)
        FakeGmail.sends = []; FakeGmail.calls = []; FakeGmail.send_error = False
        work._locks.clear()
        self.user = {"id": "alice", "permissions": {"nora": True, "emails": True, "integracao_gmail": True}}

    async def mailbox(self, **kwargs):
        return await work.create(self.user, work.WorkRequest(requestId="request-123", **kwargs))

    async def campaign(self):
        return await self.mailbox(kind="campaign", purpose="Atualização autorizada", subject="Atualização", body="Olá {{email}}", recipients=[work.Recipient(email="customer@example.test")])

    async def decision(self, job, action, **kwargs):
        return (await work.decide(job["id"], action, work.Decision(digest=job["digest"], **kwargs), self.user))["job"]

    async def test_all_pages_deduplicate_and_coverage(self):
        job = await self.mailbox(includeBody=True)
        job = await self.decision(job, "resume")
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["read"], 2)
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["read"], 3)
        self.assertEqual(job["pageCount"], 2)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["truncatedBodies"], 3)
        self.assertEqual(FakeGmail.calls[1]["page_token"], "second")
        self.assertIn("3", work.report(job))

    async def test_budget_pause_preserves_pending_and_resume(self):
        job = await self.mailbox(messageBudget=1)
        job = await self.decision(job, "resume")
        await work.advance(self.user, job["id"])
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["status"], "budget_reached")
        result = await work.extend(job["id"], work.Budget(messageBudget=5), self.user)
        job = await self.decision(result["job"], "resume")
        await work.advance(self.user, job["id"])
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["read"], 3)

    async def test_campaign_never_sends_before_approval(self):
        job = await self.campaign()
        await work.advance(self.user, job["id"])
        self.assertEqual(FakeGmail.sends, [])
        with self.assertRaises(HTTPException):
            await self.decision(job, "approve")
        job = await self.decision(job, "approve", acknowledged=True)
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["sent"], 1)
        self.assertEqual(FakeGmail.sends[0]["to"], ["customer@example.test"])
        self.assertEqual(job["status"], "completed")

    async def test_timeout_remains_uncertain_without_resend(self):
        FakeGmail.send_error = True
        job = await self.campaign()
        job = await self.decision(job, "approve", acknowledged=True)
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["unknown"], 0)
        self.assertEqual(job["status"], "unknown")
        await work.advance(self.user, job["id"])
        self.assertEqual(len(FakeGmail.sends), 1)
        self.assertIn("resultado incerto", work.report(job))
        job = await self.decision(job, "reconcile")
        self.assertEqual(job["sent"], 1)
        self.assertEqual(len(FakeGmail.sends), 1)

    async def test_changed_campaign_invalidates_approval(self):
        job = await self.campaign()
        job = await self.decision(job, "approve", acknowledged=True)
        self.store[("alice", work.STORE)]["jobs"][0]["spec"]["body"] = "Alterado"
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["status"], "approval_changed")
        self.assertEqual(FakeGmail.sends, [])

    async def test_other_actor_cannot_read_or_advance(self):
        job = await self.mailbox()
        with self.assertRaises(HTTPException) as caught:
            await work.advance({**self.user, "id": "bob"}, job["id"])
        self.assertEqual(caught.exception.status_code, 404)

    async def test_other_workspace_cannot_access_job(self):
        job = await self.mailbox()
        with patch.object(work, "current_workspace_id", return_value="another"):
            with self.assertRaises(HTTPException) as caught:
                await work.advance(self.user, job["id"])
        self.assertEqual(caught.exception.status_code, 404)

    async def test_concurrent_advance_sends_one_recipient_once(self):
        job = await self.campaign()
        await self.decision(job, "approve", acknowledged=True)
        await asyncio.gather(work.advance(self.user, job["id"]), work.advance(self.user, job["id"]))
        self.assertEqual(len(FakeGmail.sends), 1)

    async def test_test_preview_has_separate_approval_and_targets_self(self):
        original = await self.campaign()
        result = await work.prepare_test(original["id"], work.Decision(digest=original["digest"]), self.user)
        job = result["job"]
        self.assertNotEqual(original["digest"], job["digest"])
        self.assertEqual(job["spec"]["recipients"][0]["email"], "alice@example.test")
        self.assertEqual(job["status"], "awaiting_approval")
        self.assertEqual(FakeGmail.sends, [])

    async def test_daily_account_limit_stops_before_external_effect(self):
        job = await self.campaign()
        await self.decision(job, "approve", acknowledged=True)
        self.store[("alice", "nora_mail_daily")] = {"date": work.now().date().isoformat(), "attempts": 100}
        job = await work.advance(self.user, job["id"])
        self.assertEqual(job["status"], "daily_limit")
        self.assertEqual(FakeGmail.sends, [])

    async def test_attachment_change_stops_before_sending(self):
        metadata = {"name": "proposal.pdf", "mimeType": "application/pdf"}
        with patch("app.services.nora_files.owned_bytes", return_value=(metadata, b"original")):
            job = await self.mailbox(kind="campaign", purpose="Atualização", subject="Proposta", body="Revise o anexo", recipients=[work.Recipient(email="client@example.test")], attachmentIds=["file-123"])
        await self.decision(job, "approve", acknowledged=True)
        with patch("app.services.nora_files.owned_bytes", return_value=(metadata, b"changed")):
            job = await work.advance(self.user, job["id"])
        self.assertEqual(job["status"], "attachment_changed")
        self.assertEqual(FakeGmail.sends, [])

    async def test_expiration_removes_content_and_keeps_minimal_receipt(self):
        await self.campaign()
        future = work.now() + timedelta(days=8)
        with patch.object(work, "now", return_value=future):
            result = await work.jobs(self.user)
        self.assertEqual(result["items"], [])
        stored = self.store[("alice", work.STORE)]
        self.assertEqual(len(stored["archive"]), 1)
        self.assertNotIn("body", stored["archive"][0])
        self.assertNotIn("recipients", stored["archive"][0])

    async def test_automation_prepares_work_without_reading_or_sending(self):
        from app.modules.automations.router import apply_automation_effects
        raw = {**self.user, "status": "ativo"}
        automation = {"id": "flow-test", "flow": {"nodes": [{"id": "mail", "kind": "action", "title": "Preparar leitura paginada de e-mails"}]}}
        with patch("app.modules.auth.router.read_user_store", AsyncMock(return_value={"users": [raw]})), patch("app.modules.auth.router.sanitize_user", return_value=self.user):
            effects = await apply_automation_effects("alice", automation)
        self.assertTrue(any("preparado" in item for item in effects))
        self.assertEqual(FakeGmail.calls, [])
        self.assertEqual(FakeGmail.sends, [])

    async def test_automation_rechecks_revoked_actor(self):
        from app.modules.automations.router import apply_automation_effects
        automation = {"id": "flow-test", "flow": {"nodes": [{"id": "mail", "kind": "action", "title": "Preparar leitura paginada de e-mails"}]}}
        with patch("app.modules.auth.router.read_user_store", AsyncMock(return_value={"users": [{"id": "alice", "status": "inativo"}]})):
            with self.assertRaises(ValueError):
                await apply_automation_effects("alice", automation)
        self.assertEqual(self.store, {})

    async def test_workspace_tool_checks_underlying_module_permission(self):
        from app.modules.nora.brain.workspace_tools import module_query
        with self.assertRaises(HTTPException) as caught:
            await module_query(self.user, {"module": "finance", "query": ""}, {})
        self.assertEqual(caught.exception.status_code, 403)

    async def test_finance_projection_does_not_export_complete_records(self):
        from app.modules.nora.brain.workspace_tools import module_query
        user = {**self.user, "role": "owner", "plan": "individual", "permissions": {**self.user["permissions"], "gastos": True}}
        payload = {"resumo": {"saldo": 50}, "lancamentos": [{"descricao": "PRIVATE-CUSTOMER-RECORD", "valor": 200}]}
        with patch("app.services.finance_store.list_finance", return_value=payload):
            result = await module_query(user, {"module": "finance", "query": ""}, {})
        self.assertEqual(result.data["summary"]["saldo"], 50)
        self.assertNotIn("PRIVATE-CUSTOMER-RECORD", str(result.data))

    async def test_consolidation_is_bounded_and_never_sends(self):
        job = await self.mailbox()
        stored = self.store[("alice", work.STORE)]["jobs"][0]
        stored["summaries"] = ["Resumo sintético " * 100 for _ in range(40)]
        with patch("app.services.nora.NoraIAService.perguntar_nora", AsyncMock(return_value="Resumo executivo com limites")) as model:
            job = await self.decision(job, "summarize")
        self.assertEqual(job["consolidatedBatches"], 30)
        self.assertEqual(job["consolidated"], "Resumo executivo com limites")
        self.assertLess(len(model.call_args.args[0][0]["content"]), 26000)
        self.assertEqual(FakeGmail.sends, [])

    async def test_idempotency_rejects_changed_content(self):
        first = await self.mailbox()
        self.assertEqual(first["id"], (await self.mailbox())["id"])
        with self.assertRaises(HTTPException) as caught:
            await self.mailbox(query="is:unread")
        self.assertEqual(caught.exception.status_code, 409)

    def test_permission_does_not_depend_on_client_role(self):
        with self.assertRaises(HTTPException):
            work.require_mail({"id": "alice", "role": "owner", "permissions": {"nora": True}})

    def test_informal_whole_inbox_request_and_help_question(self):
        self.assertEqual(work.requested_work("leia minha caixa entrada inteira"), "mailbox")
        self.assertEqual(work.requested_work("ler todos meus emails"), "mailbox")
        self.assertIsNone(work.requested_work("como ler todos os emails"))


if __name__ == "__main__":
    unittest.main()
