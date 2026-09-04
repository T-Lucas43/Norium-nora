import unittest
from unittest.mock import patch

from app.services import nora_read_queries as queries


class NoraReadQueryTests(unittest.IsolatedAsyncioTestCase):
    def test_recognizes_read_only_followups_without_turning_actions_into_queries(self) -> None:
        self.assertEqual(("dashboard", "e meu dashboard?"), queries.resolve_read_query("e meu dashboard?", []))
        self.assertEqual(("documents", "e meus documentos?"), queries.resolve_read_query("e meus documentos?", []))
        self.assertEqual(("reports", "e meus relatorios??"), queries.resolve_read_query("e meus relatórios??", []))
        self.assertEqual("team", queries.resolve_read_query("e meu chat de equiper?", [])[0])
        previous = [{"role": "user", "content": "como anda o desenvolvimento da minha equipe?"}, {"role": "assistant", "content": "Qual aspecto?"}]
        self.assertEqual("team", queries.resolve_read_query("tudo", previous)[0])
        self.assertIsNone(queries.resolve_read_query("envie uma mensagem para a equipe", []))

    async def test_team_query_reads_only_visible_thread_and_never_sends(self) -> None:
        user = {"id": "owner", "permissions": {"equipe": True}}
        members = [{"id": "owner", "nome": "Dono", "status": "ativo"}, {"id": "fernando", "nome": "Fernando Lima", "status": "ativo"}]
        store = {"messages": [
            {"id": "visible", "threadId": "direct:fernando:owner", "scope": "direct", "senderId": "owner", "recipientId": "fernando", "senderName": "Dono", "text": "Mensagem real", "createdAt": "2026-09-04T10:00:00Z"},
            {"id": "other", "threadId": "direct:another:owner", "scope": "direct", "senderId": "owner", "recipientId": "another", "senderName": "Dono", "text": "Não deve aparecer"},
        ]}
        with (
            patch.object(queries, "require_team_chat"),
            patch.object(queries, "visible_team_members", return_value=members),
            patch.object(queries, "read_pruned_chat_store", return_value=store),
            patch.object(queries, "list_tasks", return_value={"stats": {"ativas": 1}}),
        ):
            intent, result = await queries.answer_read_query(user, "team", "e minhas mensagens para o fernando no chat?")
        self.assertEqual("equipe", intent)
        self.assertEqual(["visible"], [item["id"] for item in result["messages"]])
        self.assertIn("Mensagem real", result["response"])
        self.assertNotIn("Não deve aparecer", result["response"])

    async def test_documents_are_listed_without_persisting_document_contents(self) -> None:
        with patch.object(queries, "list_collection", return_value=[{"id": "doc", "title": "Manual", "content": "conteudo privado", "pageCount": 4}]):
            _, result = await queries.answer_read_query({"id": "owner"}, "documents", "meus documentos")
        self.assertEqual(1, result["total"])
        self.assertNotIn("content", result["documents"][0])
        self.assertIn("Manual", result["response"])


if __name__ == "__main__":
    unittest.main()
