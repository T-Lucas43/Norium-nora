import unittest
import copy
from unittest.mock import AsyncMock, patch
from app.modules.automations.router import apply_automation_effects

ACTOR = {"id": "owner", "status": "ativo", "nome": "Owner"}

def automation(kind, **config):
    return {"name": "Test", "actions": [], "flow": {"nodes": [{"id": "send", "kind": "action", "title": "Enviar mensagem", "config": {"actionType": kind, "message": "Olá", **config}}]}}

class MessageActionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_whatsapp_uses_owner_and_normalized_number(self):
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={"users": [ACTOR]})), patch('app.modules.chat.router.assert_channel_permission') as permission, patch('app.modules.chat.router.enviar_mensagem', AsyncMock()) as send:
            effects = await apply_automation_effects('owner', automation('send_whatsapp', recipientMode='number', recipient='+55 (11) 99999-9999'))
            payload, actor = send.await_args.args
            self.assertEqual(payload.conversa_id, '5511999999999')
            self.assertEqual(payload.texto, 'Olá')
            self.assertEqual(actor, ACTOR)
            permission.assert_called_once_with(ACTOR, 'whatsapp')
            self.assertEqual(len(effects), 1)

    async def test_invalid_number_never_sends(self):
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={"users": [ACTOR]})), patch('app.modules.chat.router.assert_channel_permission'), patch('app.modules.chat.router.enviar_mensagem', AsyncMock()) as send:
            with self.assertRaises(ValueError):
                await apply_automation_effects('owner', automation('send_whatsapp', recipientMode='number', recipient='abc'))
            send.assert_not_awaited()

    async def test_direct_recipient_is_checked_and_preserved(self):
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={"users": [ACTOR]})), patch('app.modules.team.router.require_team_chat'), patch('app.modules.team.router.read_chat_store', return_value={}), patch('app.modules.team.router.thread_participant_ids', AsyncMock()) as access, patch('app.modules.team.router.send_message', AsyncMock()) as send:
            await apply_automation_effects('owner', automation('send_team', scope='direct', recipientId='ana'))
            self.assertEqual(access.await_args.args[2:], ('direct', 'ana', None))
            self.assertEqual(send.await_args.args[0].recipientId, 'ana')
            self.assertEqual(send.await_args.args[0].scope, 'direct')

    async def test_subteam_denied_never_sends(self):
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={"users": [ACTOR]})), patch('app.modules.team.router.require_team_chat'), patch('app.modules.team.router.read_chat_store', return_value={}), patch('app.modules.team.router.thread_participant_ids', AsyncMock(side_effect=ValueError('Forbidden'))), patch('app.modules.team.router.send_subteam_message', AsyncMock()) as send:
            with self.assertRaises(ValueError):
                await apply_automation_effects('owner', automation('send_team', scope='subteam', recipientId='other-team'))
            send.assert_not_awaited()

class ExecutionRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_trigger_text_does_not_create_unconfigured_task(self):
        item = {'name': 'Ao criar tarefa enviar aviso', 'trigger': 'Criar tarefa', 'actions': ['Mostrar notificacao'], 'flow': {'nodes': [{'kind': 'trigger', 'title': 'Criar tarefa'}, {'kind': 'action', 'title': 'Mostrar notificacao'}]}}
        with patch('app.modules.automations.router.create_task') as create:
            await apply_automation_effects('owner', item)
            create.assert_not_called()

    async def test_edit_during_execution_is_preserved(self):
        from app.modules.automations.router import execute_automation
        item = {'id': 'a', 'name': 'Original', 'active': True, 'flow': {'nodes': []}, 'variables': {}, 'logs': [], 'executions': 0}
        stored = {'automations': [item], 'history': []}
        async def effect(*args):
            stored['automations'][0]['active'] = False
            stored['automations'][0]['name'] = 'Editada durante envio'
            return ['Mensagem enviada']
        def write(user_id, value):
            stored.clear()
            stored.update(copy.deepcopy(value))
        with patch('app.modules.automations.router.read_store', side_effect=lambda user: copy.deepcopy(stored)), patch('app.modules.automations.router.write_store', side_effect=write), patch('app.modules.automations.router.apply_automation_effects', AsyncMock(side_effect=effect)), patch('app.modules.automations.router.record_event', AsyncMock()):
            await execute_automation('owner', 'a')
        self.assertFalse(stored['automations'][0]['active'])
        self.assertEqual(stored['automations'][0]['name'], 'Editada durante envio')
        self.assertEqual(stored['automations'][0]['executions'], 1)
        self.assertEqual(len(stored['history']), 1)

if __name__ == '__main__':
    unittest.main()
