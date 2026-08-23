from __future__ import annotations

import unittest

from app.modules.chat.router import build_contact_indexes, melhor_nome_contato


class ContactNameResolutionTests(unittest.TestCase):
    """Resolução de nome resiliente à migração @lid do WhatsApp."""

    def test_promotes_real_name_over_id(self) -> None:
        phone = "219451387551856@lid"
        self.assertEqual("João", melhor_nome_contato(phone, "João", phone))

    def test_never_downgrades_real_name_to_id(self) -> None:
        # Catálogo não resolveu o nome (@lid) e traria o id cru como "novo";
        # o nome real já existente deve ser preservado.
        phone = "219451387551856@lid"
        self.assertEqual("João", melhor_nome_contato("João", phone, phone))

    def test_keeps_id_only_when_no_name_available(self) -> None:
        phone = "5511999999999@c.us"
        self.assertEqual(phone, melhor_nome_contato(None, phone, phone))
        self.assertEqual(phone, melhor_nome_contato(phone, "", phone))

    def test_treats_bare_digits_as_id(self) -> None:
        phone = "5511999999999@c.us"
        self.assertEqual("Maria", melhor_nome_contato("5511999999999", "Maria", phone))

    def test_contact_index_bridges_lid_to_name(self) -> None:
        # fetch-contacts indexado por número, mas com campo lid: o nome deve
        # ficar acessível também pela chave @lid usada pelos chats.
        contacts = [
            {"phone": "5511999999999@c.us", "lid": "219451387551856@lid", "name": "João"},
        ]
        nomes, _fotos, _meta = build_contact_indexes(contacts)
        self.assertEqual("João", nomes.get("219451387551856@lid"))
        self.assertEqual("João", nomes.get("5511999999999@c.us"))


if __name__ == "__main__":
    unittest.main()
