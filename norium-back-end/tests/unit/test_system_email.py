from __future__ import annotations

import json
import os
import smtplib
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from app.modules.auth import email_router as routes
from app.modules.auth import router as auth
from app.services import system_email as mail
from app.core.security import verify_password


class SystemEmailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "NORIUM_AUTH_SECRET": "test-only-email-secret-" * 3, "NORIUM_SMTP_PASSWORD": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.user = {"id": "alice", "email": "alice@example.invalid", "nome": "Alice <Equipe>", "status": "ativo", "sessionVersion": 2, "emailVerifiedAt": "2026-09-05"}
        self.other = {**self.user, "id": "bob", "email": "bob@example.invalid"}
        mail.save_configuration("fake-smtp-password", True, "https://norium.example.invalid")
        read = patch.object(auth, "read_user_store", new=AsyncMock(return_value={"users": [self.user, self.other]}))
        read.start()
        self.addCleanup(read.stop)
        write = patch.object(auth, "write_user_store", new=AsyncMock())
        self.write = write.start()
        self.addCleanup(write.stop)

    def event(self, source="kanban", user_id="alice", event_id="task-1"):
        return {"id": event_id, "source": source, "title": "Nova tarefa", "description": "private body", "metadata": {"userId": user_id}}

    def update_store(self, callback):
        with mail.store_lock:
            store = mail.read_store()
            callback(store)
            mail.write_store(store)

    def token(self, purpose="reset"):
        self.assertTrue(mail.issue_action(self.user, purpose))
        row = next(job for job in reversed(mail.read_store()["outbox"]) if job["kind"] == purpose)
        payload = json.loads(mail.cipher().decrypt(row["payload"].encode()))
        token = payload["text"].split(f'/app#/{"redefinir-senha" if purpose == "reset" else "confirmar-email"}/')[1].split()[0]
        return token, row

    async def test_config_and_queue_never_return_or_store_plain_secrets(self):
        token, row = self.token()
        config = mail.configuration()
        self.assertNotIn("fake-smtp-password", json.dumps(config))
        self.assertNotIn("passwordEncrypted", mail.configuration_status())
        self.assertNotIn(token, row["payload"])
        raw = (Path(self.directory.name) / "system_email_db.json").read_bytes()
        self.assertNotIn(token.encode(), raw)
        self.assertNotIn(b"fake-smtp-password", raw)
        self.assertEqual("fake-smtp-password", mail.cipher().decrypt(config["passwordEncrypted"].encode()).decode())

    async def test_invalid_migrated_credential_blocks_false_success_and_can_be_reconfigured(self):
        config = mail.configuration()
        config["passwordEncrypted"] = "encrypted-with-another-key"
        mail.write_json_file(mail.get_system_db_path("system_email_config"), config)
        self.assertFalse(mail.ready())
        self.assertEqual("invalid", mail.configuration_status()["credentialStatus"])

        app = FastAPI()
        app.include_router(routes.router)
        with patch.object(routes.limiter, "check", new=AsyncMock()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/auth/forgot-password", json={"email": self.user["email"]})
        self.assertEqual(503, response.status_code)
        self.assertIn("Nenhum e-mail foi enviado", response.json()["detail"])
        self.assertEqual([], mail.read_store()["tokens"])

        self.assertTrue(mail.save_configuration("replacement-password", True, "https://norium.example.invalid")["ready"])
        self.assertEqual("ok", mail.configuration_status()["credentialStatus"])

    async def test_reconfigured_credential_releases_unexpired_pending_jobs(self):
        self.assertTrue(mail.issue_action(self.user, "reset"))
        self.update_store(lambda store: [job.update(state="pending", attempts=3, next_attempt=time.time() + 3600, error="delivery") for job in store["outbox"]])
        mail.save_configuration("replacement-password", True, "https://norium.example.invalid")
        row = mail.read_store()["outbox"][0]
        self.assertEqual("pending", row["state"])
        self.assertEqual(0, row["attempts"])
        self.assertEqual(0, row["next_attempt"])
        self.assertIsNone(row["error"])

    async def test_tokens_expire_and_reject_wrong_purpose_and_replay(self):
        token, _ = self.token()
        self.assertIsNone(mail.consume_action(token, "verify"))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: mail.consume_action(token, "reset"), range(2)))
        self.assertEqual(1, sum(item is not None for item in results))
        verify_token, _ = self.token("verify")
        self.update_store(lambda store: [item.update(expires=time.time() - 1) for item in store["tokens"]])
        self.assertIsNone(mail.consume_action(verify_token, "verify"))

    async def test_reset_revokes_sessions_only_for_token_owner(self):
        token, _ = self.token()
        await routes.apply_token(token, "reset", "new-long-password")
        self.assertEqual(3, self.user["sessionVersion"])
        self.assertTrue(verify_password("new-long-password", self.user["passwordHash"]))
        self.assertEqual(2, self.other["sessionVersion"])
        self.assertNotIn("passwordHash", self.other)
        self.write.assert_awaited_once()
        with self.assertRaises(HTTPException):
            await routes.apply_token(token, "reset", "another-password")

    async def test_reset_rejects_changed_email_session_or_disabled_user(self):
        for attribute, value in [("email", "new@example.invalid"), ("sessionVersion", 3), ("status", "inativo")]:
            with self.subTest(attribute=attribute):
                self.update_store(lambda store: store.update(tokens=[]))
                original = self.user[attribute]
                token, _ = self.token()
                self.user[attribute] = value
                with self.assertRaises(HTTPException):
                    await routes.apply_token(token, "reset", "new-long-password")
                self.user[attribute] = original
        self.write.assert_not_awaited()

    async def test_verification_only_changes_owner(self):
        self.user.pop("emailVerifiedAt")
        token, _ = self.token("verify")
        await routes.apply_token(token, "verify")
        self.assertIn("emailVerifiedAt", self.user)
        self.assertEqual(2, self.user["sessionVersion"])
        self.assertEqual("2026-09-05", self.other["emailVerifiedAt"])

    async def test_notification_exclusions_isolation_preferences_and_duplicates(self):
        for source in ("whatsapp", "gmail", "unknown"):
            self.assertFalse(mail.queue_notification(self.user, self.event(source)))
        self.assertFalse(mail.queue_notification(self.user, self.event(user_id="bob")))
        self.assertFalse(mail.queue_notification({**self.user, "emailVerifiedAt": None}, self.event()))
        self.assertFalse(mail.queue_notification({**self.user, "emailNotifications": {"enabled": False}}, self.event()))
        self.assertFalse(mail.queue_notification({**self.user, "emailNotifications": {"sources": {"kanban": False}}}, self.event()))
        categorized = {
            **self.event(event_id="task-due-category"),
            "metadata": {"userId": "alice", "emailCategory": "task_due"},
        }
        self.assertFalse(
            mail.queue_notification(
                {**self.user, "emailNotifications": {"events": {"task_due": False}}},
                categorized,
            )
        )
        self.assertTrue(mail.queue_notification(self.user, categorized))
        categorized_job = next(job for job in mail.read_store()["outbox"] if job["id"] != "")
        self.assertIn(categorized_job["kind"], {"event:task_due", "kanban"})
        client_shared = {
            **self.event(event_id="client-shared-category", source="clientes"),
            "metadata": {"userId": "alice", "emailCategory": "client_shared"},
        }
        self.assertTrue(mail.queue_notification(self.user, client_shared))
        self.assertTrue(mail.queue_notification(self.user, self.event(), "primary"))
        self.assertFalse(mail.queue_notification(self.user, self.event(), "primary"))
        self.assertTrue(mail.queue_notification(self.user, self.event(), "workspace-2"))
        job = mail.claim_delivery()
        self.assertEqual(self.user["email"], job["recipient"])
        self.assertNotIn("private body", mail.cipher().decrypt(job["payload"].encode()).decode())

    async def test_smtp_tls_single_envelope_recipient_and_html_escaping(self):
        mail.queue_welcome([self.user, self.other])
        job = mail.claim_delivery()
        with patch.object(smtplib, "SMTP_SSL") as smtp:
            mail.send_smtp(job)
        self.assertEqual(("smtp.hostinger.com", 465), smtp.call_args.args)
        self.assertTrue(smtp.call_args.kwargs["context"].check_hostname)
        session = smtp.return_value.__enter__.return_value
        session.login.assert_called_once_with(mail.SENDER, "fake-smtp-password")
        sent = session.send_message.call_args
        self.assertEqual([job["recipient"]], sent.kwargs["to_addrs"])
        message = sent.args[0]
        self.assertIsNone(message["Cc"])
        self.assertIsNone(message["Bcc"])
        self.assertIsNotNone(message["Date"])
        self.assertIn("Alice &lt;Equipe&gt;", message.get_body(preferencelist=("html",)).get_content())
        self.assertIn("Assistente virtual", message.get_body(preferencelist=("html",)).get_content())
        self.assertIn("Assistente virtual do Norium", message.get_body(preferencelist=("plain",)).get_content())
        self.assertIn('alt="Nora"', message.get_body(preferencelist=("html",)).get_content())
        self.assertIn('data-brand-asset="nora-brand.png"', message.get_body(preferencelist=("html",)).get_content())
        self.assertIn('alt="Norium"', message.get_body(preferencelist=("html",)).get_content())
        self.assertIn("data:image/jpeg;base64,", message.get_body(preferencelist=("html",)).get_content())

    async def test_welcome_campaign_dedupes_per_email_across_retries(self):
        users = [self.user, self.other, {**self.user, "id": "duplicate"}, {**self.other, "id": "inactive", "status": "inativo"}]
        self.assertEqual({"queued": 2, "alreadyQueued": 1, "skipped": 1}, mail.queue_welcome(users))
        self.assertEqual(0, mail.queue_welcome(users)["queued"])
        self.update_store(lambda store: store.update(outbox=[]))
        self.assertEqual(0, mail.queue_welcome(users)["queued"])

    async def test_delivery_checks_current_recipient_and_preference_before_sending(self):
        mail.queue_notification(self.user, self.event())
        self.user["emailNotifications"] = {"enabled": False}
        with patch.object(mail, "send_smtp") as smtp:
            self.assertTrue(await mail.deliver_one())
        smtp.assert_not_called()
        self.assertEqual(1, mail.delivery_status()["counts"]["skipped"])

    async def test_delivery_lease_failure_retry_and_status(self):
        mail.queue_welcome([self.user])
        with patch.object(mail, "send_smtp", side_effect=smtplib.SMTPAuthenticationError(535, b"secret-error")):
            self.assertTrue(await mail.deliver_one())
        status = mail.delivery_status()
        self.assertEqual(1, status["counts"]["pending"])
        self.assertEqual("authentication", status["recent"][0]["error"])
        self.assertNotIn("secret-error", json.dumps(status))
        self.assertIsNone(mail.claim_delivery())
        self.update_store(lambda store: [job.update(next_attempt=0) for job in store["outbox"]])
        with ThreadPoolExecutor(max_workers=2) as pool:
            claimed = list(pool.map(lambda _: mail.claim_delivery(), range(2)))
        self.assertEqual(1, sum(job is not None for job in claimed))

    async def test_api_requires_admin_and_never_accepts_arbitrary_recipients(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[auth.current_user] = lambda: self.user
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            for method, path in [("GET", ""), ("POST", "/welcome"), ("POST", "/test")]:
                response = await client.request(method, "/api/auth/admin/system-email" + path)
                self.assertEqual(403, response.status_code)
            response = await client.post(
                "/api/auth/admin/system-email/draft",
                json={"context": "Contexto suficiente para validar a autorização.", "tone": "profissional"},
            )
            self.assertEqual(403, response.status_code)
            response = await client.patch("/api/auth/email-preferences", json={"enabled": True, "sources": {"gmail": True}})
            self.assertEqual(422, response.status_code)
            response = await client.get("/api/auth/email-preferences")
            self.assertEqual(self.user["email"], response.json()["email"])

    async def test_ai_draft_is_admin_only_and_does_not_enqueue_or_send(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.require_admin] = lambda: self.user
        generated = '{"subject":"Atualização importante","message":"Temos uma novidade.\\n\\nConsulte os detalhes no Norium."}'
        completion = AsyncMock(return_value=(generated, {"provider": {"name": "Google Gemini"}}))
        with patch("app.modules.intelligence.service.complete_with_provider", completion):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/auth/admin/system-email/draft", json={"context": "Avise sobre o novo recurso disponível.", "tone": "cordial"})
        self.assertEqual(200, response.status_code)
        self.assertEqual("Atualização importante", response.json()["subject"])
        self.assertIn("Consulte os detalhes", response.json()["message"])
        self.assertEqual("Google Gemini", response.json()["provider"])
        self.assertEqual([], mail.read_store()["outbox"])
        args = completion.await_args.args
        self.assertIs(args[0], self.user)
        self.assertEqual("auto", args[1])
        self.assertIn('"tone": "cordial"', args[2][0]["content"])

    async def test_ai_draft_rejects_malformed_model_output_and_extra_input(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.require_admin] = lambda: self.user
        completion = AsyncMock(return_value=("Não consegui gerar.", {"provider": {"name": "Nora"}}))
        with patch("app.modules.intelligence.service.complete_with_provider", completion):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                malformed = await client.post("/api/auth/admin/system-email/draft", json={"context": "Contexto suficiente para o teste.", "tone": "profissional"})
                extra = await client.post("/api/auth/admin/system-email/draft", json={"context": "Contexto suficiente para o teste.", "tone": "profissional", "recipientIds": ["bob"]})
        self.assertEqual(502, malformed.status_code)
        self.assertEqual(422, extra.status_code)
        self.assertEqual([], mail.read_store()["outbox"])

    async def test_forgot_password_response_does_not_enumerate_accounts(self):
        app = FastAPI()
        app.include_router(routes.router)
        with patch.object(routes.limiter, "check", new=AsyncMock()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                known = await client.post("/api/auth/forgot-password", json={"email": self.user["email"]})
                unknown = await client.post("/api/auth/forgot-password", json={"email": "missing@example.invalid"})
        self.assertEqual(200, known.status_code)
        self.assertEqual(known.json(), unknown.json())
        self.assertEqual(1, len(mail.read_store()["tokens"]))

    async def test_unconfigured_delivery_stays_disabled(self):
        mail.save_configuration("", False, "https://norium.example.invalid")
        self.assertFalse(await mail.deliver_one())
        with self.assertRaises(ValueError):
            mail.queue_welcome([self.user])
        with self.assertRaises(ValueError):
            mail.save_configuration("", True, "http://unsafe.example.invalid")

    async def test_team_notifications_only_reach_resolved_participants(self):
        await mail.notify_team_participants({"bob"}, "direct-1", "Nova mensagem")
        await mail.notify_event({**self.event("equipe"), "metadata": {"userId": "alice", "action": "team_message_created"}}, "primary")
        self.assertEqual(["bob"], [job["user_id"] for job in mail.read_store()["outbox"]])

    async def test_private_team_event_does_not_copy_content_to_nonparticipant_owner(self):
        from app.modules.team import router as team
        with patch.object(team, "record_event", new=AsyncMock()) as record:
            await team.record_team_event("owner-outside-conversation", "Mensagem direta", "Conteúdo privado", {"userId": "wrong-owner"}, user_ids={"alice", "bob"})
        self.assertEqual({"alice", "bob"}, {call.kwargs["metadata"]["userId"] for call in record.await_args_list})

    async def test_due_reminders_use_own_workspace_and_do_not_repeat(self):
        from datetime import datetime, timezone
        from app.services import system_email_reminders as reminders
        from app.core.tenant import write_json_file, get_user_db_path
        from app.core.request_context import set_request_context, reset_request_context
        now = datetime(2026, 9, 5, 13, 0, tzinfo=timezone.utc)
        ctx = set_request_context("test-reminder", "workspace-2")
        try:
            write_json_file(get_user_db_path("alice", "tarefas"), {"tasks": [{"id": "due", "dueDate": "2026-09-05", "status": "pendente"}, {"id": "done", "dueDate": "2026-09-05", "status": "concluida"}]})
            write_json_file(get_user_db_path("alice", "perfil"), {"calendarLocalEvents": [{"id": "meeting", "inicio": "2026-09-05T13:05:00Z"}]})
            write_json_file(get_user_db_path("alice", "financeiro"), {"lancamentos": [{"id": "invoice", "type": "saida", "status": "pendente", "dueDate": "2026-09-06"}], "programados": [], "boletos": []})
            write_json_file(get_user_db_path("alice", "clientes"), [{"id": "client-follow-up", "name": "Cliente", "nextActionAt": "2026-09-05T13:30:00Z"}])
        finally:
            reset_request_context(ctx)
        self.assertEqual(0, reminders.queue_due(self.other, "workspace-2", now))
        self.assertEqual(0, reminders.queue_due(self.user, "primary", now))
        self.assertEqual(4, reminders.queue_due(self.user, "workspace-2", now))
        self.assertEqual(0, reminders.queue_due(self.user, "workspace-2", now))

    async def test_manual_email_uses_registered_recipients_and_dispatch_deduplication(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.require_admin] = lambda: self.user
        payload = {"recipientIds": ["bob"], "subject": "Atualização", "message": "Primeiro parágrafo.\n\nSegundo parágrafo.", "dispatchId": "manual-dispatch-test-1"}
        with patch.object(routes.limiter, "check", new=AsyncMock()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                first = await client.post("/api/auth/admin/system-email/send", json=payload)
                again = await client.post("/api/auth/admin/system-email/send", json=payload)
                unknown = await client.post("/api/auth/admin/system-email/send", json={**payload, "recipientIds": ["missing"]})
                arbitrary = await client.post("/api/auth/admin/system-email/send", json={**payload, "email": "external@example.invalid"})
        self.assertEqual(1, first.json()["queued"])
        self.assertEqual(0, again.json()["queued"])
        self.assertEqual(422, unknown.status_code)
        self.assertEqual(422, arbitrary.status_code)
        job = mail.claim_delivery()
        self.assertEqual("bob@example.invalid", job["recipient"])
        self.assertEqual("manual", job["kind"])
        self.assertIn("white-space:pre-wrap", json.loads(mail.cipher().decrypt(job["payload"].encode()))["html"])

    async def test_admin_status_survives_unavailable_queue_without_exposing_password(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.require_admin] = lambda: self.user
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            status = await client.get("/api/auth/admin/system-email")
            self.assertEqual(200, status.status_code)
            self.assertTrue(status.json()["ready"])
            self.assertTrue(status.json()["passwordConfigured"])
            self.assertNotIn("passwordEncrypted", status.text)
            with patch.object(mail, "read_store", side_effect=OSError("do not expose raw storage errors")):
                unavailable = await client.get("/api/auth/admin/system-email")
            self.assertEqual(200, unavailable.status_code)
            self.assertFalse(unavailable.json()["ready"])
            self.assertFalse(unavailable.json()["delivery"]["available"])
            self.assertNotIn("do not expose", unavailable.text)
