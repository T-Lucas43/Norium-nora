"""Reconciliação de envios do cérebro da Nora e readiness com o cérebro ligado."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from app.modules.nora.brain import outbound
from app.modules.nora.brain.repository import Repository
from app.modules.whatsapp import RemoteOutcomeUnknown, SendResult
from app.services.gmail_reconcile import EMAIL_KEY_HEADER, find_sent_by_key

SCOPE = {"tenant": "tenant-a", "user": "user-a", "workspace": "primary"}
USER = {"id": "user-a"}


class Clock:
    def __init__(self):
        self.value = 1_800_000_000.0

    def __call__(self):
        return self.value


def job_for(operation_id, intent_at):
    return {"id": "job-1", "scope": SCOPE, "operationId": operation_id,
            "steps": [{"id": operation_id, "intentAt": intent_at}]}


class FakeGmail:
    """Gmail simulado: Enviados com cabeçalhos, paginação e falhas controladas."""

    sent: list = []
    page_size = 100
    endless = False
    broken_ids: set = set()
    sender = "eu@example.com"

    def __init__(self, user_id):
        self.user_id = user_id

    def status(self):
        return {"connected": True, "email": self.sender}

    def send_message(self, **kwargs):
        message_id = "gm-%d" % (len(FakeGmail.sent) + 1)
        FakeGmail.sent.append({"id": message_id, "headers": dict(kwargs.get("extra_headers") or {})})
        return {"sent": True, "message": {"id": message_id}}

    def list_message_ids(self, *, folder, query, page_token=None, max_results=25):
        assert folder == "sent" and query.startswith("after:")
        offset = int(page_token or 0)
        items = [{"id": item["id"]} for item in FakeGmail.sent[offset:offset + max_results]]
        more = FakeGmail.endless or offset + max_results < len(FakeGmail.sent)
        return {"messages": items, "nextPageToken": str(offset + max_results) if more else None}

    def sent_message_headers(self, message_id):
        if message_id in FakeGmail.broken_ids:
            raise RuntimeError("synthetic metadata failure")
        item = next(i for i in FakeGmail.sent if i["id"] == message_id)
        return {"payload": {"headers": [{"name": k, "value": v} for k, v in item["headers"].items()]}}


class EnvMixin:
    def setUp(self):
        self.env = patch.dict(os.environ, {"ENVIRONMENT": "test", "APP_ENV": "test",
                                           "NORA_BRAIN_RECONCILE_SETTLE_SECONDS": "300"})
        self.env.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.repo = Repository("sqlite:///" + str(Path(self.temporary.name) / "brain.sqlite3"), clock=self.clock)
        self.repo.initialize()

    def tearDown(self):
        self.temporary.cleanup()
        self.env.stop()


class EmailReconcileTests(EnvMixin, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        FakeGmail.sent, FakeGmail.endless, FakeGmail.broken_ids = [], False, set()
        self.gmail = patch("app.services.gmail_service.GmailService", FakeGmail)
        self.gmail.start()
        self.prepared = {"to": ["cliente@example.com"], "cc": [], "bcc": [], "subject": "Proposta",
                         "body": "Texto", "sender": FakeGmail.sender, "attachments": [], "effects": ["send"]}

    def tearDown(self):
        self.gmail.stop()
        super().tearDown()

    async def test_send_carries_operation_header_and_reconcile_finds_it(self):
        from app.modules.nora.brain.tools import reconcile_email, send_email
        job = job_for("op-email-1", self.clock())
        outcome = await send_email(USER, self.prepared, job)
        self.assertEqual("succeeded", outcome.status)
        self.assertEqual("op-email-1", FakeGmail.sent[0]["headers"][EMAIL_KEY_HEADER])
        reconciled = await reconcile_email(USER, self.prepared, job, now=self.clock())
        self.assertEqual("succeeded", reconciled.status)
        self.assertEqual("gm-1", reconciled.evidence["messageId"])
        self.assertTrue(reconciled.evidence["confirmedApplied"])
        self.assertEqual(1, len(FakeGmail.sent), "reconciliação nunca reenvia")

    async def test_complete_search_after_settle_does_not_prove_non_delivery(self):
        from app.modules.nora.brain.tools import reconcile_email
        FakeGmail.sent = [{"id": "other", "headers": {EMAIL_KEY_HEADER: "another-op"}}]
        job = job_for("op-email-2", self.clock())
        early = await reconcile_email(USER, self.prepared, job, now=self.clock() + 10)
        self.assertEqual("unknown", early.status)
        late = await reconcile_email(USER, self.prepared, job, now=self.clock() + 301)
        self.assertEqual("unknown", late.status)
        self.assertNotIn("confirmedNotApplied", late.evidence)

    async def test_incomplete_search_keeps_unknown(self):
        from app.modules.nora.brain.tools import reconcile_email
        FakeGmail.sent = [{"id": "x%d" % i, "headers": {}} for i in range(3)]
        FakeGmail.broken_ids = {"x1"}
        job = job_for("op-email-3", self.clock())
        outcome = await reconcile_email(USER, self.prepared, job, now=self.clock() + 3600)
        self.assertEqual("unknown", outcome.status)
        self.assertNotIn("confirmedNotApplied", outcome.evidence)

    async def test_pagination_limit_is_not_proof_of_absence(self):
        FakeGmail.sent = [{"id": "p%d" % i, "headers": {}} for i in range(4)]
        FakeGmail.endless = True
        result = find_sent_by_key(FakeGmail("user-a"), "missing", after_epoch=0, max_pages=2, page_size=2)
        self.assertFalse(result["found"])
        self.assertFalse(result["complete"])

    async def test_changed_sender_keeps_unknown(self):
        from app.modules.nora.brain.tools import reconcile_email
        outcome = await reconcile_email(USER, {**self.prepared, "sender": "outra@example.com"},
                                        job_for("op-email-4", self.clock()), now=self.clock() + 3600)
        self.assertEqual("unknown", outcome.status)


class FakeIntegration:
    def __init__(self, test, *, result=None, error=None):
        self.test, self.result, self.error, self.calls = test, result, error, 0

    async def send(self, user_id, command):
        self.calls += 1
        # O recibo "enviando" já precisa existir antes do provedor ser chamado.
        receipt = outbound.read(self.test.repo, SCOPE, self.test.operation_id)
        self.test.assertIsNotNone(receipt)
        self.test.assertEqual(outbound.SENDING, receipt["status"])
        if self.error is not None:
            raise self.error
        return self.result


class FakeConnect:
    async def status(self, user_id):
        return {"status": "conectado", "numero": "5511999990000"}


class WhatsAppReconcileTests(EnvMixin, unittest.IsolatedAsyncioTestCase):
    operation_id = "op-wa-1"

    def setUp(self):
        super().setUp()
        from app.modules.nora.brain.tools import whatsapp_tools
        tool = whatsapp_tools(self.repo)
        self.send, self.reconcile = tool.execute, tool.reconcile
        self.prepared = {"sender": "5511999990000", "conversationId": "5511988887777", "recipient": "Cliente",
                         "isGroup": False, "text": "Olá, segue a proposta.", "attachments": [], "effects": ["send"]}
        self.job = job_for(self.operation_id, self.clock())
        self.conversations = {}

    def chat(self, integration):
        module = types.ModuleType("app.modules.chat.router")
        module.whatsapp_integration, module.wapi_connect = integration, FakeConnect()
        return patch.dict(sys.modules, {"app.modules.chat.router": module})

    def store(self):
        async def load(user_id):
            return self.conversations
        return patch("app.services.conversation_store.load_conversations", load)

    async def test_receipt_before_and_after_send_reconciles_without_second_send(self):
        integration = FakeIntegration(self, result=SendResult(message_id="wamid-1"))
        with self.chat(integration), self.store():
            outcome = await self.send(USER, self.prepared, self.job)
            self.assertEqual("succeeded", outcome.status)
            receipt = outbound.read(self.repo, SCOPE, self.operation_id)
            self.assertEqual((outbound.SENT, "wamid-1"), (receipt["status"], receipt["provider_id"]))
            reconciled = await self.reconcile(USER, self.prepared, self.job)
            replay = await self.send(USER, self.prepared, self.job)
        self.assertEqual("succeeded", reconciled.status)
        self.assertEqual("outbound_receipt", reconciled.evidence["method"])
        self.assertTrue(replay.evidence["idempotentReplay"])
        self.assertEqual(1, integration.calls)

    async def test_unknown_provider_outcome_stays_unknown_and_is_never_resent(self):
        integration = FakeIntegration(self, error=RemoteOutcomeUnknown())
        with self.chat(integration), self.store():
            first = await self.send(USER, self.prepared, self.job)
            self.clock.value += 3600
            reconciled = await self.reconcile(USER, self.prepared, self.job)
            second = await self.send(USER, self.prepared, self.job)
        self.assertEqual("unknown", first.status)
        self.assertEqual("unknown", reconciled.status)
        self.assertNotIn("confirmedNotApplied", reconciled.evidence)
        self.assertEqual("unknown", second.status)
        self.assertEqual(1, integration.calls)

    async def test_same_text_outgoing_echo_does_not_prove_this_operation(self):
        integration = FakeIntegration(self, error=RemoteOutcomeUnknown())
        self.conversations = {self.prepared["conversationId"]: {"mensagens": [
            {"id": "other", "remetente": "contato", "texto": self.prepared["text"], "timestamp": self.clock() + 5},
            {"id": "wamid-echo", "fromMe": True, "remetente": "usuario", "texto": self.prepared["text"], "timestamp": self.clock() + 5},
        ]}}
        with self.chat(integration), self.store():
            await self.send(USER, self.prepared, self.job)
            reconciled = await self.reconcile(USER, self.prepared, self.job)
        self.assertEqual("unknown", reconciled.status)
        self.assertNotIn("confirmedApplied", reconciled.evidence)

    async def test_echo_requires_exact_provider_id_and_explicit_from_me(self):
        from app.modules.nora.brain.tools import whatsapp_echo
        message = {"id": "provider-1", "remetente": "usuario", "texto": self.prepared["text"],
                   "timestamp": self.clock() + 5}
        self.conversations = {self.prepared["conversationId"]: {"mensagens": [message]}}
        with self.store():
            self.assertIsNone(await whatsapp_echo(USER["id"], self.prepared["conversationId"],
                              self.prepared["text"], self.clock(), provider_id="provider-1"))
            message["fromMe"] = True
            self.assertIsNone(await whatsapp_echo(USER["id"], self.prepared["conversationId"],
                              self.prepared["text"], self.clock(), provider_id="another-id"))
            self.assertEqual("provider-1", await whatsapp_echo(USER["id"], self.prepared["conversationId"],
                             self.prepared["text"], self.clock(), provider_id="provider-1"))

    def test_completed_receipt_requires_provider_id(self):
        with self.assertRaises(ValueError):
            outbound.finish(self.repo, SCOPE, self.operation_id, outbound.SENT)

    async def test_conflicting_digest_never_confirms_other_send(self):
        outbound.begin(self.repo, SCOPE, self.operation_id, "whatsapp", "different-digest")
        outbound.finish(self.repo, SCOPE, self.operation_id, outbound.SENT, "other-provider-id")
        outcome = await self.reconcile(USER, self.prepared, self.job)
        self.assertEqual("unknown", outcome.status)
        self.assertEqual("receipt_conflict", outcome.evidence["reason"])

    async def test_echo_outside_window_or_other_text_is_not_proof(self):
        integration = FakeIntegration(self, error=RemoteOutcomeUnknown())
        self.conversations = {self.prepared["conversationId"]: {"mensagens": [
            {"id": "old", "remetente": "usuario", "texto": self.prepared["text"], "timestamp": self.clock() - 7200},
            {"id": "diff", "remetente": "usuario", "texto": "Outro texto", "timestamp": self.clock() + 5},
        ]}}
        with self.chat(integration), self.store():
            await self.send(USER, self.prepared, self.job)
            reconciled = await self.reconcile(USER, self.prepared, self.job)
        self.assertEqual("unknown", reconciled.status)

    async def test_absent_pre_send_receipt_proves_absence_only_after_settle(self):
        with self.store():
            early = await self.reconcile(USER, self.prepared, self.job)
            self.clock.value += 301
            late = await self.reconcile(USER, self.prepared, self.job)
        self.assertEqual("unknown", early.status)
        self.assertEqual("rejected", late.status)
        self.assertIs(True, late.evidence["confirmedNotApplied"])

    async def test_definitive_rejection_can_be_retried_once_rearmed(self):
        from app.modules.whatsapp import RemoteRejected
        rejected = FakeIntegration(self, error=RemoteRejected())
        with self.chat(rejected), self.store():
            first = await self.send(USER, self.prepared, self.job)
            reconciled = await self.reconcile(USER, self.prepared, self.job)
        self.assertEqual("rejected", first.status)
        self.assertIs(True, reconciled.evidence["confirmedNotApplied"])
        accepted = FakeIntegration(self, result=SendResult(message_id="wamid-2"))
        with self.chat(accepted), self.store():
            second = await self.send(USER, self.prepared, self.job)
        self.assertEqual("succeeded", second.status)
        self.assertEqual(1, accepted.calls)

    def test_receipts_hold_no_recipient_or_text(self):
        outbound.begin(self.repo, SCOPE, "op-privacy", "whatsapp",
                       outbound.target_digest("whatsapp", self.prepared["conversationId"], self.prepared["text"]))
        with self.repo.transaction() as connection:
            row = dict(self.repo.sql(connection, "SELECT * FROM nora_outbound_receipts").fetchone())
        flat = " ".join(str(value) for value in row.values())
        self.assertNotIn(self.prepared["conversationId"], flat)
        self.assertNotIn("proposta", flat)


class RegistryPolicyTests(EnvMixin, unittest.TestCase):
    def test_mailbox_start_is_a_write_and_sends_have_reconcile(self):
        from app.modules.nora.brain.tools import registry
        tools = registry(self.repo).tools
        self.assertEqual("D", tools["mailbox_start"].policy)
        self.assertIsNotNone(tools["mailbox_start"].reconcile)
        self.assertIsNotNone(tools["email_send"].reconcile)
        self.assertIsNotNone(tools["whatsapp_send"].reconcile)
        self.assertEqual("R", tools["email_send"].policy)
        self.assertEqual("R", tools["whatsapp_send"].policy)


class BrainReadinessTests(unittest.TestCase):
    def test_readiness_with_brain_enabled_uses_runtime_repository(self):
        from app.modules.nora.brain.runtime import clear_runtime_cache
        from app.modules.system.router import readiness
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "NORIUM_DATA_DIR": directory, "ENVIRONMENT": "test", "APP_ENV": "test", "NORA_BRAIN_ENABLED": "1",
            "NORA_BRAIN_DATABASE_URL": "sqlite:///" + str(Path(directory) / "brain" / "brain.sqlite3"),
        }):
            clear_runtime_cache()
            try:
                result = asyncio.run(readiness())
            finally:
                clear_runtime_cache()
        self.assertIs(True, result["ready"])
        self.assertEqual({"status": "ready", "driver": "sqlite"}, result["checks"]["noraBrain"])


if __name__ == "__main__":
    unittest.main()
