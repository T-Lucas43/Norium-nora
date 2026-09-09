import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet

from app.infrastructure import team_call_alert_probe as probe


class AlertProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'system_email_config_db.json'
        self.cipher = Fernet(Fernet.generate_key())

    def test_authorized_recipient_gets_one_message_and_retry_cannot_duplicate_it(self):
        with patch.object(probe, 'get_system_db_path', return_value=self.path), \
             patch.object(probe.mail, 'ready', return_value=True), \
             patch.object(probe.mail, 'cipher', return_value=self.cipher), \
             patch.object(probe.mail, 'send_smtp') as send:
            first = probe.send_probe('operator@example.test', 'synthetic-probe')
            retry = probe.send_probe('operator@example.test', 'synthetic-probe')
            self.assertTrue(first['smtpAccepted'])
            self.assertFalse(first['inboxDeliveryConfirmed'])
            self.assertFalse(first['externalMonitoringConfigured'])
            self.assertTrue(retry['alreadyAttempted'])
            send.assert_called_once()
            self.assertEqual('operator@example.test', send.call_args.args[0]['recipient'])
            self.assertNotIn('operator@example.test', json.dumps(first))

    def test_uncertain_delivery_is_never_retried_automatically(self):
        with patch.object(probe, 'get_system_db_path', return_value=self.path), \
             patch.object(probe.mail, 'ready', return_value=True), \
             patch.object(probe.mail, 'cipher', return_value=self.cipher), \
             patch.object(probe.mail, 'send_smtp', side_effect=OSError('sensitive SMTP response')) as send:
            with self.assertRaises(OSError):
                probe.send_probe('operator@example.test', 'synthetic-probe')
            self.assertFalse(probe.send_probe('operator@example.test', 'synthetic-probe')['smtpAccepted'])
            self.assertEqual(1, send.call_count)

    def test_invalid_recipient_or_unconfigured_email_cannot_send(self):
        with patch.object(probe.mail, 'ready', return_value=False), patch.object(probe.mail, 'send_smtp') as send:
            with self.assertRaises(ValueError):
                probe.send_probe('one@example.test,two@example.test', 'synthetic-probe')
            with self.assertRaises(RuntimeError):
                probe.send_probe('operator@example.test', 'synthetic-probe')
            send.assert_not_called()
