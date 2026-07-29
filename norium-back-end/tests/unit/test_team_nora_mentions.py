import unittest

from app.modules.team.nora_mentions import (
    build_team_prompt,
    build_team_transcript,
    has_nora_mention,
    remove_nora_mention,
)


class TeamNoraMentionTests(unittest.TestCase):
    def test_detects_only_explicit_nora_mentions(self) -> None:
        self.assertTrue(has_nora_mention("@nora pode resumir?"))
        self.assertTrue(has_nora_mention("Pode ajudar, @NORA?"))
        self.assertFalse(has_nora_mention("Nora pode ajudar?"))
        self.assertFalse(has_nora_mention("usuario@nora.com"))

    def test_removes_mention_without_damaging_request(self) -> None:
        self.assertEqual(remove_nora_mention("@nora  resuma o assunto acima"), "resuma o assunto acima")

    def test_transcript_uses_only_team_messages(self) -> None:
        messages = [
            {
                "threadId": "team",
                "scope": "team",
                "senderName": "Ana",
                "createdAt": "2026-07-23T12:00:00Z",
                "text": "O prazo mudou para sexta.",
                "attachments": [],
            },
            {
                "threadId": "direct:a:b",
                "scope": "direct",
                "senderName": "Privado",
                "createdAt": "2026-07-23T12:01:00Z",
                "text": "Mensagem privada.",
                "attachments": [],
            },
        ]
        transcript = build_team_transcript(messages)
        self.assertIn("O prazo mudou para sexta.", transcript)
        self.assertNotIn("Mensagem privada.", transcript)

    def test_prompt_includes_context_and_current_request(self) -> None:
        messages = [
            {
                "threadId": "team",
                "scope": "team",
                "senderName": "Ana",
                "createdAt": "2026-07-23T12:00:00Z",
                "text": "Vamos entregar o projeto na sexta.",
                "attachments": [],
            }
        ]
        prompt = build_team_prompt(messages, "Tarcisio", "@nora qual e o prazo?")
        self.assertIn("Vamos entregar o projeto na sexta.", prompt)
        self.assertIn("qual e o prazo?", prompt)
        self.assertNotIn("<pedido>\n@nora", prompt)


if __name__ == "__main__":
    unittest.main()
