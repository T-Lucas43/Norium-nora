import copy
import unittest
import json
from restore_local_data import align_package, merge_users


class MergeRecoveryTests(unittest.TestCase):
    def test_plans_are_identified_by_code(self):
        result = merge_users({'users': [], 'plans': [{'code': 'free', 'name': 'Current'}]}, {'users': [], 'plans': [{'code': 'free', 'name': 'Old'}, {'code': 'paid', 'name': 'Paid'}]})
        self.assertEqual(result['plans'], [{'code': 'free', 'name': 'Current'}, {'code': 'paid', 'name': 'Paid'}])

    def test_existing_records_and_unavailable_password_are_preserved(self):
        remote = {'users': [{'id': 'a', 'email': 'a@test.invalid', 'passwordHash': 'current', 'extra': 1}], 'teams': [], 'plans': []}
        original = copy.deepcopy(remote)
        result = merge_users(remote, {'users': [{'id': 'a', 'email': 'a@test.invalid', 'passwordHash': ''}]})
        self.assertEqual(result['users'], remote['users'])
        self.assertEqual(remote, original)

    def test_recovered_password_invalidates_old_sessions(self):
        result = merge_users({'users': [{'id': 'a', 'email': 'a@test.invalid', 'passwordHash': 'wrong', 'sessionVersion': 2}]}, {'users': [{'id': 'a', 'email': 'a@test.invalid', 'passwordHash': 'recovered'}]})
        self.assertEqual(result['users'][0]['passwordHash'], 'recovered')
        self.assertEqual(result['users'][0]['sessionVersion'], 3)

    def test_missing_user_does_not_receive_a_fabricated_password(self):
        result = merge_users({'users': []}, {'users': [{'id': 'a', 'email': 'a@test.invalid', 'passwordHash': ''}]})
        self.assertEqual(result['users'][0]['passwordHash'], '')

    def test_identity_collisions_block_restore(self):
        for source in [{'id': 'a', 'email': 'other@test.invalid'}, {'id': 'b', 'email': 'a@test.invalid'}]:
            with self.assertRaisesRegex(RuntimeError, 'identity_conflict'):
                merge_users({'users': [{'id': 'a', 'email': 'a@test.invalid'}]}, {'users': [source]})

    def test_matching_email_keeps_destination_identity_password_and_references(self):
        remote = {'users': [{'id': 'new', 'email': 'a@test.invalid', 'passwordHash': 'current'}]}
        source = {'users': [{'id': 'old', 'email': 'a@test.invalid', 'passwordHash': ''}], 'teams': [{'id': 'old', 'ownerUserId': 'old'}]}
        incoming, files, mapping = align_package(remote, source, {'user_old/example_db.json': b'{"ownerUserId":"old"}'})
        self.assertEqual(mapping, {'old': 'new'})
        self.assertEqual(json.loads(files['user_new/example_db.json']), {'ownerUserId': 'new'})
        result = merge_users(remote, incoming)
        self.assertEqual(len(result['users']), 1)
        self.assertEqual(result['users'][0]['passwordHash'], 'current')
        self.assertEqual(result['teams'][0]['ownerUserId'], 'new')


if __name__ == '__main__':
    unittest.main()
