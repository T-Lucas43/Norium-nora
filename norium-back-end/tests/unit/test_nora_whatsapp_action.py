from __future__ import annotations

import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.modules.nora import router as nora_router
from app.modules.nora.router import NoraNaturalPayload
from app.modules.operations import service as operations_service
from app.services import nora_whatsapp_action as action_service
from app.services.nora_skills import resolve_skill
from app.services.conversation_store import (
    whatsapp_conversation_mutation_lock,
    whatsapp_conversation_mutation_locks,
)


def owner(user_id: str = "tenant-nora") -> dict:
    return {
        "id": user_id,
        "nome": "Operador",
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {
            "nora": True,
            "chat": True,
            "integracao_whatsapp": True,
        },
    }


class NoraWhatsAppParsingTests(unittest.TestCase):
    def test_extracts_common_natural_language_variants(self) -> None:
        cases = (
            (
                "Nora, mande uma mensagem no WhatsApp para Maria dizendo que chego as 18h.",
                {"recipient_query": "Maria", "message_text": "chego as 18h"},
            ),
            (
                "mande para Ana no WhatsApp dizendo que vou atrasar",
                {"recipient_query": "Ana", "message_text": "vou atrasar"},
            ),
            (
                "envie no WhatsApp para o grupo Vendas com a mensagem reuniao confirmada",
                {"recipient_query": "Vendas", "message_text": "reuniao confirmada"},
            ),
            (
                "fala pro Carlos no zap dizendo que chego em dez minutos",
                {"recipient_query": "Carlos", "message_text": "chego em dez minutos"},
            ),
            (
                "diga para Joao no WhatsApp que a reuniao comecou",
                {"recipient_query": "Joao", "message_text": "a reuniao comecou"},
            ),
            (
                'envie "Bom dia, pessoal!" para Equipe Comercial pelo WhatsApp',
                {"recipient_query": "Equipe Comercial", "message_text": "Bom dia, pessoal!"},
            ),
        )
        for message, expected in cases:
            with self.subTest(message=message):
                self.assertEqual(expected, action_service.extract_whatsapp_request(message))

    def test_team_message_does_not_regress_to_whatsapp_skill(self) -> None:
        self.assertEqual("equipe", resolve_skill("avise a equipe que a tarefa foi concluida").skill_id)
        self.assertEqual("equipe", resolve_skill("mande uma mensagem para a equipe sobre o resultado").skill_id)

    def test_explicit_whatsapp_variants_route_to_whatsapp_skill(self) -> None:
        self.assertEqual("whatsapp", resolve_skill("mande para Ana no WhatsApp dizendo que chego as 18h").skill_id)
        self.assertEqual("whatsapp", resolve_skill("fala pro Carlos no zap dizendo que vou atrasar").skill_id)


class NoraWhatsAppRecipientTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolves_recipient_only_from_tenant_records(self) -> None:
        conversations = {
            "5511999999999@c.us": {"contato": "Ana Souza", "metadados": {}},
            "120363000000@g.us": {"contato": "Equipe Comercial", "esGrupo": True, "metadados": {}},
        }
        with (
            patch.object(action_service, "load_conversations", AsyncMock(return_value=conversations)),
            patch.object(action_service, "_load_catalog", AsyncMock(return_value={})),
        ):
            result = await action_service.resolve_whatsapp_recipient("tenant-a", "Equipe Comercial")

        self.assertEqual("resolved", result["status"])
        self.assertEqual("120363000000@g.us", result["conversation_id"])
        self.assertTrue(result["is_group"])

    async def test_ambiguous_or_unknown_recipient_never_becomes_ready(self) -> None:
        conversations = {
            "5511000000001@c.us": {"contato": "Ana Paula", "metadados": {}},
            "5511000000002@c.us": {"contato": "Ana Patricia", "metadados": {}},
        }
        with (
            patch.object(action_service, "load_conversations", AsyncMock(return_value=conversations)),
            patch.object(action_service, "_load_catalog", AsyncMock(return_value={})),
        ):
            ambiguous = await action_service.prepare_whatsapp_action(
                "tenant-a", "mande para Ana P no WhatsApp dizendo que chego as 18h"
            )
            missing = await action_service.prepare_whatsapp_action(
                "tenant-a", "mande para Beatriz no WhatsApp dizendo que chego as 18h"
            )

        self.assertEqual("destinatario_ambiguo", ambiguous["status"])
        self.assertNotIn("action", ambiguous)
        self.assertEqual("destinatario_nao_encontrado", missing["status"])
        self.assertNotIn("action", missing)

    async def test_phone_and_lid_aliases_are_one_recipient_not_ambiguous(self) -> None:
        conversations = {
            "219451387551856@lid": {"contato": "Maria", "metadados": {}},
        }
        catalog = {
            "contacts": [
                {
                    "id": "5511999999999@s.whatsapp.net",
                    "savedName": "Maria",
                    "lid": "219451387551856@lid",
                    "aliases": ["5511999999999@c.us", "219451387551856@lid"],
                }
            ],
            "chats": [],
        }
        with (
            patch.object(action_service, "load_conversations", AsyncMock(return_value=conversations)),
            patch.object(action_service, "_load_catalog", AsyncMock(return_value=catalog)),
        ):
            records = await action_service.whatsapp_recipient_records("tenant-a")
            result = await action_service.resolve_whatsapp_recipient("tenant-a", "Maria")

        self.assertEqual(1, len(records))
        self.assertEqual("resolved", result["status"])
        self.assertEqual("5511999999999@s.whatsapp.net", result["conversation_id"])


class NoraWhatsAppApprovalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        whatsapp_conversation_mutation_locks.clear()
        operations_service.approval_decision_locks.clear()

    def tearDown(self) -> None:
        whatsapp_conversation_mutation_locks.clear()
        operations_service.approval_decision_locks.clear()

    async def test_general_nora_creates_exact_approval_and_does_not_send(self) -> None:
        prepared = {
            "status": "pronto_para_aprovacao",
            "action": {
                "conversationId": "5511999999999@c.us",
                "recipientName": "Ana Souza",
                "isGroup": False,
                "messageText": "Chego as 18h",
            },
        }
        create = AsyncMock(return_value={"id": "approval-1", "status": "pending"})
        with (
            patch.dict(os.environ, {"NORA_INTENT_LLM": "0"}),
            patch.object(nora_router, "prepare_whatsapp_action", AsyncMock(return_value=prepared)),
            patch.object(nora_router, "create_approval", create),
            patch.object(
                nora_router.wb,
                "get_binding",
                return_value=SimpleNamespace(exists=True, state="connected", instance_id="INST-NORA"),
            ),
            patch.object(nora_router.agent_manager, "execute_message", AsyncMock()) as send,
        ):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="mande para Ana no WhatsApp dizendo que chego as 18h"),
                owner(),
            )

        self.assertEqual("whatsapp", result["intent"])
        self.assertEqual("aguardando_aprovacao", result["status"])
        self.assertEqual("Chego as 18h", result["agent_result"]["preview"]["messageText"])
        send.assert_not_awaited()
        approval_payload = create.await_args.args[1]
        self.assertEqual("nora_whatsapp_execute", approval_payload.action)
        self.assertEqual("5511999999999@c.us", approval_payload.payload["conversationId"])
        self.assertEqual("Chego as 18h", approval_payload.payload["messageText"])
        self.assertEqual("Chego as 18h", approval_payload.description)
        self.assertEqual("INST-NORA", approval_payload.payload["instanceId"])

    async def test_generic_person_message_uses_whatsapp_but_team_stays_internal(self) -> None:
        prepared = {
            "status": "pronto_para_aprovacao",
            "action": {
                "conversationId": "5511888888888@c.us",
                "recipientName": "Carlos",
                "isGroup": False,
                "messageText": "Oi",
            },
        }
        with (
            patch.dict(os.environ, {"NORA_INTENT_LLM": "0"}),
            patch.object(nora_router, "prepare_whatsapp_action", AsyncMock(return_value=prepared)),
            patch.object(nora_router, "create_approval", AsyncMock(return_value={"id": "approval-2"})),
            patch.object(
                nora_router.wb,
                "get_binding",
                return_value=SimpleNamespace(exists=True, state="connected", instance_id="INST-NORA"),
            ),
        ):
            direct = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="mande uma mensagem para Carlos dizendo oi"),
                owner(),
            )

        self.assertEqual("whatsapp", direct["intent"])

    async def test_approved_executor_uses_authenticated_tenant(self) -> None:
        send = AsyncMock(return_value={"agent_id": "mensagens", "status": "enviado", "sent": True})
        receipt = AsyncMock(return_value={"id": "receipt-1"})
        approval = {
            "id": "approval-1",
            "title": "Enviar mensagem no WhatsApp para Ana",
            "description": "Revisao",
            "action": "nora_whatsapp_execute",
            "source": "whatsapp",
            "payload": {
                "originalMessage": "mande para Ana no WhatsApp dizendo que chego as 18h",
                "conversationId": "5511999999999@c.us",
                "recipientName": "Ana",
                "messageText": "Chego as 18h",
                "instanceId": "INST-REAL",
            },
        }
        with (
            patch("app.services.agent_manager.AgentManager.execute_message", send),
            patch(
                "app.services.wapi_binding.get_binding",
                return_value=SimpleNamespace(
                    exists=True, state="connected", instance_id="INST-REAL"
                ),
            ),
            patch.object(operations_service, "record_receipt", receipt),
        ):
            result = await operations_service.execute_approved_action(owner("tenant-real"), approval)

        self.assertTrue(result["ok"])
        self.assertEqual("tenant-real", send.await_args.kwargs["user_id"])
        self.assertTrue(send.await_args.kwargs["autorizado"])
        self.assertIsNone(send.await_args.kwargs["sender_label"])
        self.assertEqual("5511999999999@c.us", send.await_args.args[0])
        self.assertEqual("Chego as 18h", send.await_args.args[1])

    async def test_executor_rechecks_permission_before_send(self) -> None:
        blocked_user = owner("tenant-blocked")
        blocked_user["role"] = "member"
        blocked_user["permissions"]["chat"] = False
        send = AsyncMock()
        approval = {
            "id": "approval-2",
            "title": "Enviar WhatsApp",
            "action": "nora_whatsapp_execute",
            "source": "whatsapp",
            "payload": {
                "originalMessage": "mande para Ana no WhatsApp dizendo oi",
                "conversationId": "5511999999999@c.us",
                "recipientName": "Ana",
                "messageText": "Oi",
                "instanceId": "INST-BLOCKED",
            },
        }
        with (
            patch("app.services.agent_manager.AgentManager.execute_message", send),
            patch.object(operations_service, "record_receipt", AsyncMock(return_value={"id": "receipt-2"})),
        ):
            result = await operations_service.execute_approved_action(blocked_user, approval)

        self.assertFalse(result["ok"])
        self.assertIn("permissao", result["error"])
        send.assert_not_awaited()

    async def test_message_agent_keeps_approved_text_exact_in_local_history(self) -> None:
        from app.services.agent_manager import AgentManager

        manager = AgentManager()
        manager.wapi_messaging.send_text = AsyncMock(
            return_value={"sent": True, "messageId": "wapi-message-1"}
        )
        append = AsyncMock(return_value={"id": "wapi-message-1"})
        with patch("app.services.agent_manager.append_outgoing_message", append):
            result = await manager.execute_message(
                "5511999999999@c.us",
                "Texto revisado",
                canal="whatsapp",
                autorizado=True,
                sender_label=None,
                user_id="tenant-exact",
            )

        self.assertTrue(result["sent"])
        self.assertEqual("Texto revisado", append.await_args.args[1])
        self.assertIsNone(append.await_args.kwargs["sender_label"])
        self.assertEqual("tenant-exact", append.await_args.kwargs["user_id"])

    async def test_editing_whatsapp_approval_updates_only_message_payload(self) -> None:
        from app.modules.operations.schemas import ApprovalUpdate

        current = {
            "id": "approval-edit",
            "status": "pending",
            "source": "whatsapp",
            "action": "nora_whatsapp_execute",
            "title": "Enviar mensagem no WhatsApp para Ana",
            "description": "Texto original",
            "payload": {
                "originalMessage": "mande para Ana dizendo texto original",
                "conversationId": "5511999999999@c.us",
                "recipientName": "Ana",
                "messageText": "Texto original",
                "instanceId": "INST-EDIT",
            },
        }

        async def replace(_user_id, _db, _approval_id, update):
            return {**current, **update}

        with (
            patch.object(operations_service, "list_items", AsyncMock(return_value=[current])),
            patch.object(operations_service, "replace_item", AsyncMock(side_effect=replace)),
            patch.object(operations_service, "record_audit", AsyncMock()),
        ):
            edited = await operations_service.edit_approval(
                owner("tenant-edit"),
                "approval-edit",
                ApprovalUpdate(
                    title="Enviar mensagem no WhatsApp para outra pessoa",
                    description="Texto revisado pelo operador",
                ),
            )

        self.assertIsNotNone(edited)
        self.assertEqual("Texto revisado pelo operador", edited["payload"]["messageText"])
        self.assertEqual("5511999999999@c.us", edited["payload"]["conversationId"])
        self.assertEqual("Ana", edited["payload"]["recipientName"])
        self.assertEqual("Enviar mensagem no WhatsApp para Ana", edited["title"])

        send = AsyncMock(return_value={"status": "enviado", "sent": True})
        with (
            patch("app.services.agent_manager.AgentManager.execute_message", send),
            patch(
                "app.services.wapi_binding.get_binding",
                return_value=SimpleNamespace(
                    exists=True, state="connected", instance_id="INST-EDIT"
                ),
            ),
            patch.object(operations_service, "record_receipt", AsyncMock(return_value={"id": "receipt-edit"})),
        ):
            result = await operations_service.execute_approved_action(owner("tenant-edit"), edited)

        self.assertTrue(result["ok"])
        self.assertEqual("5511999999999@c.us", send.await_args.args[0])
        self.assertEqual("Texto revisado pelo operador", send.await_args.args[1])

    async def test_message_agent_append_waits_for_shared_conversation_lock(self) -> None:
        from app.services.agent_manager import AgentManager

        manager = AgentManager()
        manager.wapi_messaging.send_text = AsyncMock(
            return_value={"sent": True, "messageId": "wapi-locked"}
        )
        append = AsyncMock(return_value={"id": "wapi-locked"})
        lock = whatsapp_conversation_mutation_lock("tenant-lock")
        await lock.acquire()
        try:
            with patch("app.services.agent_manager.append_outgoing_message", append):
                task = asyncio.create_task(
                    manager.execute_message(
                        "5511999999999@c.us",
                        "Texto concorrente",
                        autorizado=True,
                        sender_label=None,
                        user_id="tenant-lock",
                    )
                )
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                append.assert_not_awaited()
                lock.release()
                result = await task
        finally:
            if lock.locked():
                lock.release()

        self.assertTrue(result["sent"])
        append.assert_awaited_once()

    async def test_chat_whatsapp_never_sends_before_explicit_approval(self) -> None:
        create = AsyncMock(return_value={"id": "approval-chat", "status": "pending"})
        direct_send = AsyncMock()
        with (
            patch.object(nora_router, "buscar_historico_whats", AsyncMock(return_value="Contato: Oi")),
            patch.object(
                nora_router,
                "resolve_whatsapp_recipient",
                AsyncMock(
                    return_value={
                        "status": "resolved",
                        "conversation_id": "5511999999999@c.us",
                        "display_name": "Ana",
                        "is_group": False,
                    }
                ),
            ),
            patch.object(nora_router, "gerar_texto_de_envio_whatsapp", AsyncMock(return_value="Texto final revisavel")),
            patch.object(nora_router, "create_approval", create),
            patch.object(
                nora_router.wb,
                "get_binding",
                return_value=SimpleNamespace(exists=True, state="connected", instance_id="INST-CHAT"),
            ),
            patch.object(nora_router.wapi_messaging, "send_text", direct_send),
        ):
            result = await nora_router.conversar_nora_whatsapp(
                nora_router.NoraWhatsAppPayload(
                    conversa_id="5511999999999@c.us",
                    texto_usuario="responda dizendo texto final",
                    enviar_direto_whatsapp=True,
                ),
                owner("tenant-chat"),
            )

        self.assertEqual("aguardando_aprovacao", result["status"])
        self.assertFalse(result["whatsapp_enviado"])
        direct_send.assert_not_awaited()
        approval = create.await_args.args[1]
        self.assertEqual("Texto final revisavel", approval.description)
        self.assertEqual("5511999999999@c.us", approval.payload["conversationId"])
        self.assertEqual("INST-CHAT", approval.payload["instanceId"])

    async def test_executor_rejects_changed_whatsapp_binding(self) -> None:
        send = AsyncMock()
        approval = {
            "id": "approval-binding",
            "title": "Enviar mensagem no WhatsApp para Ana",
            "description": "Oi",
            "action": "nora_whatsapp_execute",
            "source": "whatsapp",
            "payload": {
                "originalMessage": "mande oi",
                "conversationId": "5511999999999@c.us",
                "recipientName": "Ana",
                "messageText": "Oi",
                "instanceId": "INST-OLD",
            },
        }
        with (
            patch("app.services.agent_manager.AgentManager.execute_message", send),
            patch(
                "app.services.wapi_binding.get_binding",
                return_value=SimpleNamespace(exists=True, state="connected", instance_id="INST-NEW"),
            ),
            patch.object(operations_service, "record_receipt", AsyncMock(return_value={"id": "receipt-binding"})),
        ):
            result = await operations_service.execute_approved_action(owner("tenant-binding"), approval)

        self.assertFalse(result["ok"])
        self.assertIn("mudou", result["error"])
        send.assert_not_awaited()

    async def test_approval_retry_executes_exactly_once_and_preserves_executed(self) -> None:
        from app.modules.operations.schemas import ApprovalDecision

        state = {
            "id": "approval-once",
            "status": "pending",
            "source": "whatsapp",
            "action": "nora_whatsapp_execute",
            "title": "Enviar WhatsApp",
            "payload": {},
        }

        async def list_current(*_args):
            return [dict(state)]

        async def replace(*args):
            state.update(args[3])
            return dict(state)

        execute = AsyncMock(return_value={"ok": True, "result": {"status": "enviado"}})
        decision = ApprovalDecision(decision="approved")
        with (
            patch.object(operations_service, "list_items", AsyncMock(side_effect=list_current)),
            patch.object(operations_service, "replace_item", AsyncMock(side_effect=replace)),
            patch.object(operations_service, "record_audit", AsyncMock()),
            patch.object(operations_service, "record_event", AsyncMock()),
            patch.object(operations_service, "execute_approved_action", execute),
        ):
            first = await operations_service.decide_approval(owner("tenant-once"), "approval-once", decision)
            second = await operations_service.decide_approval(owner("tenant-once"), "approval-once", decision)

        execute.assert_awaited_once()
        self.assertEqual("executed", state["status"])
        self.assertEqual("executed", first["status"])
        self.assertEqual("executed", second["status"])

    async def test_concurrent_approval_requests_execute_exactly_once(self) -> None:
        from app.modules.operations.schemas import ApprovalDecision

        state = {
            "id": "approval-concurrent",
            "status": "pending",
            "source": "whatsapp",
            "action": "nora_whatsapp_execute",
            "title": "Enviar WhatsApp",
            "payload": {},
        }

        async def list_current(*_args):
            return [dict(state)]

        async def replace(*args):
            state.update(args[3])
            return dict(state)

        async def execute_once(*_args):
            await asyncio.sleep(0.02)
            return {"ok": True, "result": {"status": "enviado"}}

        execute = AsyncMock(side_effect=execute_once)
        decision = ApprovalDecision(decision="approved")
        with (
            patch.object(operations_service, "list_items", AsyncMock(side_effect=list_current)),
            patch.object(operations_service, "replace_item", AsyncMock(side_effect=replace)),
            patch.object(operations_service, "record_audit", AsyncMock()),
            patch.object(operations_service, "record_event", AsyncMock()),
            patch.object(operations_service, "execute_approved_action", execute),
        ):
            results = await asyncio.gather(
                operations_service.decide_approval(owner("tenant-concurrent"), "approval-concurrent", decision),
                operations_service.decide_approval(owner("tenant-concurrent"), "approval-concurrent", decision),
            )

        execute.assert_awaited_once()
        self.assertEqual("executed", state["status"])
        self.assertTrue(all(result["status"] == "executed" for result in results))

    async def test_compound_with_whatsapp_is_blocked_before_approval_or_execution(self) -> None:
        create = AsyncMock()
        with (
            patch.dict(os.environ, {"NORA_INTENT_LLM": "0"}),
            patch.object(nora_router, "create_approval", create),
        ):
            response = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(
                    message="envie no WhatsApp para Ana dizendo oi e depois crie uma tarefa de retorno"
                ),
                owner("tenant-compound"),
            )

        self.assertEqual("requer_aprovacao_individual", response["status"])
        create.assert_not_awaited()

        legacy = {
            "id": "legacy-compound",
            "title": "Plano legado",
            "action": "nora_compound_execute",
            "source": "compound",
            "payload": {
                "originalMessage": "envie WhatsApp e crie tarefa",
                "steps": [
                    {"agent": "whatsapp", "instruction": "envie oi para Ana"},
                    {"agent": "tarefas", "instruction": "crie uma tarefa"},
                ],
            },
        }
        execute_plan = AsyncMock()
        with (
            patch("app.modules.nora.orchestrator.execute_compound_plan", execute_plan),
            patch.object(operations_service, "record_receipt", AsyncMock(return_value={"id": "receipt-compound"})),
        ):
            result = await operations_service.execute_approved_action(owner("tenant-compound"), legacy)

        self.assertFalse(result["ok"])
        self.assertIn("aprovacao individual", result["error"])
        execute_plan.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
