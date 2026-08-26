from __future__ import annotations

import unittest

from app.modules.chat import router as chat_router
from app.modules.chat.router import (
    build_contact_indexes,
    melhor_nome_contato,
    normalize_group_participants,
    normalize_profile_phone,
    parse_whatsapp_collection,
)


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

    def test_preserves_short_numeric_contact_name(self) -> None:
        phone = "5511999999999@c.us"
        self.assertEqual("123", melhor_nome_contato(phone, "123", phone))

    def test_contact_index_bridges_lid_to_name(self) -> None:
        # fetch-contacts indexado por número, mas com campo lid: o nome deve
        # ficar acessível também pela chave @lid usada pelos chats.
        contacts = [
            {"phone": "5511999999999@c.us", "lid": "219451387551856@lid", "name": "João"},
        ]
        nomes, _fotos, _meta = build_contact_indexes(contacts)
        self.assertEqual("João", nomes.get("219451387551856@lid"))
        self.assertEqual("João", nomes.get("5511999999999@c.us"))

    def test_remote_jid_alt_bridges_saved_phone_contact_to_lid_chat(self) -> None:
        phone_jid = "5585999999999@s.whatsapp.net"
        lid = "54855339126828@lid"
        records = [
            {
                "id": phone_jid,
                "name": "Kaio K",
                "isMyContact": True,
            },
            {
                "id": lid,
                "remoteJidAlt": phone_jid,
                "name": ".",
            },
        ]

        self.assertIn(phone_jid, chat_router._contact_aliases(records[1]))
        nomes, _fotos, _meta = build_contact_indexes(records)
        self.assertEqual("Kaio K", nomes.get(lid))

    def test_official_notify_field_is_used_as_saved_name(self) -> None:
        contacts = [
            {
                "id": "5511999999999",
                "lid": "219451387551856@lid",
                "notify": "Maria salva",
                "verifiedName": "Empresa Maria LTDA",
            }
        ]
        nomes, _fotos, _meta = build_contact_indexes(contacts)
        self.assertEqual("Maria salva", nomes["5511999999999"])
        self.assertEqual("Maria salva", nomes["219451387551856@lid"])

    def test_saved_contact_name_wins_over_profile_notify_fields(self) -> None:
        contacts = [
            {
                "id": "5511999999999",
                "displayName": "Maria do perfil",
                "name": "Maria salva na agenda",
                "notify": "Maria do perfil",
                "isMyContact": True,
            }
        ]
        nomes, _fotos, _meta = build_contact_indexes(contacts)
        self.assertEqual("Maria salva na agenda", nomes["5511999999999"])

    def test_nested_saved_name_wins_over_outer_profile_name(self) -> None:
        contacts = [
            {
                "id": "5511999999999",
                "notify": "Maria do perfil",
                "contact": {
                    "id": "5511999999999",
                    "savedName": "Maria salva na agenda",
                },
            }
        ]
        nomes, _fotos, _meta = build_contact_indexes(contacts)
        self.assertEqual("Maria salva na agenda", nomes["5511999999999"])

    def test_nested_contact_name_wins_over_outer_profile_name(self) -> None:
        lid = "54855339126828@lid"
        phone_jid = "5585999999999@s.whatsapp.net"
        contact = {
            "id": lid,
            "name": ".",
            "contact": {
                "id": phone_jid,
                "name": "Kaio K",
                "isMyContact": True,
            },
        }

        self.assertEqual("Kaio K", chat_router._contact_saved_name(contact, lid))
        nomes, _fotos, _meta = build_contact_indexes([contact])
        self.assertEqual("Kaio K", nomes.get(lid))
        self.assertEqual("Kaio K", nomes.get(phone_jid))

    def test_group_subject_wins_over_group_jid(self) -> None:
        groups = [{"id": "120363000000000000@g.us", "subject": "Familia"}]
        nomes, _fotos, _meta = build_contact_indexes(groups)
        self.assertEqual("Familia", nomes["120363000000000000@g.us"])

    def test_profile_phone_uses_plain_international_number(self) -> None:
        self.assertEqual("5511999999999", normalize_profile_phone("5511999999999@c.us"))
        self.assertEqual("5511999999999", normalize_profile_phone("+55 (11) 99999-9999"))
        self.assertEqual("219451387551856@lid", normalize_profile_phone("219451387551856@lid"))

    def test_group_participant_uses_cached_name_and_admin_role(self) -> None:
        names, photos, _meta = build_contact_indexes(
            [
                {
                    "id": "5511999999999@s.whatsapp.net",
                    "savedName": "Maria da agenda",
                    "profilePictureUrl": "https://cdn.example/maria.jpg",
                }
            ]
        )
        participants = normalize_group_participants(
            [{"id": "5511999999999@s.whatsapp.net", "admin": "superadmin"}],
            names,
            photos,
        )
        self.assertEqual("Maria da agenda", participants[0]["name"])
        self.assertEqual("superadmin", participants[0]["admin"])
        self.assertTrue(participants[0]["isAdmin"])
        self.assertTrue(participants[0]["isSuperAdmin"])
        self.assertEqual("https://cdn.example/maria.jpg", participants[0]["photoUrl"])

    def test_group_participant_prefers_saved_contact_name_over_profile_name(self) -> None:
        names, _photos, _meta = build_contact_indexes(
            [
                {
                    "id": "5511999999999@s.whatsapp.net",
                    "savedName": "Maria da agenda",
                }
            ]
        )
        participants = normalize_group_participants(
            [{"id": "5511999999999@s.whatsapp.net", "pushName": "Maria do perfil"}],
            names,
        )
        self.assertEqual("Maria da agenda", participants[0]["name"])

    def test_group_participant_explicit_saved_name_wins_over_profile_index(self) -> None:
        participant_id = "5511999999999@s.whatsapp.net"
        participants = normalize_group_participants(
            [
                {"id": participant_id, "savedName": "Maria da agenda"},
            ],
            {participant_id: "Maria do perfil no catálogo"},
        )
        self.assertEqual("Maria da agenda", participants[0]["name"])

    def test_group_messages_are_rehydrated_with_saved_contact_name(self) -> None:
        participant_id = "5511999999999@s.whatsapp.net"
        conversation = {
            "esGrupo": True,
            "mensagens": [
                {
                    "remetente": "contato",
                    "remetenteId": participant_id,
                    "remetenteNome": "Maria do perfil",
                }
            ],
        }

        changed = chat_router.hydrate_group_message_names(conversation, {participant_id: "Maria da agenda"})

        self.assertTrue(changed)
        self.assertEqual("Maria da agenda", conversation["mensagens"][0]["remetenteNome"])

    def test_group_participant_names_are_indexed_as_contact_fallback(self) -> None:
        names, _photos, _meta = build_contact_indexes(
            [
                {
                    "id": "120363000000000000@g.us",
                    "participants": [
                        {"id": "5511888887777@s.whatsapp.net", "pushName": "Ana"}
                    ],
                }
            ]
        )
        self.assertEqual("Ana", names["5511888887777@s.whatsapp.net"])

    def test_nested_catalog_wrapper_is_unwrapped(self) -> None:
        payload = {"data": {"contacts": [{"id": "5511999999999", "name": "Maria"}]}}
        self.assertEqual("Maria", parse_whatsapp_collection(payload)[0]["name"])


if __name__ == "__main__":
    unittest.main()
