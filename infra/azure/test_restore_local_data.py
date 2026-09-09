import copy
import unittest
from restore_local_data import merge_users


class MergeRecoveryTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
