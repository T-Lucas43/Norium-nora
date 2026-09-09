import copy
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.modules.auth import router as auth


class TeamRoleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = {'id': 'owner-role-test', 'nome': 'Owner', 'role': 'owner', 'plan': 'enterprise', 'permissions': dict(auth.OWNER_PERMISSIONS)}
        self.member = {'id': 'member-role-test', 'nome': 'Member', 'role': 'member', 'plan': 'enterprise', 'teamOwnerId': self.owner['id'], 'permissions': dict(auth.DEFAULT_MEMBER_PERMISSIONS)}
        self.store = {'users': [self.owner, self.member], 'teamRoles': []}
        self.reader = patch.object(auth, 'read_user_store', AsyncMock(side_effect=lambda: copy.deepcopy(self.store)))
        async def write(value): self.store = copy.deepcopy(value)
        self.writer = patch.object(auth, 'write_user_store', AsyncMock(side_effect=write))
        self.reader.start(); self.writer.start()
        self.addCleanup(self.reader.stop); self.addCleanup(self.writer.stop)

    async def test_create_assign_and_reapply_role_copies_permissions(self):
        role = (await auth.create_team_role(auth.TeamRolePayload(name='Operações', permissions={'tarefas': True, 'relatorios': True, 'nora': True, 'admin': True}), self.owner))['role']
        self.assertFalse(role['permissions']['admin'])
        result = (await auth.update_user(self.member['id'], auth.UpdateUserPayload(jobRoleId=role['id']), self.owner))['user']
        self.assertEqual(result['jobTitle'], 'Operações')
        self.assertTrue(result['permissions']['relatorios'])
        self.assertFalse(result['permissions']['emails'])
        await auth.update_team_role(role['id'], auth.TeamRolePayload(name='Operações', permissions={'tarefas': True}), self.owner)
        self.assertTrue(self.store['users'][1]['permissions']['relatorios'])
        result = (await auth.update_user(self.member['id'], auth.UpdateUserPayload(jobRoleId=role['id']), self.owner))['user']
        self.assertFalse(result['permissions']['relatorios'])

    async def test_cross_team_assignment_and_admin_changes_are_rejected_atomically(self):
        role = (await auth.create_team_role(auth.TeamRolePayload(name='Operações', permissions={'tarefas': True}), self.owner))['role']
        self.store['teamRoles'][0]['teamId'] = 'another-team'
        before = copy.deepcopy(self.store)
        with self.assertRaises(HTTPException):
            await auth.update_user(self.member['id'], auth.UpdateUserPayload(jobRoleId=role['id'], nome='Must not persist'), self.owner)
        self.assertEqual(self.store, before)
        self.store['teamRoles'][0]['teamId'] = self.owner['id']
        self.store['users'][1]['systemAdmin'] = True
        with self.assertRaises(HTTPException):
            auth.apply_job_role(self.store, self.store['users'][1], role['id'], self.owner)

    async def test_duplicate_role_and_unauthorized_creation_rejected(self):
        payload = auth.TeamRolePayload(name='Operações', permissions={'tarefas': True})
        await auth.create_team_role(payload, self.owner)
        with self.assertRaises(HTTPException) as error:
            await auth.create_team_role(payload, self.owner)
        self.assertEqual(error.exception.status_code, 409)
        with self.assertRaises(HTTPException) as error:
            await auth.create_team_role(payload, self.member)
        self.assertEqual(error.exception.status_code, 403)
