import importlib.util
import json
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[3] / 'infra/azure/team_call_storage_audit.py'
spec = importlib.util.spec_from_file_location('storage_audit', path)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class StorageAuditTests(unittest.TestCase):
    def test_corrupt_or_unreadable_databases_never_pass_as_empty(self):
        files = {'user_private/team_chat_db.json': b'{broken-private-content',
                 'unavailable_db.json': None, 'media.webm': b'private-media'}

        def download(name):
            if files[name] is None:
                raise OSError('private path')
            return files[name]

        result = audit.inspect_databases(files, download)
        self.assertEqual('review_required', result['status'])
        self.assertEqual(1, result['invalidJson'])
        self.assertEqual(1, result['unreadableDatabases'])
        self.assertEqual(2, result['databaseFiles'])
        self.assertNotIn('private', json.dumps(result))

    def test_secondary_team_store_is_reported_without_identifiers(self):
        result = audit.inspect_databases(['user_private/workspace_private/team_chat_db.json'],
                                        lambda _: b'{"recordings":[{"private":"content"}]}')
        self.assertEqual('review_required', result['status'])
        self.assertEqual(1, result['secondaryTeamStores'])
        self.assertEqual(1, result['recordings'])
        self.assertNotIn('private', json.dumps(result))

    def test_healthy_primary_stores_pass_without_returning_data(self):
        result = audit.inspect_databases(['user_private/team_chat_db.json'],
                                        lambda _: b'{"recordings":[],"messages":["private"]}')
        self.assertEqual('passed', result['status'])
        self.assertEqual(0, result['recordings'])
        self.assertNotIn('private', json.dumps(result))
