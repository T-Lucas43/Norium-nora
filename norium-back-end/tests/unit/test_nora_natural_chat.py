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
