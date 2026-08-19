from __future__ import annotations

import unittest

from app.core.ai_guardrails import minimize_for_ai


class AiGuardrailTests(unittest.TestCase):
    def test_masks_secrets_and_private_identifiers(self) -> None:
        content = (
            "senha=segredo-super-forte CPF 123.456.789-10 "
            "cartao 4111 1111 1111 1111 token sk-abcdefghijklmnop123456"
        )

        sanitized = minimize_for_ai(content)

        self.assertNotIn("segredo-super-forte", sanitized)
        self.assertNotIn("123.456.789-10", sanitized)
        self.assertNotIn("4111 1111 1111 1111", sanitized)
        self.assertNotIn("sk-abcdefghijklmnop123456", sanitized)
        self.assertIn("[SEGREDO REMOVIDO]", sanitized)
        self.assertIn("[CPF REMOVIDO]", sanitized)
        self.assertIn("[DADO FINANCEIRO REMOVIDO]", sanitized)

    def test_limits_external_context_sent_to_ai(self) -> None:
        self.assertEqual("abcde", minimize_for_ai("abcdefgh", max_chars=5))


if __name__ == "__main__":
    unittest.main()
