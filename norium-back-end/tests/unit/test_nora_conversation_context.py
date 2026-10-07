"""Persistent conversational memory for Nora: turns, compaction, isolation."""

import importlib
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, MagicMock, patch

from app.core.request_context import reset_request_context, set_request_context
from app.core.tenant import get_user_db_path, write_user_db
import app.modules.nora.context as nora_context
from app.modules.nora import conversations as nora_conversations
from app.modules.nora import router as nora_router
from app.modules.nora.router import MessageItem, NoraNaturalPayload
from app.services.nora_skills import SkillResolution

CONVERSATION_ID = "ctx-test-0001"


def owner(user_id: str = "owner-context") -> dict:
    return {
        "id": user_id,
        "nome": "Tester",
        "role": "owner",
        "permissions": {"nora": True},
    }


def chat_resolution() -> SkillResolution:
    return SkillResolution(
        skill_id="chat",
        confidence=0.9,
        score=3.0,
        margin=1.0,
        needs_semantic_fallback=False,
        matched_signals=(),
        alternatives=(),
    )


def natural_gates(test_case: unittest.TestCase):
    """Force the generic chat path so the tests exercise context, not routing."""
    patches = [
        patch.object(nora_router, "resolve_skill", return_value=chat_resolution()),
        patch.object(nora_router, "classificar_intencao_com_nora", AsyncMock(return_value=("chat", 0.99))),
        patch.object(nora_router, "resolve_read_query", return_value=None),
        patch.object(nora_router, "answer_module_help", return_value=None),
        patch.object(nora_router, "mensagem_social_curta", return_value=None),
        patch.object(nora_router, "memory_preference_request", return_value=None),
        patch.object(nora_router, "web_research_request", return_value=False),
        patch.object(nora_router, "browser_tool_request", return_value=None),
        patch.object(nora_router, "is_compound_request", return_value=False),
        patch.object(nora_router, "is_team_meeting_intent", return_value=False),
        patch.object(nora_router, "is_whatsapp_send_request", return_value=False),
        patch.object(nora_router, "is_deterministic_file_request", return_value=False),
        patch.object(nora_router, "request_sensitive_approval", AsyncMock(return_value=None)),
        patch.object(nora_router, "message_with_memory", AsyncMock(side_effect=lambda user, text, cats: text)),
        patch.object(nora_router, "knowledge_context_for_nora", return_value=("", [])),
    ]
    for entered in patches:
        entered.start()
        test_case.addCleanup(entered.stop)


class NoraConversationContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(os.environ, {"NORIUM_DATA_DIR": self.directory.name, "ENVIRONMENT": "test"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request_context = set_request_context("test-nora-context", "primary")
        self.addCleanup(reset_request_context, self.request_context)

    async def test_append_and_load_multiple_turns_in_order(self) -> None:
        for index in range(1, 4):
            record = await nora_context.append_conversation_turn(
                "owner-context", CONVERSATION_ID, f"pergunta {index}", f"resposta {index}", intent="chat",
            )
            self.assertIsNotNone(record)
        snapshot, writable = nora_context.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertTrue(writable)
        self.assertEqual(3, len(snapshot["turns"]))
        self.assertEqual(
            ["pergunta 1", "pergunta 2", "pergunta 3"],
            [turn["user"] for turn in snapshot["turns"]],
        )
        self.assertEqual("chat", snapshot["turns"][0]["intent"])
        messages = nora_context.context_prompt_messages(snapshot)
        self.assertEqual(6, len(messages))
        self.assertEqual(["user", "assistant"] * 3, [item["role"] for item in messages])

    async def test_compaction_preserves_first_turn_and_recents_with_bounds(self) -> None:
        for index in range(1, 62):
            await nora_context.append_conversation_turn(
                "owner-context", CONVERSATION_ID, f"turno {index} pergunta", f"turno {index} resposta",
            )
        snapshot, writable = nora_context.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertTrue(writable)
        turns = snapshot["turns"]
        self.assertEqual(21, len(turns))
        self.assertIn("turno 1 pergunta", turns[0]["user"])
        self.assertIn("turno 61 pergunta", turns[-1]["user"])
        self.assertLessEqual(len(snapshot["summary"]), nora_context.MAX_SUMMARY_CHARS)
        self.assertIn("turno 2 pergunta", snapshot["summary"])
        self.assertNotIn("turno 50 pergunta", snapshot["summary"])
        messages = nora_context.context_prompt_messages(snapshot)
        self.assertLessEqual(len(messages), nora_context.MAX_CONTEXT_MESSAGES)
        self.assertEqual("system", messages[0]["role"])
        self.assertIn("turno 2 pergunta", messages[0]["content"])

    async def test_context_survives_module_reload(self) -> None:
        await nora_context.append_conversation_turn(
            "owner-context", CONVERSATION_ID, "primeiro turno", "primeira resposta",
        )
        reloaded = importlib.reload(nora_context)
        snapshot, writable = reloaded.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertTrue(writable)
        self.assertEqual(1, len(snapshot["turns"]))
        self.assertEqual("primeiro turno", snapshot["turns"][0]["user"])
        self.assertEqual("primeira resposta", snapshot["turns"][0]["ai"])

    async def test_delete_conversation_removes_server_context(self) -> None:
        user = owner()
        await nora_context.append_conversation_turn(user["id"], CONVERSATION_ID, "oi", "olá")
        record = {
            "id": CONVERSATION_ID, "title": "T", "createdAt": "2026-09-20T00:00:00+00:00",
            "updatedAt": "2026-09-20T00:00:00+00:00", "revision": 0, "messageCount": 0,
            "inLibrary": False, "preview": "", "state": {"messages": []},
        }
        write_user_db(user["id"], nora_conversations.conversation_db(CONVERSATION_ID), record)
        write_user_db(user["id"], nora_conversations.INDEX, {
            "conversations": [{key: value for key, value in record.items() if key != "state"}],
        })
        result = await nora_conversations.delete_conversation(CONVERSATION_ID, user)
        self.assertEqual({"deleted": True}, result)
        snapshot, _ = nora_context.load_conversation_context(user["id"], CONVERSATION_ID)
        self.assertEqual([], snapshot["turns"])
        context_path = get_user_db_path(user["id"], nora_context.context_db(CONVERSATION_ID))
        self.assertFalse(Path(context_path).exists())
        self.assertTrue(await nora_context.delete_conversation_context(user["id"], CONVERSATION_ID))

    def test_merge_dedupes_client_messages_with_raw_formatting(self) -> None:
        persisted = [
            {"role": "system", "content": "Resumo parcial da conversa"},
            {"role": "user", "content": "linha1 linha2"},
            {"role": "assistant", "content": "resposta simples"},
            {"role": "user", "content": "turno novo"},
        ]
        client = [
            {"role": "user", "content": "linha1\nlinha2"},
            {"role": "assistant", "content": "resposta   simples"},
        ]
        merged = nora_context.merge_histories(persisted, client)
        self.assertEqual(4, len(merged))
        self.assertEqual("system", merged[0]["role"])
        self.assertEqual("turno novo", merged[1]["content"])
        self.assertIs(client[0], merged[2])
        self.assertIs(client[1], merged[3])

    def test_context_window_pins_summary(self) -> None:
        messages = [MessageItem(role="system", content="resumo")] + [
            MessageItem(role="user" if index % 2 == 0 else "assistant", content=f"m{index}")
            for index in range(8)
        ]
        window = nora_router.context_window(messages, 4)
        self.assertEqual(5, len(window))
        self.assertEqual("system", window[0].role)
        self.assertEqual(["m4", "m5", "m6", "m7"], [item.content for item in window[1:]])

    def test_referential_followup_keeps_previous_agent_domain(self) -> None:
        snapshot = {"turns": [{"intent": "email", "user": "redija um email", "ai": "rascunho pronto"}]}
        resolution = chat_resolution()
        self.assertEqual(
            "email",
            nora_router.contextual_continuation_intent(snapshot, "E envie também para Ana", resolution),
        )
        self.assertIsNone(
            nora_router.contextual_continuation_intent(snapshot, "Qual a capital do Chile?", resolution),
        )

    def test_user_supplied_fact_question_stays_in_natural_chat(self) -> None:
        self.assertTrue(nora_router.explicit_context_fact_question(
            "O Projeto Atlas tem prazo em 30 de setembro de 2026. Qual é o prazo do projeto?",
        ))
        self.assertTrue(nora_router.explicit_context_fact_question(
            "Meu código de referência é AZUL-482; qual é o código?",
        ))
        self.assertFalse(nora_router.explicit_context_fact_question(
            "Crie uma tarefa no Projeto Atlas; qual é o prazo disponível?",
        ))

    def test_single_supporting_word_is_too_weak_to_hijack_chat(self) -> None:
        resolution = nora_router.resolve_skill(
            "Meu código de referência é AZUL-482. Responda apenas confirmando que entendeu.",
        )
        self.assertLessEqual(resolution.score, 2.5)
        self.assertTrue(resolution.needs_semantic_fallback)

    async def test_invalid_conversation_id_is_ignored(self) -> None:
        for candidate in [None, "", "short", "has space in it!", "../escape", "a" * 81, 12345, "ok-but\nnewline"]:
            with self.subTest(candidate=repr(candidate)):
                self.assertIsNone(nora_context.valid_conversation_id(candidate))
                snapshot, writable = nora_context.load_conversation_context("owner-context", candidate)
                self.assertEqual([], snapshot["turns"])
                self.assertFalse(writable)
                self.assertIsNone(await nora_context.append_conversation_turn("owner-context", candidate, "oi", "olá"))
                self.assertFalse(await nora_context.delete_conversation_context("owner-context", candidate))
        self.assertEqual("abcd1234", nora_context.valid_conversation_id("abcd1234"))
        self.assertEqual("a" * 80, nora_context.valid_conversation_id("a" * 80))
        self.assertEqual([], list(Path(self.directory.name).rglob("*")))

    async def test_corrupt_store_is_read_only_and_bytes_preserved(self) -> None:
        path = get_user_db_path("owner-context", nora_context.context_db(CONVERSATION_ID))
        raw = b"{invalid json,,,"
        Path(path).write_bytes(raw)
        snapshot, writable = nora_context.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertEqual([], snapshot["turns"])
        self.assertFalse(writable)
        skipped = await nora_context.append_conversation_turn("owner-context", CONVERSATION_ID, "oi", "olá")
        self.assertIsNone(skipped)
        self.assertEqual(raw, Path(path).read_bytes())
        natural_gates(self)
        with patch.object(
            nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Resposta apesar da corrupção.")
        ):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="Quem escreveu Dom Casmurro?", conversation_id=CONVERSATION_ID),
                owner(),
            )
        self.assertEqual("chat", result["intent"])
        self.assertEqual(raw, Path(path).read_bytes())

    async def test_isolation_between_users_and_workspaces(self) -> None:
        await nora_context.append_conversation_turn("user-a", CONVERSATION_ID, "segredo de A", "resposta A")
        snapshot_b, writable_b = nora_context.load_conversation_context("user-b", CONVERSATION_ID)
        self.assertEqual([], snapshot_b["turns"])
        self.assertTrue(writable_b)
        await nora_context.append_conversation_turn("user-b", CONVERSATION_ID, "texto de B", "resposta B")
        snapshot_a, _ = nora_context.load_conversation_context("user-a", CONVERSATION_ID)
        self.assertEqual(1, len(snapshot_a["turns"]))
        self.assertIn("segredo de A", snapshot_a["turns"][0]["user"])
        other = set_request_context("other-workspace", "team-b")
        try:
            snapshot_w, _ = nora_context.load_conversation_context("user-a", CONVERSATION_ID)
            self.assertEqual([], snapshot_w["turns"])
            await nora_context.append_conversation_turn("user-a", CONVERSATION_ID, "texto do team-b", "resposta B")
            snapshot_w2, _ = nora_context.load_conversation_context("user-a", CONVERSATION_ID)
            self.assertEqual(1, len(snapshot_w2["turns"]))
        finally:
            reset_request_context(other)
        snapshot_a2, _ = nora_context.load_conversation_context("user-a", CONVERSATION_ID)
        self.assertEqual(1, len(snapshot_a2["turns"]))
        self.assertIn("segredo de A", snapshot_a2["turns"][0]["user"])

    async def test_natural_endpoint_restores_context_on_second_turn(self) -> None:
        natural_gates(self)
        with patch.object(
            nora_router.nora_service, "perguntar_nora", AsyncMock(side_effect=["Resposta um.", "Resposta dois."])
        ) as provider:
            first = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="Primeira pergunta sobre pitangas", conversation_id=CONVERSATION_ID),
                owner(),
            )
            second = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="E quem escreveu Iracema?", conversation_id=CONVERSATION_ID),
                owner(),
            )
        self.assertEqual("Resposta um.", first["response"])
        self.assertEqual("chat", first["intent"])
        self.assertEqual("Resposta dois.", second["response"])
        self.assertEqual(2, provider.await_count)
        second_input = provider.await_args_list[1].args[0]
        joined = "\n".join(item["content"] for item in second_input)
        self.assertIn("pitangas", joined)
        snapshot, _ = nora_context.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertEqual(2, len(snapshot["turns"]))

    async def test_natural_endpoint_without_conversation_id_writes_nothing(self) -> None:
        natural_gates(self)
        with patch.object(
            nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Resposta avulsa.")
        ):
            result = await nora_router.conversar_com_nora_natural(
                NoraNaturalPayload(message="Quem escreveu Dom Casmurro?"),
                owner(),
            )
        self.assertEqual("chat", result["intent"])
        self.assertEqual([], list(Path(self.directory.name).rglob("nora_ctx_*")))

    async def test_stream_endpoint_restores_and_records_context(self) -> None:
        seeded = await nora_context.append_conversation_turn(
            "owner-context", CONVERSATION_ID, "Lembrete sobre jabuticabas", "Anotado.",
        )
        self.assertIsNotNone(seeded)
        captured: dict = {}

        async def fake_stream(mensagens, screen_context=None, **kwargs):
            captured["messages"] = list(mensagens)
            yield "Dom Casmurro "
            yield "foi escrito por Machado de Assis."

        request = MagicMock()
        request.is_disconnected = AsyncMock(return_value=False)
        natural_gates(self)
        # The response streams lazily: consume it while the provider patch is
        # active, otherwise the real provider runs and the assertions below
        # silently stop exercising the seeded context.
        with patch.object(nora_router.nora_service, "perguntar_nora_stream", new=fake_stream):
            response = await nora_router.conversar_com_nora_natural_stream(
                NoraNaturalPayload(message="Quem escreveu Dom Casmurro?", conversation_id=CONVERSATION_ID),
                request,
                owner(),
            )
            body = "".join([chunk async for chunk in response.body_iterator])
        self.assertIn('"type": "done"', body)
        joined = "\n".join(item["content"] for item in captured["messages"])
        self.assertIn("jabuticabas", joined)
        snapshot, _ = nora_context.load_conversation_context("owner-context", CONVERSATION_ID)
        self.assertEqual(2, len(snapshot["turns"]))
        self.assertIn("Machado de Assis", snapshot["turns"][-1]["ai"])

    async def test_write_failure_degrades_with_safe_log(self) -> None:
        marker = "pitangas-supersecretas-xyz"
        natural_gates(self)
        with (
            patch.object(nora_router.nora_service, "perguntar_nora", AsyncMock(return_value="Resposta ok.")),
            patch.object(nora_context, "write_user_db", side_effect=OSError("disk full")),
        ):
            with self.assertLogs("app.modules.nora.context", level="WARNING") as logs:
                result = await nora_router.conversar_com_nora_natural(
                    NoraNaturalPayload(message=f"Pergunta sobre {marker}", conversation_id=CONVERSATION_ID),
                    owner(),
                )
        self.assertEqual("Resposta ok.", result["response"])
        output = "\n".join(logs.output)
        self.assertIn("nora_context_write_failed", output)
        self.assertNotIn(marker, output)


if __name__ == "__main__":
    unittest.main()
