from __future__ import annotations

import unittest

from app.modules.chat.router import _mask_id, _webhook_debug_snapshot


class WebhookDebugRedactionTests(unittest.TestCase):
    """Garante que o log de diagnóstico não vaza texto de mensagem nem telefone completo."""

    def test_mask_removes_entire_local_identifier(self) -> None:
        self.assertEqual("***@lid", _mask_id("219451387551856@lid"))
        self.assertEqual("***@c.us", _mask_id("5511999995678@c.us"))
        self.assertEqual("***", _mask_id("5511999995678"))
        self.assertIsNone(_mask_id(""))

    def test_snapshot_omits_message_text(self) -> None:
        data = {
            "event": "webhookReceived",
            "instanceId": "INST-A",
            "fromMe": True,
            "phone": "5511999995678@lid",
            "sender": {"id": "5511888887777", "senderLid": "111@lid", "pushName": "Fulano"},
            "msgContent": {"conversation": "texto secreto que não pode vazar"},
        }
        snap = _webhook_debug_snapshot(data, "received")
        blob = repr(snap)
        self.assertNotIn("texto secreto", blob)  # nenhum corpo de mensagem
        self.assertNotIn("5511999995678", blob)  # telefone completo mascarado
        self.assertNotIn("5511888887777", blob)
        self.assertNotIn("Fulano", blob)  # pushName não vaza (só o booleano)
        self.assertEqual(True, snap["fromMe"])
        self.assertEqual("received", snap["classifiedAs"])
        self.assertEqual(["conversation"], snap["msgContentKeys"])
        self.assertTrue(snap["hasPushName"])
        self.assertTrue(str(snap["chatIdMasked"]).endswith("@lid"))

    def test_snapshot_redacts_untyped_status_fields_and_unsafe_keys(self) -> None:
        secret = "conteudo sensivel dentro de status"
        data = {
            "event": "messageStatus",
            "status": {"text": secret, "phone": "5511999995678"},
            "ack": "READ",
            "state": "texto livre com espaços",
            "chave com telefone 5511999995678": True,
        }
        snap = _webhook_debug_snapshot(data, "status")
        blob = repr(snap)
        self.assertNotIn(secret, blob)
        self.assertNotIn("5511999995678", blob)
        self.assertEqual("<dict:redacted>", snap["status"])
        self.assertEqual("READ", snap["ack"])
        self.assertEqual("<str:redacted>", snap["state"])
        self.assertIn("<redacted-key>", snap["topKeys"])


if __name__ == "__main__":
    unittest.main()
