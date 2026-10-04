from __future__ import annotations

import copy
import json
import os
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet

from app.core.credentials import CredentialConfigurationError, CredentialRecoveryError
from app.services import oauth_credentials as vault
from app.services.gmail_service import GmailService, GmailConfigError
from app.services.calendar_service import CalendarService


class OAuthCredentialStorageTests(unittest.TestCase):
    def setUp(self):
        self.active = Fernet.generate_key().decode("ascii")
        configured = patch.dict(os.environ, {vault.ACTIVE_KEY_ENV: self.active, vault.PREVIOUS_KEYS_ENV: ""})
        configured.start()
        self.addCleanup(configured.stop)
        self.token = {"client_id": "synthetic-client", "client_secret": "synthetic-client-secret",
                      "token": "synthetic-access-token", "refresh_token": "synthetic-refresh-token", "scopes": ["scope"]}

    def test_tokens_and_client_secret_are_encrypted(self):
        value = vault.protect("alice", "gmailToken", self.token)
        encoded = json.dumps(value)
        for secret in self.token.values():
            if isinstance(secret, str):
                self.assertNotIn(secret, encoded)
        self.assertEqual(self.token, vault.recover("alice", "gmailToken", value)[0])

    def test_copy_to_other_account_or_purpose_is_rejected(self):
        value = vault.protect("alice", "gmailToken", self.token)
        for owner, purpose in (("bob", "gmailToken"), ("alice", "calendarToken"), ("alice", "gmailOauthState")):
            with self.assertRaises(CredentialRecoveryError):
                vault.recover(owner, purpose, value)

    def test_tampered_envelope_fails_without_plaintext_fallback(self):
        value = vault.protect("alice", "gmailToken", self.token)
        ciphertext = value["credential"]["ciphertext"]
        value["credential"]["ciphertext"] = ciphertext[:-8] + "AAAAAAAA"
        with self.assertRaises(CredentialRecoveryError):
            vault.recover("alice", "gmailToken", value)

    def test_key_rotation_requires_rewrite_with_active_key(self):
        old = vault.protect("alice", "gmailToken", self.token)
        with patch.dict(os.environ, {vault.ACTIVE_KEY_ENV: Fernet.generate_key().decode("ascii"), vault.PREVIOUS_KEYS_ENV: self.active}):
            recovered, rewrite = vault.recover("alice", "gmailToken", old)
            self.assertTrue(rewrite)
            current = vault.protect("alice", "gmailToken", recovered)
            self.assertFalse(vault.recover("alice", "gmailToken", current)[1])

    def test_shared_environment_never_uses_ephemeral_test_key(self):
        with patch.dict(os.environ, {vault.ACTIVE_KEY_ENV: "", "ENVIRONMENT": "staging", "APP_ENV": "test"}):
            with self.assertRaises(CredentialConfigurationError):
                vault.recover("alice", "gmailToken", self.token)

    def test_gmail_migrates_plaintext_before_returning_credentials(self):
        stored = {"gmailToken": copy.deepcopy(self.token)}
        service = GmailService("alice")
        with patch.object(service, "_read_integration_store", side_effect=lambda: copy.deepcopy(stored)), patch.object(service, "_write_integration_store", side_effect=lambda value: stored.update(value)):
            self.assertEqual(self.token, service._read_profile_section("gmailToken", {}))
        self.assertEqual(vault.FORMAT, stored["gmailToken"]["format"])
        self.assertNotIn("synthetic-refresh-token", json.dumps(stored))

    def test_missing_key_does_not_migrate_or_return_plaintext(self):
        service = GmailService("alice")
        with patch.dict(os.environ, {vault.ACTIVE_KEY_ENV: "", "ENVIRONMENT": "production", "APP_ENV": "production"}), patch.object(service, "_read_integration_store", return_value={"gmailToken": self.token}), patch.object(service, "_write_integration_store") as write:
            with self.assertRaises(GmailConfigError):
                service._read_profile_section("gmailToken", {})
        write.assert_not_called()

    def test_calendar_authorization_storage_is_account_scoped_and_protected(self):
        stored = {}
        service = CalendarService("alice")
        with patch("app.services.calendar_service.read_account_db", side_effect=lambda *_: copy.deepcopy(stored)), patch("app.services.calendar_service.write_account_db", side_effect=lambda _uid, _name, value: stored.update(value)), patch.object(service, "_write_profile") as profile:
            service._write_profile_section("calendarToken", self.token)
            self.assertEqual(self.token, service._read_profile_section("calendarToken", {}))
        profile.assert_not_called()
        self.assertEqual(vault.FORMAT, stored["calendarToken"]["format"])

    def test_unknown_envelope_cannot_be_treated_as_legacy(self):
        with self.assertRaises(CredentialRecoveryError):
            vault.recover("alice", "gmailToken", {"format": "attacker-chosen", **self.token})

    def test_migration_protects_known_sections_and_preserves_other_profile_data(self):
        from scripts.migrate_oauth_credentials import transform, account_for_key
        self.assertEqual("alice", account_for_key("user_alice/workspace_team/perfil_db.json"))
        self.assertIsNone(account_for_key("_system/perfil_db.json"))
        self.assertIsNone(account_for_key("user_alice/workspace_team/../../perfil_db.json"))
        self.assertIsNone(account_for_key("user_alice/customer_content_db.json"))
        original = {"nome": "Synthetic", "gmailToken": self.token, "calendarOauthState": {"attempts": []}}
        value, counts = transform("alice", original)
        self.assertEqual("Synthetic", value["nome"])
        self.assertEqual(2, counts["rewritten"])
        self.assertNotIn("synthetic-refresh-token", json.dumps(value))
        self.assertEqual(0, transform("alice", value)[1]["rewritten"])
        self.assertEqual(self.token, original["gmailToken"])

    def test_migration_rejects_an_envelope_from_another_account(self):
        from scripts.migrate_oauth_credentials import transform
        with self.assertRaises(CredentialRecoveryError):
            transform("bob", {"gmailToken": vault.protect("alice", "gmailToken", self.token)})

    def test_shared_google_configuration_requires_dedicated_key_at_startup(self):
        with patch.dict(os.environ, {vault.ACTIVE_KEY_ENV: "", "ENVIRONMENT": "staging", "APP_ENV": "staging", "GMAIL_CLIENT_ID": "synthetic-client"}):
            with self.assertRaises(CredentialConfigurationError):
                vault.validate_configuration()
