import copy
import time
from dataclasses import replace
import unittest
from unittest.mock import AsyncMock, patch
from app.services.whatsapp_identity import coalesce
from app.services.conversation_store import new_conversation, normalize_database
from app.modules.chat import router, private_history, message_state
from app.modules.whatsapp_team import access, repository, service, context
from tests.unit.test_whatsapp_team import Fixture

PN = "5511999990000@s.whatsapp.net"
LID = "123456789@lid"
GROUP = "120363400000000000@g.us"


def row(cid, mid="one", at=100):
    result = new_conversation(cid, contato="Pessoa sintética", is_group=cid.endswith("@g.us"))
    result.update(timestampUltimaMsg=at, mensagens=[{"id": mid, "texto": "Texto sintético", "timestamp": at, "status": "lido"}])
    return result


class IdentityTests(unittest.TestCase):
    def test_hidden_message_from_the_old_lid_stays_hidden_after_merging(self):
        state = {"items": [{"id": message_state._id(LID, "one"), "hidden": True}]}
        self.assertEqual([], message_state.apply(state, PN, [{"id": "one"}], [LID, PN]))
        self.assertEqual([{"id": "two"}], message_state.apply(state, PN, [{"id": "two"}], [LID, PN]))

    def test_latest_reaction_override_across_aliases_wins_without_duplicate_bubbles(self):
        state = {"items": [{"id": message_state._id(LID, "one"), "reacoes": [{"emoji": "👍"}], "updatedAt": 2},
                           {"id": message_state._id(PN, "one"), "reacoes": [], "updatedAt": 3}]}
        self.assertEqual([], message_state.apply(state, PN, [{"id": "one"}], [LID])[0]["reacoes"])
    def test_existing_catalog_last_message_attests_the_reverse_lid_phone_pair(self):
        result = coalesce({PN: row(PN), LID: row(LID, "two")}, [{"id": PN, "lastMessage": {"key": {"remoteJid": LID, "remoteJidAlt": PN}}}])
        self.assertEqual(1, len(result))
        self.assertEqual(PN, result[LID]["id"])

    def test_unrelated_last_message_cannot_attach_a_third_recipient(self):
        result = coalesce({PN: row(PN), LID: row(LID)}, [{"id": PN, "lastMessage": {"key": {"remoteJid": LID, "remoteJidAlt": "5511888880000@s.whatsapp.net"}}}])
        self.assertEqual(2, len(result))
    def test_explicit_aliases_join_sent_received_but_keep_distinct_ids(self):
        database = {PN: row(PN), LID: row(LID, "two", 101)}
        snapshot = copy.deepcopy(database)
        result = coalesce(database, [{"id": PN, "remoteJidAlt": LID}])
        self.assertEqual([PN], list(result))
        self.assertEqual(["one", "two"], [item["id"] for item in result[LID]["mensagens"]])
        self.assertEqual(snapshot, database)
        self.assertIn(LID, result[PN]["metadados"]["identityAliases"])

    def test_replayed_id_is_single_bubble_and_does_not_regress_ack(self):
        first, second = row(PN), row(LID, at=101)
        second["mensagens"][0]["status"] = "enviado"
        result = coalesce({PN: first, LID: second}, [{"id": PN, "lid": LID}])
        self.assertEqual(1, len(result[PN]["mensagens"]))
        self.assertEqual("lido", result[PN]["mensagens"][0]["status"])

    def test_numeric_similarity_or_same_name_never_links_lid(self):
        result = coalesce({PN: row(PN), "5511999990000@lid": row("5511999990000@lid")})
        self.assertEqual(2, len(result))

    def test_conflicting_phone_evidence_fails_closed(self):
        other = "5511888880000@s.whatsapp.net"
        result = coalesce({PN: row(PN), LID: row(LID), other: row(other)}, [{"id": PN, "lid": LID}, {"id": other, "lid": LID}])
        self.assertEqual(3, len(result))

    def test_group_sender_and_own_phone_are_never_group_aliases(self):
        result = coalesce({PN: row(PN), GROUP: row(GROUP)}, [{"id": GROUP, "phone": PN, "lid": LID}])
        self.assertEqual(2, len(result))
        self.assertNotIn(LID, result[GROUP]["metadados"]["identityAliases"])

    def test_phone_jid_variants_merge_and_preserve_alias_lookup(self):
        result = coalesce({PN: row(PN), PN.replace("@s.whatsapp.net", "@c.us"): row(PN, "two")})
        self.assertEqual(1, len(result))
        self.assertIn(PN.replace("@s.whatsapp.net", "@c.us"), result)

    def test_alias_evidence_survives_normalization_and_reload(self):
        original = coalesce({LID: row(LID)}, [{"id": PN, "lid": LID}])
        with patch("app.services.conversation_store.is_evolution", return_value=True):
            result = normalize_database(original)
        self.assertEqual(PN, result[LID]["id"])

    def test_group_subject_beats_participant_and_saved_contact_name(self):
        names, _, _ = router.build_contact_indexes([
            {"id": GROUP, "subject": "Equipe sintética"},
            {"id": GROUP, "name": "Último participante", "pushName": "Último participante"}])
        self.assertEqual("Equipe sintética", names[GROUP])
        self.assertIsNone(router._contact_display_name({"id": GROUP, "pushName": "Participante"}, GROUP))
        self.assertNotIn(GROUP, router._build_saved_contact_name_index([{"id": GROUP, "name": "Participante", "pushName": "Participante"}]))

    def test_old_pages_read_both_attested_aliases_without_repeating_ids(self):
        def page(owner, instance, alias, **kwargs):
            return {"records": [{"key": {"id": "same"}, "messageTimestamp": 100},
                                {"key": {"id": "pn" if alias == PN else "lid"}, "messageTimestamp": 99}], "hasMore": False}
        with patch.object(private_history.evolution_history, "page", side_effect=page):
            result = private_history._page_aliases("owner", "instance", [PN, LID], before=101, before_id="z", limit=50)
        self.assertEqual(3, len(result["records"]))


class AssignmentIdentityTests(Fixture, unittest.TestCase):
    def linked(self, grant):
        return replace(grant, identity_aliases={PN: (PN, LID), LID: (PN, LID)})

    def test_grant_carries_alias_acl_for_labels_bulk_notes_and_fresh_mutations(self):
        value = {"inbox": {"enabled": True}, "assignments": {LID: {"assigneeKind": "user", "assigneeUserId": "bob"}}}
        with self.assertRaises(router.HTTPException):
            access.assert_conversation(self.linked(self.alice_access), value, PN)

    def test_catalog_only_identity_still_protects_old_assignment_after_snapshot_expiration(self):
        database = coalesce({}, [{"id": PN, "remoteJidAlt": LID}])
        grant = replace(self.alice_access, identity_aliases=context.identity_index(database))
        value = {"inbox": {"enabled": True}, "assignments": {LID: {"assigneeKind": "user", "assigneeUserId": "bob"}}}
        with self.assertRaises(router.HTTPException):
            access.assert_conversation(grant, value, PN)

    def test_reassignment_updates_legacy_assignment_and_preserves_notes(self):
        self.enable()
        original = service.update_assignment(self.owner_access, LID, expected_version=0, changes={"assigneeUserId": "bob"})
        note = service.create_note(self.owner_access, LID, body="Nota sintética", mentions=[])
        grant = self.linked(self.owner_access)
        changed = service.update_assignment(grant, PN, expected_version=original["version"], changes={"assigneeUserId": "alice"})
        value = repository.snapshot(self.scope)
        self.assertEqual("alice", value["assignments"][LID]["assigneeUserId"])
        self.assertEqual(changed["version"], value["assignments"][LID]["version"])
        value["_identityAliases"] = grant.identity_aliases
        self.assertEqual(note["id"], service.page(value, PN, "notes")["items"][0]["id"])
        edited = service.change_note(grant, PN, note["id"], expected_version=note["version"], body="Nota editada")
        self.assertEqual("Nota editada", edited["body"])

    def test_new_reply_reopens_legacy_assignment_without_changing_assignee(self):
        self.enable()
        original = service.update_assignment(self.owner_access, LID, expected_version=0, changes={"assigneeUserId": "bob"})
        service.update_assignment(self.owner_access, LID, expected_version=original["version"], changes={"status": "resolved"})
        result = service.received(self.scope, PN, message_id="new-inbound", timestamp=int(time.time()) + 2, aliases=(LID,), online_assignees=("alice",))
        self.assertEqual("open", result["status"]); self.assertEqual("bob", result["assigneeUserId"])

    def test_alias_does_not_bypass_assignment_to_another_member(self):
        value = {"inbox": {"enabled": True}, "assignments": {LID: {"assigneeKind": "member", "assigneeUserId": "bob"}}}
        with self.assertRaises(router.HTTPException):
            access.assert_conversation(self.alice_access, value, PN, [LID])
        self.assertEqual("bob", access.assert_conversation(self.owner_access, value, PN, [LID])["assigneeUserId"])


class WebhookIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_incoming_then_outgoing_and_replay_stay_single_conversation(self):
        stored = {}
        async def load(_):
            return coalesce(copy.deepcopy(stored))
        async def save(value, _):
            stored.clear(); stored.update(copy.deepcopy(value))
        with patch.object(router, "is_evolution", return_value=True), patch.object(router, "load_conversations", side_effect=load), \
             patch.object(router, "save_conversations", side_effect=save), patch.object(router, "mark_whatsapp_conversation_updated", new=AsyncMock()), \
             patch.object(router, "load_whatsapp_catalog_cache", new=AsyncMock(return_value={})), \
             patch.object(router, "record_event", new=AsyncMock()), patch("app.modules.whatsapp_team.bridge.incoming", new=AsyncMock()):
            for remote, alt, own, identifier in [(LID, PN, False, "received"), (PN, LID, True, "sent"), (LID, PN, False, "received")]:
                await router._wapi_handle_received_unlocked("synthetic", {"key": {"id": identifier, "remoteJid": remote, "remoteJidAlt": alt, "fromMe": own},
                    "message": {"conversation": "Texto sintético"}, "pushName": "Meu perfil" if own else "Contato", "messageTimestamp": 100})
        self.assertEqual([PN], list(stored))
        self.assertEqual(2, len(stored[PN]["mensagens"]))
