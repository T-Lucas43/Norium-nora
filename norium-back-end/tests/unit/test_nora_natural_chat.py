import unittest
from unittest.mock import AsyncMock, patch

from app.modules.nora import router as nora_router
from app.modules.nora.router import NoraNaturalPayload


def owner() -> dict[str, object]:
    return {
        "id": "owner",
        "nome": "Tarcisio",
        "role": "owner",
        "permissions": {"nora": True},
    }


class NoraNaturalChatTests(unittest.IsolatedAsyncioTestCase):
    async def test_negative_choice_does_not_route_to_a_specialist_writer(self) -> None:
        text = "Prefiro uma única dica de organização, sem criar tarefas."
        with (
            patch.object(nora_router, "handle_task_agent", AsyncMock()) as tasks,
            patch.object(nora_router, "classificar_intencao_com_nora", AsyncMock(return_value=("tarefas", 1))) as classify,
            patch.object(nora_router, "resolve_read_query", return_value=None),
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Escolha uma prioridade.")) as provider,
        ):
            result = await nora_router.conversar_com_nora_natural(NoraNaturalPayload(message=text), owner())
        self.assertEqual("chat", result["intent"])
        self.assertTrue(result["agent_result"]["changesBlocked"])
        tasks.assert_not_awaited()
        classify.assert_not_awaited()
        provider.assert_awaited_once()

    async def test_negative_turn_clears_active_specialist_sessions(self) -> None:
        payload = NoraNaturalPayload(message="Não envie nada; apenas explique.", agenda_session_id="agenda-test", email_session_id="email-test", commercial_session_id="commercial-test")
        with (
            patch.object(nora_router.agenda_agent, "cancel_session") as agenda,
            patch.object(nora_router.team_meeting_agent, "cancel_session") as team,
            patch.object(nora_router.email_agent, "cancel_session") as email,
            patch.object(nora_router, "cancel_commercial_session") as commercial,
            patch.object(nora_router, "resolve_read_query", return_value=None),
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Explicação sem envio.")),
        ):
            await nora_router._execute_natural_conversation(payload, owner())
        agenda.assert_called_once_with("agenda-test")
        team.assert_called_once_with("agenda-test")
        email.assert_called_once_with("email-test", user_id="owner")
        commercial.assert_called_once_with("commercial-test")
        self.assertIsNone(payload.agenda_session_id)
        self.assertIsNone(payload.email_session_id)
        self.assertIsNone(payload.commercial_session_id)

    async def test_negative_turn_preserves_native_read_only_queries(self) -> None:
        query = ("tarefas", "Liste minhas tarefas, sem criar registros")
        with (
            patch.object(nora_router, "resolve_read_query", return_value=query),
            patch.object(nora_router, "answer_read_query", AsyncMock(return_value=("tarefas", {"status": "consulta", "response": "Nenhuma tarefa."}))) as read,
            patch.object(nora_router, "handle_task_agent", AsyncMock()) as tasks,
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock()) as provider,
        ):
            result = await nora_router._execute_natural_conversation(NoraNaturalPayload(message=query[1]), owner())
        self.assertEqual("consulta", result["status"])
        read.assert_awaited_once_with(owner(), *query)
        tasks.assert_not_awaited()
        provider.assert_not_awaited()

    def test_negative_mutations_and_positive_requests_are_distinct(self) -> None:
        for text in ("Sem criar tarefas", "Não crie uma tarefa", "Não quero que envie emails", "Nunca publique uma mensagem", "Sem agendar reuniões", "Evite excluir registros"):
            with self.subTest(text=text):
                self.assertTrue(nora_router.natural_changes_forbidden(text))
        for text in ("Crie uma tarefa", "Envie um email", "Não esqueça meu prazo", "Liste minhas tarefas"):
            with self.subTest(text=text):
                self.assertFalse(nora_router.natural_changes_forbidden(text))

    async def test_general_question_is_answered_naturally_by_the_chat_model(self) -> None:
        answer = "Dom Casmurro foi escrito por Machado de Assis."
        with (
            patch.object(nora_router, "classificar_intencao_com_nora", AsyncMock(return_value=("chat", 0.99))),
            patch.object(nora_router, "message_with_memory", AsyncMock(return_value="Quem escreveu Dom Casmurro?")),
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock(return_value=answer)) as provider,
        ):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="Quem escreveu Dom Casmurro?"),
                owner(),
            )

        self.assertEqual("chat", result["intent"])
        self.assertEqual("chat", result["status"])
        self.assertEqual(answer, result["response"])
        provider.assert_awaited_once()

    async def test_central_question_uses_integrated_operational_data_before_model(self) -> None:
        integrated = {
            "status": "consulta",
            "response": "Há duas aprovações e uma tarefa vencida que exigem atenção.",
            "summary": {"pendingApprovals": 2, "overdueTasks": 1},
        }
        with (
            patch.object(nora_router, "answer_read_query", AsyncMock(return_value=("operacoes", integrated))) as read,
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock()) as provider,
        ):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="Analise a Central de trabalho e priorize o que exige atenção"),
                owner(),
            )

        self.assertEqual("operacoes", result["intent"])
        self.assertEqual(integrated["response"], result["response"])
        read.assert_awaited_once()
        provider.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
