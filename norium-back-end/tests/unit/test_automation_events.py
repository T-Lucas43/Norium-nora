import asyncio
import copy
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from app.core.request_context import current_workspace_id, set_request_context, reset_request_context
from app.core.tenant import write_user_db
from app.modules.automations import events


def flow(event_type='whatsapp.received'):
    return {'id': 'auto-1', 'active': True, 'flow': {'nodes': [{'kind': 'trigger', 'config': {
        'eventType': event_type, 'automatic': 'true', 'enabledAt': '2026-01-01T00:00:00+00:00'}},
        {'kind': 'action', 'title': 'Enviar WhatsApp', 'config': {'recipient': '5511999999999', 'message': 'Olá'}}]}}


def event():
    return {'id': 'evt-1', 'source': 'whatsapp', 'title': 'Nova mensagem', 'description': 'Preciso de orçamento',
            'timestamp': '2026-09-09T12:00:00+00:00', 'metadata': {'userId': 'u1', 'messageId': 'msg-1', 'fromMe': False, 'conversaId': '5511888888888@s.whatsapp.net'}}


class EventMatchingTests(unittest.TestCase):
    def test_opt_in_and_active_required(self):
        item = flow()
        self.assertTrue(events.matches(item, event()))
        item['active'] = False
        self.assertFalse(events.matches(item, event()))
        item['active'] = True
        item['flow']['nodes'][0]['config']['automatic'] = 'false'
        self.assertFalse(events.matches(item, event()))

    def test_approval_blocks_automatic_delivery(self):
        item = flow()
        item['variables'] = {'approvalRequired': 'true'}
        self.assertFalse(events.matches(item, event()))

    def test_outgoing_and_old_messages_ignored(self):
        incoming = event()
        incoming['metadata']['fromMe'] = True
        self.assertIsNone(events.event_type(incoming))
        incoming = event()
        incoming['timestamp'] = '2025-12-30T00:00:00Z'
        self.assertFalse(events.matches(flow(), incoming))

    def test_contact_and_text_filters(self):
        item = flow()
        item['flow']['nodes'][0]['config'].update(sourceId='5511888888888', contains='ORÇAMENTO')
        self.assertTrue(events.matches(item, event()))
        item['flow']['nodes'][0]['config']['sourceId'] = 'other'
        self.assertFalse(events.matches(item, event()))

    def test_team_source_filters_and_own_message(self):
        incoming = event()
        incoming.update(source='equipe')
        incoming['metadata'].update(action='team_message_created', senderId='ana', scope='subteam', subteamId='sales')
        item = flow('team.message')
        item['flow']['nodes'][0]['config'].update(scope='subteam', subteamId='sales')
        self.assertTrue(events.matches(item, incoming))
        incoming['metadata']['subteamId'] = 'private'
        self.assertFalse(events.matches(item, incoming))
        incoming['metadata']['senderId'] = 'u1'
        self.assertIsNone(events.event_type(incoming))

    def test_supported_module_events(self):
        for source, action, expected in [('kanban', 'task_created', 'task.created'), ('kanban', 'task_updated', 'task.updated'), ('kanban', 'task_comment_added', 'task.comment'), ('financeiro', 'finance_entry_created', 'finance.created'), ('financeiro', 'finance_entry_updated', 'finance.updated'), ('equipe', 'team_member_mentioned', 'team.mentioned')]:
            with self.subTest(action=action):
                self.assertEqual(events.event_type({'source': source, 'metadata': {'action': action, 'senderId': 'a', 'userId': 'b'}}), expected)
        self.assertEqual(events.event_type({'source': 'calendar', 'title': 'Compromisso criado'}), 'calendar.created')
        self.assertEqual(events.event_type({'source': 'calendar', 'title': 'Compromisso atualizado'}), 'calendar.updated')
        self.assertIsNone(events.event_type({'source': 'calendar', 'title': 'Compromisso no Google Agenda'}))
        self.assertEqual(events.event_type({'source': 'gmail', 'title': 'E-mail recebido', 'metadata': {'messageId': 'm'}}), 'gmail.received')


class EventQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'NORIUM_DATA_DIR': self.temp.name})
        self.env.start()
        self.tokens = set_request_context('test', 'primary')
        write_user_db('u1', 'automacoes', {'automations': [flow()], 'history': []})

    def tearDown(self):
        reset_request_context(self.tokens)
        self.env.stop()
        self.temp.cleanup()

    async def test_duplicate_business_message_is_only_queued_once(self):
        events.enqueue_event(event(), 'primary')
        duplicate = event()
        duplicate['id'] = 'different-webhook-delivery'
        events.enqueue_event(duplicate, 'primary')
        rows = events.recent_jobs('u1', 'primary')
        self.assertEqual(len(rows), 1)
        first, second = await asyncio.gather(asyncio.to_thread(events.claim_job), asyncio.to_thread(events.claim_job))
        self.assertEqual(sum(item is not None for item in (first, second)), 1)
        events.finish_job(rows[0]['id'], 'done')
        events.enqueue_event(duplicate, 'primary')
        self.assertIsNone(events.claim_job())

    async def test_lost_worker_is_not_retried_and_does_not_block_new_events(self):
        events.enqueue_event(event(), 'primary')
        old_job = events.claim_job()
        db = events.connection()
        with db:
            db.execute("UPDATE jobs SET lease_until=0 WHERE id=?", (old_job['id'],))
        db.close()
        new_event = event()
        new_event['metadata']['messageId'] = 'msg-2'
        events.enqueue_event(new_event, 'primary')
        next_job = events.claim_job()
        self.assertNotEqual(next_job['id'], old_job['id'])
        statuses = {item['id']: item['status'] for item in events.recent_jobs('u1', 'primary')}
        self.assertEqual(statuses[old_job['id']], 'interrupted')
        self.assertEqual(statuses[next_job['id']], 'running')

    async def test_tenant_and_workspace_isolation(self):
        events.enqueue_event(event(), 'primary')
        self.assertEqual(events.recent_jobs('other', 'primary'), [])
        self.assertEqual(events.recent_jobs('u1', 'other'), [])
        tokens = set_request_context('test', 'other')
        try:
            events.enqueue_event(event(), 'other')
            self.assertEqual(events.recent_jobs('u1', 'other'), [])
        finally:
            reset_request_context(tokens)

    async def test_automation_output_cannot_enqueue_more_jobs(self):
        token = events.automation_origin.set(True)
        try:
            await events.publish_event(event())
        finally:
            events.automation_origin.reset(token)
        self.assertEqual(events.recent_jobs('u1', 'primary'), [])

    async def test_worker_passes_event_and_preserves_context(self):
        events.enqueue_event(event(), 'primary')
        job = events.claim_job()
        async def execute(*args, **kwargs):
            self.assertEqual(current_workspace_id(), 'primary')
            self.assertTrue(events.automation_origin.get())
            self.assertEqual(kwargs['event']['metadata']['messageId'], 'msg-1')
            return {'historyItem': {'status': 'sucesso'}}
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={'users': [{'id': 'u1', 'status': 'ativo'}]})), patch('app.routers.auth_router.assert_route_permissions'), patch('app.modules.automations.router.execute_automation', AsyncMock(side_effect=execute)) as run:
            await events.process_job(job)
            run.assert_awaited_once()
        self.assertEqual(events.recent_jobs('u1', 'primary')[0]['status'], 'done')
        self.assertFalse(events.automation_origin.get())

    async def test_edit_or_disable_cancels_queued_execution(self):
        events.enqueue_event(event(), 'primary')
        changed = flow()
        changed['active'] = False
        write_user_db('u1', 'automacoes', {'automations': [changed]})
        with patch('app.routers.auth_router.read_user_store', AsyncMock(return_value={'users': [{'id': 'u1', 'status': 'ativo'}]})), patch('app.routers.auth_router.assert_route_permissions'), patch('app.modules.automations.router.execute_automation', AsyncMock()) as run:
            await events.process_job(events.claim_job())
            run.assert_not_awaited()
        self.assertEqual(events.recent_jobs('u1', 'primary')[0]['status'], 'cancelled')

    async def test_record_event_hook_queues_real_events(self):
        from app.modules.inbox.router import record_event
        with patch('app.services.system_email.notify_event', AsyncMock()), patch('app.modules.inbox.router.manager.broadcast', AsyncMock()):
            await record_event(source='whatsapp', title='Nova mensagem', description='Olá', metadata=event()['metadata'], timestamp=event()['timestamp'], event_id='integration-event')
        self.assertEqual(len(events.recent_jobs('u1', 'primary')), 1)

if __name__ == '__main__':
    unittest.main()
