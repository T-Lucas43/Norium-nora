from __future__ import annotations

import copy
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app.services import task_store, task_activity
from app.modules.tasks import router as tasks
from app.modules.automations import router as automations
from app.modules.nora import router as nora
from app.services import system_email as mail
from app.modules.team import router as team
from app.modules.inbox import router as inbox
from app.modules.team.nora_mentions import build_team_transcript


class TaskActivityPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.users = [dict(id=uid, teamOwnerId=tid, status="ativo", nome=uid, teamChatEnabled=True, permissions={"chat": True})
                      for uid, tid in [("owner", "owner"), ("collab", "owner"),
                                       ("denied", "owner"), ("outsider", "outsider")]]
        self.db = {"owner": {"projects": [task_store.normalize_project(
            {"id": "private", "name": "Synthetic private", "sharedUserIds": ["collab"]}, "owner")],
            "tasks": [], "columns": [], "labels": []}}
        self.chat = {"messages": []}
        self.sent = AsyncMock()
        patches = [patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name}),
                   patch.object(task_store, "_read_db", side_effect=lambda: copy.deepcopy(self.db)),
                   patch.object(task_store, "_write_db", side_effect=lambda value: self.db.update(copy.deepcopy(value))),
                   patch.object(task_activity, "read_directory", return_value={"users": self.users}),
                   patch.object(nora, "read_user_store", AsyncMock(return_value={"users": self.users})),
                   patch.object(tasks, "read_user_store", AsyncMock(return_value={"users": self.users})),
                   patch.object(team, "read_user_store", AsyncMock(return_value={"users": self.users})),
                   patch.object(team, "read_chat_store", side_effect=lambda _: copy.deepcopy(self.chat)),
                   patch.object(team, "write_chat_store", side_effect=lambda _, value: self.chat.update(copy.deepcopy(value))),
                   patch.object(team.manager, "send_to_users", self.sent),
                   patch.object(team.manager, "broadcast", AsyncMock()),
                   patch("app.modules.automations.events.publish_event", AsyncMock()),
                   patch("app.services.system_email.notify_event", AsyncMock()),
                   patch.object(tasks, "record_receipt", AsyncMock())]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.task = task_store.create_task("owner", {"projectId": "private", "title": "Synthetic secret"})

    async def test_update_and_delete_isolate_live_history_and_notifications(self):
        await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(status="andamento"), self.users[1])
        await tasks.apagar_tarefa(self.task["id"], user=self.users[0])
        self.assertEqual(2, len(self.chat["messages"]))
        self.assertEqual(2, self.sent.await_count)
        team.manager.broadcast.assert_not_awaited()
        for call in self.sent.await_args_list:
            self.assertEqual({"owner", "collab"}, call.args[1])
        for user in self.users:
            allowed = user["id"] in {"owner", "collab"}
            history = await team.list_messages(scope="team", recipientId=None, user=user)
            self.assertEqual(2 if allowed else 0, len(history["messages"]))
            events = await inbox.read_events(user["id"])
            self.assertEqual(allowed, bool(events))
        self.db["owner"]["projects"][0]["sharedUserIds"] = []
        self.assertFalse(team.message_visible(self.chat["messages"][0], "collab"))
        self.assertEqual([], await inbox.read_events("collab"))
        self.assertTrue(team.message_visible(self.chat["messages"][1], "owner"))
        self.assertEqual(3, len(await inbox.read_events("collab", include_restricted=True)))
        await inbox.record_event(source="sistema", title="Synthetic new event", metadata={"userId": "collab"})
        self.assertEqual(4, len(await inbox.read_events("collab", include_restricted=True)))
        self.db["owner"]["projects"][0]["sharedUserIds"] = ["collab"]
        self.users[1]["teamOwnerId"] = "outsider"
        self.assertFalse(team.message_visible(self.chat["messages"][0], "collab"))
        self.assertEqual(1, len(await inbox.read_events("collab")))

    async def test_creation_and_automation_activity_and_legacy_fail_closed(self):
        await tasks.record_task_created(self.task, user_id="owner")
        await team.append_team_message_for_user("owner", "Synthetic automation secret", metadata={
            "action": "automation_task_created", "taskId": self.task["id"], "projectId": "private"})
        self.assertEqual({"owner", "collab"}, self.sent.await_args.args[1])
        for uid in ("denied", "outsider"):
            self.assertEqual([], await inbox.read_events(uid))
            self.assertFalse(team.message_visible(self.chat["messages"][0], uid))
        legacy = {"scope": "team", "threadId": "team", "text": "Synthetic old secret",
                  "metadata": {"action": "task_deleted", "taskId": "gone"}}
        self.assertFalse(team.message_visible(legacy, "denied"))
        self.assertEqual("", build_team_transcript([legacy, self.chat["messages"][0]]))

    async def test_assignment_does_not_grant_access(self):
        with self.assertRaisesRegex(Exception, "acesso"):
            await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(assigneeId="denied"), self.users[0])
        self.assertEqual([], task_store.list_tasks("denied")["tasks"])

    async def test_real_automation_create_and_generic_notice_are_scoped(self):
        await automations.apply_automation_effects("owner", {"id": "synthetic-auto", "name": "Synthetic automation", "actions": ["criar tarefa", "notificar equipe"], "variables": {"taskProjectId": "private"}})
        self.assertEqual(2, len(self.chat["messages"]))
        for call in self.sent.await_args_list:
            self.assertEqual({"owner", "collab"}, call.args[1])
        self.assertEqual([], await inbox.read_events("denied"))
        self.assertEqual([], await inbox.read_events("outsider"))

    async def test_comment_and_attachment_notifications_remain_private(self):
        await tasks.comentar_tarefa(self.task["id"], tasks.ComentarioPayload(projectId="private", text="Synthetic comment"), self.users[1])
        with patch.object(tasks, "add_attachment", return_value={"id": "synthetic-att", "name": "synthetic.txt", "size": 1}):
            await tasks.anexar_arquivo(self.task["id"], tasks.AnexoPayload(projectId="private", file_name="synthetic.txt", data_url="data:text/plain;base64,QQ=="), self.users[1])
        self.assertEqual(2, len(await inbox.read_events("collab")))
        for uid in ("denied", "outsider"):
            self.assertEqual([], await inbox.read_events(uid))
        self.db["owner"]["projects"][0]["sharedUserIds"] = []
        self.assertEqual([], await inbox.read_events("collab"))

    async def test_nora_status_and_deletion_follow_project_access(self):
        response = await tasks.handle_task_agent("owner", "excluir tarefa Synthetic secret")
        self.assertEqual("excluida", response["status"])
        events = await inbox.read_events("owner")
        self.assertEqual("task_deleted_by_nora", events[0]["metadata"]["action"])
        self.assertEqual([], await inbox.read_events("denied"))
        self.task = task_store.create_task("owner", {"projectId": "private", "title": "Synthetic secret"})
        response = await nora.handle_team_agent("owner", "resumo das tarefas")
        self.assertIn("Ativas: 0", response["message"]["text"])
        self.assertNotIn("Synthetic secret", response["message"]["text"])
        self.db["owner"]["projects"][0]["sharedUserIds"] = ["collab", "denied"]
        response = await nora.handle_team_agent("owner", "resumo das tarefas")
        self.assertIn("Ativas: 1", response["message"]["text"])
        self.db["owner"]["projects"][0]["sharedUserIds"] = ["collab"]
        self.assertFalse(team.message_visible(response["message"], "denied"))
        self.assertEqual("", build_team_transcript([response["message"]]))

    async def test_denied_members_cannot_mutate_or_receive_forged_activity(self):
        for user in self.users[2:]:
            with self.assertRaises(Exception) as error:
                await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(status="concluida"), user)
            self.assertEqual(404, error.exception.status_code)
            with self.assertRaises(Exception) as error:
                await tasks.apagar_tarefa(self.task["id"], user=user)
            self.assertEqual(404, error.exception.status_code)
            with self.assertRaises(ValueError):
                await inbox.record_event(source="kanban", title="Synthetic forged", metadata={"userId": user["id"], "taskId": self.task["id"], "action": "task_updated"})
        with self.assertRaises(Exception) as error:
            await tasks.criar_tarefa(tasks.CriarTarefaPayload(projectId="private", title="Synthetic assigned", assigneeId="denied"), self.users[0])
        self.assertEqual(400, error.exception.status_code)
        await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(assigneeId="collab"), self.users[0])
        self.assertEqual(["collab"], [item["assigneeId"] for item in task_store.list_tasks("collab")["tasks"]])

    async def test_email_delivery_rechecks_project_after_revocation(self):
        event = {"id": "synthetic-email", "source": "kanban", "title": "Synthetic secret", "metadata": {"userId": "collab", "taskId": self.task["id"], "taskProject": {"ownerId": "owner", "projectId": "private"}}}
        viewer = {**self.users[1], "email": "collab@example.invalid", "emailVerifiedAt": "2026-10-06"}
        with patch.dict(os.environ, {"NORIUM_AUTH_SECRET": "test-only-synthetic-" * 3}), patch.object(mail, "ready", return_value=True), patch.object(mail, "configuration", return_value={"publicUrl": "https://synthetic.invalid"}):
            self.assertTrue(mail.queue_notification(viewer, event))
            self.db["owner"]["projects"][0]["sharedUserIds"] = []
            self.assertFalse(mail.queue_notification(viewer, {**event, "id": "synthetic-email-2"}))
            with patch("app.modules.auth.router.read_user_store", AsyncMock(return_value={"users": [viewer]})), patch.object(mail, "send_smtp") as smtp:
                self.assertTrue(await mail.deliver_one())
                smtp.assert_not_called()
            self.assertEqual("skipped", mail.read_store()["outbox"][0]["state"])

    async def test_same_project_id_in_another_owner_never_grants_access(self):
        self.db["denied"] = {"projects": [task_store.normalize_project({"id": "private", "name": "Synthetic collision"}, "denied")], "tasks": [], "columns": [], "labels": []}
        await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(priority="alta"), self.users[0])
        self.assertFalse(team.message_visible(self.chat["messages"][0], "denied"))
        self.assertEqual([], await inbox.read_events("denied"))

    async def test_transport_delivers_only_to_project_participants(self):
        sockets = {uid: AsyncMock() for uid in ("owner", "collab", "denied", "outsider")}
        presence = team.PresenceManager()
        presence.connections["owner"] = list(sockets.values())
        for uid, socket in sockets.items():
            presence.socket_user[socket] = uid
        notifications = inbox.ConnectionManager()
        notifications.active_connections = {uid: [socket] for uid, socket in sockets.items()}
        with patch.object(team, "manager", presence), patch.object(inbox, "manager", notifications):
            await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(priority="alta"), self.users[0])
            await tasks.apagar_tarefa(self.task["id"], user=self.users[0])
        for uid in ("owner", "collab"):
            types = [call.args[0]["type"] for call in sockets[uid].send_json.await_args_list]
            self.assertEqual(2, types.count("TEAM_CHAT_MESSAGE"))
            self.assertGreaterEqual(types.count("NEW_EVENT"), 2)
        for uid in ("denied", "outsider"):
            sockets[uid].send_json.assert_not_awaited()

    async def test_legacy_automation_checkpoint_never_falls_back_to_team_broadcast(self):
        automation = {"id": "synthetic-replay", "name": "Synthetic", "actions": ["criar tarefa", "notificar equipe"], "variables": {"taskProjectId": "private"}}
        checkpoint = {"task:create": {"status": "succeeded", "result": {"description": "Synthetic", "taskId": self.task["id"]}}}
        await automations.apply_automation_effects("owner", automation, checkpoints=checkpoint)
        self.assertEqual({"owner", "collab"}, self.sent.await_args.args[1])
        self.assertEqual(1, len(self.chat["messages"]))
        checkpoint["task:create"]["result"]["taskId"] = "synthetic-gone"
        with self.assertRaises(ValueError):
            await automations.apply_automation_effects("owner", automation, checkpoints=checkpoint)
        self.assertEqual(1, len(self.chat["messages"]))

    async def test_revoked_task_module_permission_hides_project_activity(self):
        await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(priority="alta"), self.users[0])
        self.users[1]["permissions"]["tarefas"] = False
        self.assertFalse(team.message_visible(self.chat["messages"][0], "collab"))
        self.assertEqual([], await inbox.read_events("collab"))
        with self.assertRaises(Exception) as error:
            await tasks.atualizar_tarefa(self.task["id"], tasks.AtualizarTarefaPayload(assigneeId="collab"), self.users[0])
        self.assertEqual(400, error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
