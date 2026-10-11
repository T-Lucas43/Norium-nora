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

    def test_keeps_phone_numbers_needed_for_whatsapp_context(self) -> None:
        content = "Celular 11987654321, com DDI 55 11 98765-4321 e fixo (11) 3322-4455."

        sanitized = minimize_for_ai(content)

        self.assertIn("11987654321", sanitized)
        self.assertIn("55 11 98765-4321", sanitized)
        self.assertNotIn("REMOVIDO", sanitized)

    def test_masks_unformatted_valid_cpf_and_keeps_invalid_sequences(self) -> None:
        sanitized = minimize_for_ai("cpf 52998224725 pedido 12345678901")

        self.assertNotIn("52998224725", sanitized)
        self.assertIn("[CPF REMOVIDO]", sanitized)
        self.assertIn("12345678901", sanitized)

    def test_card_mask_requires_valid_card_number(self) -> None:
        sanitized = minimize_for_ai("cartao 5555 5555 5555 4444 protocolo 1234 5678 9012 3456")

        self.assertNotIn("5555 5555 5555 4444", sanitized)
        self.assertIn("1234 5678 9012 3456", sanitized)

    def test_limits_external_context_sent_to_ai(self) -> None:
        self.assertEqual("abcde", minimize_for_ai("abcdefgh", max_chars=5))


if __name__ == "__main__":
    unittest.main()
