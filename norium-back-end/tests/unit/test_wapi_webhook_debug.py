from __future__ import annotations

import unittest

from app.modules.chat.router import _mask_id, _webhook_debug_snapshot


class WebhookDebugRedactionTests(unittest.TestCase):
    """Garante que o log de diagnóstico não vaza texto de mensagem nem telefone completo."""

    def test_mask_keeps_only_tail_and_suffix(self) -> None:
        self.assertEqual("...8888@lid", _mask_id("219451387551856@lid"[:-4] + "8888@lid"))
        self.assertEqual("...5678@c.us", _mask_id("5511999995678@c.us"))
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


if __name__ == "__main__":
    unittest.main()
