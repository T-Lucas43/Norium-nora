"""Guided email sending through Nora with exact, digest-bound approvals."""

import asyncio
import hashlib
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.core.request_context import reset_request_context, set_request_context
from app.modules.nora import router as nora_router
from app.modules.nora.router import NoraNaturalPayload
from app.modules.mail.router import EmailAgentPayload, conversar_com_agente_email
from app.modules.operations import service as ops
from app.modules.operations.repository import APPROVAL_DB, SEND_DB, list_items, replace_item
from app.modules.operations.schemas import ApprovalDecision, ApprovalUpdate
from app.services import nora_files
from app.services.email_agent import EmailAgent
from app.services.gmail_service import GmailConfigError
from app.services.nora_skills import SkillResolution


class FakeHttpError(Exception):
    def __init__(self, status: int):
        self.resp = SimpleNamespace(status=status)
        super().__init__(f"http {status}")


class FakeGmail:
    connected = True
    sent: list = []
    sent_messages: list = []
    listed: list = []
    send_behavior = "ok"

    def __init__(self, user_id: str = "owner-mail") -> None:
        self.user_id = user_id

    def status(self) -> dict:
        return {"connected": FakeGmail.connected}

    def send_message(self, **kwargs):
        behavior = FakeGmail.send_behavior
        if isinstance(behavior, tuple) and behavior[0] == "raise":
            raise behavior[1]
        FakeGmail.sent.append(kwargs)
        return {"sent": True, "message": {"id": "gmail-123", "threadId": "thread-1"}}

    def list_messages(self, **kwargs):
        FakeGmail.listed.append(kwargs)
        return {"messages": list(FakeGmail.sent_messages)}


def owner(user_id: str = "owner-mail") -> dict:
    return {"id": user_id, "nome": "Tester", "role": "owner"}


def email_resolution() -> SkillResolution:
    return SkillResolution(
        skill_id="email",
        confidence=0.9,
        score=3.0,
        margin=1.0,
        needs_semantic_fallback=False,
        matched_signals=(),
        alternatives=(),
    )


def natural_email_gates(test_case: unittest.TestCase) -> None:
    patches = [
        patch.object(nora_router, "resolve_skill", return_value=email_resolution()),
        patch.object(nora_router, "resolve_read_query", return_value=None),
        patch.object(nora_router, "answer_module_help", return_value=None),
        patch.object(nora_router, "mensagem_social_curta", return_value=None),
        patch.object(nora_router, "memory_preference_request", return_value=None),
        patch.object(nora_router, "web_research_request", return_value=False),
        patch.object(nora_router, "browser_tool_request", return_value=None),
        patch.object(nora_router, "is_compound_request", return_value=False),
        patch.object(nora_router, "is_team_meeting_intent", return_value=False),
        patch.object(nora_router, "is_whatsapp_send_request", return_value=False),
        patch.object(nora_router, "message_with_memory", AsyncMock(side_effect=lambda user, text, cats: text)),
    ]
    for entered in patches:
        entered.start()
        test_case.addCleanup(entered.stop)


class NoraEmailApprovalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request_context = set_request_context("test-nora-email", "primary")
        self.addCleanup(reset_request_context, self.request_context)
        FakeGmail.connected = True
        FakeGmail.sent = []
        FakeGmail.sent_messages = []
        FakeGmail.listed = []
        FakeGmail.send_behavior = "ok"
        for target in ("app.services.gmail_service.GmailService", "app.services.email_agent.GmailService"):
            entered = patch(target, FakeGmail)
            entered.start()
            self.addCleanup(entered.stop)
        polish = patch(
            "app.services.nora.NoraIAService.perguntar_nora",
            AsyncMock(return_value="Corpo polido pela Nora."),
        )
        polish.start()
        self.addCleanup(polish.stop)

    async def drive_to_preview(self, agent: EmailAgent, first: str = "mande um e-mail para a@x.com sobre Reuniao dizendo vamos conversar amanha"):
        result = await agent.handle(message=first, session_id=None, user_id="owner-mail")
        session_id = result["session_id"]
        for text in ["pular", "pular", "pular"]:
            result = await agent.handle(message=text, session_id=session_id, user_id="owner-mail")
            session_id = result["session_id"]
        return result

    async def test_guided_collection_asks_only_required_missing_fields(self) -> None:
        agent = EmailAgent()
        first = await agent.handle(message="mande um e-mail", session_id=None, user_id="owner-mail")
        self.assertEqual("coletando", first["status"])
        self.assertIn("Para qual e-mail", first["response"])
        session_id = first["session_id"]
        self.assertTrue(session_id)
        steps = [
            ("contato@empresa.com", "mensagem"),
            ("Segue a proposta combinada ontem.", "Prévia pronta"),
        ]
        result = first
        for text, expected in steps:
            result = await agent.handle(message=text, session_id=session_id, user_id="owner-mail")
            session_id = result["session_id"]
            with self.subTest(step=expected):
                self.assertIn(expected, result["response"])
        self.assertEqual("pronto_para_aprovacao", result["status"])
        preview = result["preview"]
        self.assertEqual(["contato@empresa.com"], preview["to"])
        self.assertEqual([], preview["cc"])
        self.assertEqual([], preview["bcc"])
        self.assertEqual("Segue a proposta combinada ontem", preview["subject"])
        self.assertIn("- Para: contato@empresa.com", result["response"])
        self.assertIn("(sugerido)", result["response"])
        self.assertEqual([], FakeGmail.sent)

    async def test_complete_natural_request_goes_directly_to_preview(self) -> None:
        agent = EmailAgent()
        result = await agent.handle(
            message="mande um e-mail para a@x.com sobre Reunião dizendo confirmo nossa conversa amanhã",
            session_id=None,
            user_id="owner-mail",
        )
        self.assertEqual("pronto_para_aprovacao", result["status"])
        self.assertEqual(["a@x.com"], result["preview"]["to"])
        self.assertEqual([], result["preview"]["cc"])
        self.assertEqual([], result["preview"]["bcc"])
        self.assertEqual([], FakeGmail.sent)

    async def test_preview_edit_updates_draft(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        self.assertEqual("pronto_para_aprovacao", ready["status"])
        session_id = ready["session_id"]
        edit = await agent.handle(message="editar assunto", session_id=session_id, user_id="owner-mail")
        self.assertEqual("coletando", edit["status"])
        self.assertIn("assunto", edit["response"].lower())
        updated = await agent.handle(message="Novo assunto urgente", session_id=session_id, user_id="owner-mail")
        self.assertEqual("pronto_para_aprovacao", updated["status"])
        self.assertEqual("Novo assunto urgente", updated["preview"]["subject"])
        confirmed = await agent.handle(message="sim", session_id=session_id, user_id="owner-mail")
        self.assertEqual("pronto_para_aprovacao", confirmed["status"])
        self.assertEqual("Novo assunto urgente", confirmed["emailExact"]["subject"])
        self.assertIsNone(confirmed["supersedes"])
        self.assertEqual([], FakeGmail.sent)

    async def test_cancel_ends_without_effect_and_cancels_approval(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval_id = finalized["approval"]["id"]
        cancelled = await agent.handle(message="cancelar", session_id=ready["session_id"], user_id="owner-mail")
        self.assertEqual("cancelado", cancelled["status"])
        self.assertEqual(approval_id, cancelled["cancelApprovalId"])
        await ops.finalize_email_agent_result(owner(), agent, cancelled)
        items = await list_items("owner-mail", APPROVAL_DB)
        current = next(item for item in items if item["id"] == approval_id)
        self.assertEqual("cancelled", current["status"])
        self.assertEqual([], FakeGmail.sent)

    async def test_disconnected_guides_without_claiming_send(self) -> None:
        FakeGmail.connected = False
        agent = EmailAgent()
        result = await agent.handle(message="mande um e-mail para a@x.com", session_id=None, user_id="owner-mail")
        self.assertEqual("desconectado", result["status"])
        self.assertIn("conect", result["response"].lower())
        self.assertNotIn("enviado", result["response"].lower())
        finalized = await ops.finalize_email_agent_result(owner(), agent, result)
        self.assertNotIn("approval", finalized)
        self.assertEqual([], await list_items("owner-mail", APPROVAL_DB))

    async def test_finalize_creates_exact_approval(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        self.assertEqual("aguardando_aprovacao", finalized["status"])
        self.assertEqual(ready["session_id"], finalized["session_id"])
        approval = finalized["approval"]
        self.assertEqual("nora_email_send_exact", approval["action"])
        self.assertEqual("email", approval["source"])
        self.assertEqual("pending", approval["status"])
        self.assertRegex(approval["digest"], r"^[0-9a-f]{64}$")
        self.assertTrue(approval["payload"]["idempotencyKey"].startswith("email_"))
        self.assertGreater(
            datetime.fromisoformat(approval["expiresAt"]),
            datetime.now(timezone.utc),
        )
        self.assertEqual("gmail", approval["metadata"]["tool"])
        self.assertEqual("primary", approval["metadata"]["workspace"])
        exact = approval["payload"]["emailExact"]
        self.assertEqual(["a@x.com"], exact["to"])
        linked = agent.sessions[ready["session_id"]].fields.get("_approval_id")
        self.assertEqual(approval["id"], linked)

    async def test_second_preview_supersedes_first(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        session_id = ready["session_id"]
        first = await agent.handle(message="sim", session_id=session_id, user_id="owner-mail")
        finalized_first = await ops.finalize_email_agent_result(owner(), agent, first)
        await agent.handle(message="editar corpo", session_id=session_id, user_id="owner-mail")
        await agent.handle(message="Corpo totalmente novo.", session_id=session_id, user_id="owner-mail")
        second = await agent.handle(message="sim", session_id=session_id, user_id="owner-mail")
        self.assertEqual(finalized_first["approval"]["id"], second["supersedes"])
        finalized_second = await ops.finalize_email_agent_result(owner(), agent, second)
        items = await list_items("owner-mail", APPROVAL_DB)
        by_id = {item["id"]: item for item in items}
        self.assertEqual("cancelled", by_id[finalized_first["approval"]["id"]]["status"])
        self.assertEqual("pending", by_id[finalized_second["approval"]["id"]]["status"])
        self.assertNotEqual(finalized_first["approval"]["digest"], finalized_second["approval"]["digest"])
        self.assertEqual([], FakeGmail.sent)

    async def test_approve_executes_exact_send_once(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        decided = await ops.decide_approval(
            owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"])
        )
        self.assertEqual("executed", decided["status"])
        self.assertEqual(1, len(FakeGmail.sent))
        call = FakeGmail.sent[0]
        self.assertEqual(["a@x.com"], call["to"])
        self.assertEqual("Reuniao", call["subject"])
        self.assertIn("Corpo polido", call["body"])
        self.assertEqual(approval["payload"]["idempotencyKey"], call["extra_headers"]["X-Norium-Email-Key"])
        self.assertIn("a@x.com", decided["execution"]["response"])
        replay = await ops.decide_approval(
            owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"])
        )
        self.assertEqual("executed", replay["status"])
        self.assertEqual(1, len(FakeGmail.sent))

    async def test_approve_with_wrong_or_missing_digest_denies(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        with self.assertRaises(ValueError):
            await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest="0" * 64))
        with self.assertRaises(ValueError):
            await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved"))
        items = await list_items("owner-mail", APPROVAL_DB)
        current = next(item for item in items if item["id"] == approval["id"])
        self.assertEqual("pending", current["status"])
        self.assertEqual([], FakeGmail.sent)

    async def test_expired_approval_denies(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        await replace_item("owner-mail", APPROVAL_DB, approval["id"], {"expiresAt": "2020-01-01T00:00:00+00:00"})
        with self.assertRaisesRegex(ValueError, "expirou"):
            await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        items = await list_items("owner-mail", APPROVAL_DB)
        current = next(item for item in items if item["id"] == approval["id"])
        self.assertEqual("expired", current["status"])
        self.assertEqual([], FakeGmail.sent)
        again = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("expired", again["status"])

    async def test_other_workspace_cannot_decide(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        other = set_request_context("other-workspace", "team-b")
        try:
            missing = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
            self.assertIsNone(missing)
            with self.assertRaisesRegex(ValueError, "outro ambiente"):
                await ops._enforce_approval_binding(
                    owner(),
                    "owner-mail",
                    {"id": approval["id"], "metadata": {"workspace": "primary"}, "digest": approval["digest"]},
                    ApprovalDecision(decision="approved", expectedDigest=approval["digest"]),
                )
        finally:
            reset_request_context(other)
        self.assertEqual([], FakeGmail.sent)

    async def test_deny_needs_no_digest_and_sends_nothing(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        denied = await ops.decide_approval(owner(), finalized["approval"]["id"], ApprovalDecision(decision="rejected", note="Não agora."))
        self.assertEqual("rejected", denied["status"])
        self.assertEqual([], FakeGmail.sent)

    async def test_edit_blocked_on_exact_approval_only(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        with self.assertRaisesRegex(ValueError, "conteúdo exato"):
            await ops.edit_approval(owner(), finalized["approval"]["id"], ApprovalUpdate(title="xx", description="y"))
        self.assertEqual([], FakeGmail.sent)

    async def test_uncertain_send_reconciles_without_resending(self) -> None:
        FakeGmail.send_behavior = ("raise", FakeHttpError(500))
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("failed", decided["status"])
        self.assertTrue(decided["executionUncertain"])
        self.assertIn("Verificar envio", decided["execution"]["response"])
        ledger = await list_items("owner-mail", SEND_DB)
        self.assertEqual("unknown", ledger[0]["status"])
        FakeGmail.sent_messages = [{
            "id": "gmail-999",
            "subject": "Reuniao",
            "to": "a@x.com",
            "timestamp": int(datetime.now(timezone.utc).timestamp()),
        }]
        reconciled = await ops.reconcile_email_send(owner(), approval["id"])
        self.assertTrue(reconciled["reconciled"])
        self.assertEqual("executed", reconciled["item"]["status"])
        self.assertEqual("gmail-999", reconciled["gmailId"])
        self.assertEqual([], FakeGmail.sent)
        with self.assertRaisesRegex(ValueError, "reconciliação"):
            await ops.reconcile_email_send(owner(), approval["id"])

    async def test_reconcile_miss_keeps_uncertain_without_resending(self) -> None:
        FakeGmail.send_behavior = ("raise", FakeHttpError(503))
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        FakeGmail.sent_messages = []
        outcome = await ops.reconcile_email_send(owner(), approval["id"])
        self.assertFalse(outcome["reconciled"])
        self.assertEqual("not_found", outcome["reason"])
        items = await list_items("owner-mail", APPROVAL_DB)
        current = next(item for item in items if item["id"] == approval["id"])
        self.assertEqual("failed", current["status"])
        self.assertTrue(current["executionUncertain"])
        self.assertEqual([], FakeGmail.sent)

    async def test_definitive_send_error_fails_cleanly(self) -> None:
        for error in (GmailConfigError("bad"), FakeHttpError(400)):
            with self.subTest(error=repr(error)):
                FakeGmail.send_behavior = ("raise", error)
                agent = EmailAgent()
                ready = await self.drive_to_preview(agent)
                confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
                finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
                approval = finalized["approval"]
                decided = await ops.decide_approval(
                    owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"])
                )
                self.assertEqual("failed", decided["status"])
                self.assertFalse(decided.get("executionUncertain"))
        self.assertEqual([], FakeGmail.sent)

    async def test_disconnected_execute_refuses(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        FakeGmail.connected = False
        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("failed", decided["status"])
        self.assertIn("Nada foi enviado", decided["execution"]["response"])
        self.assertEqual([], FakeGmail.sent)

    async def test_attachments_bound_by_hash(self) -> None:
        record = nora_files.save_bytes("owner-mail", b"conteudo original", "nota.txt", "text/plain", source="test")
        agent = EmailAgent()
        result = await agent.handle(
            message="mande um e-mail para a@x.com sobre Anexo dizendo segue o arquivo",
            session_id=None,
            user_id="owner-mail",
            attachment_ids=[record["id"]],
        )
        session_id = result["session_id"]
        for text in ["pular", "pular", "pular"]:
            result = await agent.handle(message=text, session_id=session_id, user_id="owner-mail")
            session_id = result["session_id"]
        self.assertEqual("pronto_para_aprovacao", result["status"])
        self.assertEqual("nota.txt", result["preview"]["attachments"][0]["fileName"])
        confirmed = await agent.handle(message="sim", session_id=session_id, user_id="owner-mail")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("executed", decided["status"])
        self.assertEqual(1, len(FakeGmail.sent))
        data_url = FakeGmail.sent[0]["attachments"][0]["dataUrl"]
        self.assertTrue(data_url.startswith("data:text/plain;base64,"))

    async def test_tampered_attachment_blocks_send(self) -> None:
        record = nora_files.save_bytes("owner-mail", b"conteudo original", "nota.txt", "text/plain", source="test")
        agent = EmailAgent()
        result = await agent.handle(
            message="mande um e-mail para a@x.com sobre Anexo dizendo segue o arquivo",
            session_id=None,
            user_id="owner-mail",
            attachment_ids=[record["id"]],
        )
        session_id = result["session_id"]
        for text in ["pular", "pular", "pular"]:
            result = await agent.handle(message=text, session_id=session_id, user_id="owner-mail")
            session_id = result["session_id"]
        confirmed = await agent.handle(message="sim", session_id=session_id, user_id="owner-mail")
        _record, path = nora_files.owned_file("owner-mail", record["id"])
        path.write_bytes(b"conteudo adulterado!!")
        finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
        approval = finalized["approval"]
        decided = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        self.assertEqual("failed", decided["status"])
        self.assertIn("Nada foi enviado", decided["execution"]["response"])
        self.assertEqual([], FakeGmail.sent)

    async def test_no_secrets_in_payloads_or_logs(self) -> None:
        FakeGmail.send_behavior = ("raise", FakeHttpError(500))
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        confirmed = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
        with self.assertLogs("app.modules.operations.service", level="WARNING") as logs:
            finalized = await ops.finalize_email_agent_result(owner(), agent, confirmed)
            approval = finalized["approval"]
            await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
        blob = json.dumps({"approval": approval, "logs": logs.output}, ensure_ascii=False).lower()
        for marker in ("ya29", "bearer", "refresh_token", "client_secret", "api_key", "apikey"):
            self.assertNotIn(marker, blob)

    async def test_natural_email_skips_generic_gate(self) -> None:
        natural_email_gates(self)
        agent_nora = EmailAgent()
        agent_nora.nora.perguntar_nora = AsyncMock(return_value="Corpo polido pela Nora.")
        with patch.object(nora_router, "email_agent", agent_nora):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="mande um e-mail para a@x.com"),
                owner(),
            )
        self.assertEqual("email", result["intent"])
        self.assertEqual("email", result["session_kind"])
        self.assertTrue(result["session_id"])
        self.assertEqual("coletando", result["agent_result"]["status"])
        self.assertEqual([], await list_items("owner-mail", APPROVAL_DB))

    async def test_direct_endpoint_creates_approval_with_mail_surface(self) -> None:
        first = await conversar_com_agente_email(
            EmailAgentPayload(message="mande um e-mail para a@x.com sobre Oi dizendo olá mundo", session_id=None),
            owner(),
        )
        session_id = first["session_id"]
        self.assertEqual("aguardando_aprovacao", first["status"])
        self.assertNotIn("Diga 'sim'", first["response"])
        result = first
        for text in ["pular", "pular", "pular"]:
            result = await conversar_com_agente_email(EmailAgentPayload(message=text, session_id=session_id), owner())
            session_id = result["session_id"]
        self.assertEqual("aguardando_aprovacao", result["status"])
        ready = await conversar_com_agente_email(EmailAgentPayload(message="sim", session_id=session_id), owner())
        self.assertEqual("aguardando_aprovacao", ready["status"])
        self.assertIn("Central de aprovações", ready["response"])
        self.assertTrue(ready["approval"]["digest"])
        self.assertEqual(first["approval"]["id"], ready["approval"]["id"])
        self.assertEqual(1, len(await list_items("owner-mail", APPROVAL_DB)))
        self.assertEqual([], FakeGmail.sent)

    async def test_concurrent_preview_finalization_reuses_one_exact_card(self) -> None:
        agent = EmailAgent()
        ready = await agent.handle(message='Envie para a@example.test mensagem: "Confirmo a reunião."', session_id=None, user_id="owner-mail")
        results = await asyncio.gather(*(ops.finalize_email_agent_result(owner(), agent, ready) for _ in range(4)))
        self.assertEqual(1, len({item["approval"]["id"] for item in results}))
        self.assertEqual(1, len(await list_items("owner-mail", APPROVAL_DB)))
        self.assertEqual([], FakeGmail.sent)

    async def test_edit_revokes_old_card_and_binds_replacement(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        old = (await ops.finalize_email_agent_result(owner(), agent, ready))["approval"]
        edit = await agent.handle(message="editar assunto", session_id=ready["session_id"], user_id="owner-mail")
        await ops.finalize_email_agent_result(owner(), agent, edit)
        denied = await ops.decide_approval(owner(), old["id"], ApprovalDecision(decision="approved", expectedDigest=old["digest"]))
        self.assertEqual("cancelled", denied["status"])
        updated = await agent.handle(message="Novo assunto", session_id=ready["session_id"], user_id="owner-mail")
        new = (await ops.finalize_email_agent_result(owner(), agent, updated))["approval"]
        self.assertNotEqual(old["id"], new["id"])
        self.assertNotEqual(old["digest"], new["digest"])
        self.assertEqual("Novo assunto", new["payload"]["emailExact"]["subject"])
        self.assertEqual([], FakeGmail.sent)

    async def test_completed_or_uncertain_preview_never_rearms_send(self) -> None:
        for behavior, expected in [("ok", "executed"), (("raise", FakeHttpError(500)), "failed")]:
            with self.subTest(status=expected):
                agent = EmailAgent()
                ready = await self.drive_to_preview(agent)
                initial = await ops.finalize_email_agent_result(owner(), agent, ready)
                approval = initial["approval"]
                FakeGmail.send_behavior = behavior
                done = await ops.decide_approval(owner(), approval["id"], ApprovalDecision(decision="approved", expectedDigest=approval["digest"]))
                self.assertEqual(expected, done["status"])
                count = len(await list_items("owner-mail", APPROVAL_DB))
                repeat = await agent.handle(message="sim", session_id=ready["session_id"], user_id="owner-mail")
                repeated = await ops.finalize_email_agent_result(owner(), agent, repeat)
                self.assertEqual("aprovacao_concluida", repeated["status"])
                self.assertEqual(approval["id"], repeated["approval"]["id"])
                self.assertEqual(count, len(await list_items("owner-mail", APPROVAL_DB)))

    async def test_reuse_fails_closed_after_payload_tampering(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        old = (await ops.finalize_email_agent_result(owner(), agent, ready))["approval"]
        tampered = {**old["payload"], "emailExact": {**old["payload"]["emailExact"], "to": ["wrong@example.test"]}}
        await replace_item("owner-mail", APPROVAL_DB, old["id"], {"payload": tampered})
        repeated = await ops.finalize_email_agent_result(owner(), agent, ready)
        self.assertEqual("falha_validacao", repeated["status"])
        self.assertEqual(1, len(await list_items("owner-mail", APPROVAL_DB)))
        self.assertEqual([], FakeGmail.sent)

    async def test_stale_preview_cannot_be_finalized_after_edit_or_cancel(self) -> None:
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        await agent.handle(message="editar assunto", session_id=ready["session_id"], user_id="owner-mail")
        self.assertEqual("falha_validacao", (await ops.finalize_email_agent_result(owner(), agent, ready))["status"])
        agent.cancel_session(ready["session_id"], user_id="owner-mail")
        self.assertEqual("falha_validacao", (await ops.finalize_email_agent_result(owner(), agent, ready))["status"])
        self.assertEqual([], await list_items("owner-mail", APPROVAL_DB))

    async def test_negative_natural_turn_revokes_the_pending_card(self) -> None:
        natural_email_gates(self)
        agent = EmailAgent()
        ready = await self.drive_to_preview(agent)
        old = (await ops.finalize_email_agent_result(owner(), agent, ready))["approval"]
        with patch.object(nora_router, "email_agent", agent), patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Explicação sem envio.")):
            await nora_router._execute_natural_conversation(NoraNaturalPayload(message="Não envie nada; apenas explique.", email_session_id=ready["session_id"]), owner())
        current = next(item for item in await list_items("owner-mail", APPROVAL_DB) if item["id"] == old["id"])
        self.assertEqual("cancelled", current["status"])
        self.assertNotIn(ready["session_id"], agent.sessions)
        self.assertEqual([], FakeGmail.sent)

    async def test_cancellation_storage_failure_is_not_reported_as_success(self) -> None:
        with patch.object(ops, "decide_approval", AsyncMock(side_effect=OSError("synthetic storage failure"))):
            result = await ops.finalize_email_agent_result(owner(), None, {"status": "cancelado", "session_id": None, "cancelApprovalId": "approval-test", "response": "Rascunho cancelado."})
        self.assertEqual("falha_cancelamento", result["status"])
        self.assertIn("Não consegui revogar", result["response"])
        self.assertEqual([], FakeGmail.sent)


if __name__ == "__main__":
    unittest.main()
