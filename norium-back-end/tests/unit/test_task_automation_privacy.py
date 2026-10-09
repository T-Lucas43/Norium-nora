import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path
from app.modules.auth import router as auth

from app.core.request_context import set_request_context, reset_request_context
from app.core.tenant import get_system_db_path, write_json_file, write_user_db
from app.modules.automations import events, router as automations
from app.modules.inbox import router as inbox
from app.modules.team import router as team
from app.services import task_store


class TaskAutomationPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        environment = patch.dict(os.environ, {
            'NORIUM_DATA_DIR': self.directory.name,
            'NORIUM_DATABASE_URL': '', 'NORIUM_POSTGRES_REQUIRED': '0',
        })
        environment.start()
        self.addCleanup(environment.stop)
        tokens = set_request_context('synthetic-test', 'primary')
        self.addCleanup(reset_request_context, tokens)
        self.users = [dict(id=uid, teamOwnerId=tid, status='ativo', nome=uid,
                           role='owner' if uid == tid else 'member', plan='equipe', teamChatEnabled=True,
                           permissions={'chat': True, 'tarefas': True, 'automacoes': True, 'integracao_whatsapp': True,
                                        'nora': True, 'emails': True, 'integracao_gmail': True})
                      for uid, tid in [('owner', 'owner'), ('collab', 'owner'),
                                       ('denied', 'owner'), ('outsider', 'outsider')]]
        user_path = Path(get_system_db_path('usuarios'))
        user_path_patch = patch.object(auth, 'USERS_DB_PATH', user_path)
        user_path_patch.start()
        self.addCleanup(user_path_patch.stop)
        write_json_file(user_path, {'users': self.users})
        task_store.create_project('owner', {'id': 'private', 'name': 'Synthetic private',
                                            'sharedUserIds': ['collab']})
        self.task = task_store.create_task('owner', {'projectId': 'private', 'title': 'Synthetic secret'})
        team.write_chat_store('owner', {'messages': []})
        self.sent = AsyncMock()
        for boundary in [patch.object(team.manager, 'send_to_users', self.sent),
                         patch.object(team.manager, 'broadcast', AsyncMock()),
                         patch('app.services.system_email.ready', return_value=False)]:
            boundary.start()
            self.addCleanup(boundary.stop)

    def store_automation(self, user_id='collab', *, actions=None, nodes=None):
        item = {'id': 'synthetic-auto', 'name': 'Synthetic private notice', 'active': True,
                'trigger': 'Tarefas', 'actions': actions or ['Notificar equipe'], 'variables': {},
                'flow': {'nodes': [{'id': 'trigger', 'kind': 'trigger', 'config': {
                    'eventType': 'task.updated', 'automatic': 'true',
                    'enabledAt': '2026-01-01T00:00:00+00:00'}}] + (nodes or []),
                    'connections': []}, 'logs': []}
        if nodes is None:
            item['flow']['nodes'].append({'id': 'notice', 'kind': 'action', 'title': 'Notificar equipe'})
        write_user_db(user_id, 'automacoes', {'automations': [item], 'history': []})
        return item

    def retained_job_status(self, job_id):
        db = events.connection()
        try:
            return db.execute('SELECT status FROM jobs WHERE id=?', (job_id,)).fetchone()['status']
        finally:
            db.close()

    async def queue_task_event(self, user_id='collab'):
        return await inbox.record_event(source='kanban', title='Synthetic task change',
                                        description='Synthetic secret', metadata={
                                            'userId': user_id, 'action': 'task_updated',
                                            'taskId': self.task['id'], 'projectId': 'private'})

    async def test_task_trigger_generic_notice_is_private_without_creating_a_task(self):
        self.store_automation()
        await self.queue_task_event()
        job = events.claim_job()
        self.assertIsNotNone(job)
        await events.process_job(job)
        self.assertEqual('done', events.recent_jobs('collab', 'primary')[0]['status'])
        for user in self.users:
            history = await team.list_messages(scope='team', recipientId=None, user=user)
            expected = 1 if user['id'] in {'owner', 'collab'} else 0
            self.assertEqual(expected, len(history['messages']), user['id'])
        self.assertEqual({'owner', 'collab'}, self.sent.await_args.args[1])
        team.manager.broadcast.assert_not_awaited()
        self.assertEqual(1, len(task_store.list_tasks('owner')['tasks']))


    async def test_revoked_source_cancels_queued_job_before_any_execution(self):
        self.store_automation()
        await self.queue_task_event()
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        job = events.claim_job()
        await events.process_job(job)
        self.assertEqual('cancelled', self.retained_job_status(job['id']))
        self.assertEqual([], (await automations.listar_eventos_automaticos(self.users[1]))['jobs'])
        self.assertEqual([], (await automations.listar_automacoes(self.users[1]))['history'])
        self.assertEqual([], (await team.list_messages(scope='team', recipientId=None, user=self.users[0]))['messages'])
        team.manager.broadcast.assert_not_awaited()
        self.sent.assert_not_awaited()


    async def test_completed_execution_history_and_inbox_recheck_current_project_access(self):
        self.store_automation()
        await self.queue_task_event()
        await events.process_job(events.claim_job())
        before = await automations.listar_automacoes(self.users[1])
        self.assertEqual(1, len(before['history']))
        self.assertEqual(1, len(before['automations'][0]['logs']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        after = await automations.listar_automacoes(self.users[1])
        self.assertEqual([], after['history'])
        self.assertEqual([], after['automations'][0]['logs'])
        self.assertEqual(0, after['metrics']['runsToday'])
        self.assertEqual(0, after['automations'][0]['executions'])
        self.assertNotEqual(automations.read_store('collab')['updatedAt'], after['updatedAt'])
        self.assertIsNone(after['automations'][0]['lastRunAt'])
        self.assertEqual([], await inbox.read_events('collab'))
        self.assertEqual(1, len(automations.read_store('collab')['history']))
        with self.assertRaises(Exception) as denied:
            await automations.reexecutar_automacao('synthetic-auto', before['history'][0]['id'], self.users[1])
        self.assertEqual(404, denied.exception.status_code)


    async def test_configured_team_message_from_task_uses_project_scope(self):
        self.store_automation(nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar mensagem',
                                     'config': {'actionType': 'send_team', 'scope': 'team',
                                                'message': 'Synthetic task occurred'}}])
        await self.queue_task_event()
        await events.process_job(events.claim_job())
        self.assertEqual('done', events.recent_jobs('collab', 'primary')[0]['status'])
        for user in self.users:
            history = await team.list_messages(scope='team', recipientId=None, user=user)
            self.assertEqual(1 if user['id'] in {'owner', 'collab'} else 0, len(history['messages']), user['id'])

    async def test_task_direct_message_rechecks_project_for_recipient_history(self):
        self.store_automation('owner', nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar mensagem',
                                              'config': {'actionType': 'send_team', 'scope': 'direct',
                                                         'recipientId': 'collab', 'message': 'Synthetic task occurred'}}])
        await self.queue_task_event('owner')
        await events.process_job(events.claim_job())
        self.assertEqual('done', events.recent_jobs('owner', 'primary')[0]['status'])
        history = await team.list_messages(scope='direct', recipientId='owner', user=self.users[1])
        self.assertEqual(1, len(history['messages']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        after = await team.list_messages(scope='direct', recipientId='owner', user=self.users[1])
        self.assertEqual([], after['messages'])
        self.assertEqual([], await inbox.read_events('collab'))


    async def test_task_trigger_whatsapp_fails_closed_without_verifiable_project_recipient(self):
        self.store_automation(nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar WhatsApp',
                                     'config': {'actionType': 'send_whatsapp', 'recipientMode': 'number',
                                                'recipient': '5511999999999', 'message': 'Synthetic task occurred'}}])
        await self.queue_task_event()
        with patch('app.modules.chat.router.enviar_mensagem', AsyncMock()) as external_send:
            await events.process_job(events.claim_job())
            external_send.assert_not_awaited()
        job = events.recent_jobs('collab', 'primary')[0]
        self.assertEqual('failed', job['status'])
        history = (await automations.listar_automacoes(self.users[1]))['history']
        self.assertIn('destinatario verificavel', history[0]['error'])
        self.assertNotIn('Synthetic secret', history[0]['error'])

    async def test_missing_scope_and_deleted_update_cannot_execute(self):
        self.store_automation()
        event = await self.queue_task_event()
        task_store.delete_task('owner', self.task['id'])
        await events.process_job(events.claim_job())
        self.assertEqual('cancelled', events.recent_jobs('collab', 'primary')[0]['status'])
        self.assertEqual([], (await team.list_messages(scope='team', recipientId=None, user=self.users[0]))['messages'])
        event['metadata']['taskProjects'] = []
        with self.assertRaises(ValueError):
            await automations.execute_automation('collab', 'synthetic-auto', event=event)

    async def test_task_deletion_is_not_an_automatic_trigger_and_snapshot_remains_authorized(self):
        event = await self.queue_task_event()
        event['metadata']['action'] = 'task_deleted'
        task_store.delete_task('owner', self.task['id'])
        self.assertIsNone(events.event_type(event))
        self.assertEqual([{'ownerId': 'owner', 'projectId': 'private'}], events.task_event_projects(event, 'collab'))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        with self.assertRaises(ValueError):
            events.task_event_projects(event, 'collab')


    async def test_task_creation_cannot_expand_private_source_audience(self):
        task_store.create_project('owner', {'id': 'destination', 'name': 'Synthetic destination',
                                            'sharedUserIds': ['collab', 'denied']})
        item = self.store_automation(nodes=[{'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'},
                                           {'id': 'notice', 'kind': 'action', 'title': 'Notificar equipe'}])
        item['variables'] = {'taskProjectId': 'destination'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        await self.queue_task_event()
        await events.process_job(events.claim_job())
        self.assertEqual('failed', events.recent_jobs('collab', 'primary')[0]['status'])
        self.assertEqual(1, len(task_store.list_tasks('owner')['tasks']))
        self.assertEqual([], (await team.list_messages(scope='team', recipientId=None, user=self.users[2]))['messages'])
        history = (await automations.listar_automacoes(self.users[1]))['history']
        self.assertIn('amplia o publico', history[0]['error'])
        self.sent.assert_not_awaited()

    async def test_authorized_created_task_activity_requires_source_and_destination_projects(self):
        task_store.create_project('owner', {'id': 'destination', 'name': 'Synthetic destination',
                                            'sharedUserIds': ['collab']})
        item = self.store_automation(nodes=[{'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'},
                                           {'id': 'notice', 'kind': 'action', 'title': 'Notificar equipe'}])
        item['variables'] = {'taskProjectId': 'destination'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        original = await self.queue_task_event()
        await events.process_job(events.claim_job())
        self.assertEqual('done', events.recent_jobs('collab', 'primary')[0]['status'])
        self.assertEqual(2, len(task_store.list_tasks('owner')['tasks']))
        for call in self.sent.await_args_list:
            self.assertEqual({'owner', 'collab'}, call.args[1])
        task_store.update_project('owner', 'destination', {'sharedUserIds': []})
        self.assertEqual([], (await automations.listar_automacoes(self.users[1]))['history'])
        self.assertEqual([original['id']], [item['id'] for item in await inbox.read_events('collab')])

    async def test_uncertain_task_creation_preserves_scope_before_mutation(self):
        item = self.store_automation(nodes=[{'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'}])
        item['variables'] = {'taskProjectId': 'private'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        self.sent.side_effect = OSError('Synthetic transport unavailable')
        result = await automations.execute_automation('collab', 'synthetic-auto')
        self.assertEqual('erro', result['historyItem']['status'])
        self.assertEqual(2, len(task_store.list_tasks('owner')['tasks']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        self.assertEqual([], (await automations.listar_automacoes(self.users[1]))['history'])
        self.assertEqual([], await inbox.read_events('collab'))
        self.assertEqual(1, len(automations.read_store('collab')['history']))


    async def test_task_direct_and_subteam_destinations_require_every_participant(self):
        for scope, destination in [('direct', 'denied'), ('direct', 'outsider'), ('subteam', 'synthetic-subteam')]:
            with self.subTest(scope=scope, destination=destination):
                team.write_chat_store('owner', {'messages': [], 'subteams': [{
                    'id': 'synthetic-subteam', 'name': 'Synthetic', 'createdBy': 'owner',
                    'memberIds': ['owner', 'collab', 'denied']}]})
                self.store_automation(nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar mensagem',
                                             'config': {'actionType': 'send_team', 'scope': scope,
                                                        'recipientId': destination, 'message': 'Synthetic task occurred'}}])
                await self.queue_task_event()
                await events.process_job(events.claim_job())
                self.assertEqual('failed', events.recent_jobs('collab', 'primary')[0]['status'])
                self.assertEqual([], (await team.list_messages(scope='team', recipientId=None, user=self.users[0]))['messages'])
                self.sent.assert_not_awaited()

    async def test_authorized_subteam_message_retains_scope_after_revocation(self):
        team.write_chat_store('owner', {'messages': [], 'subteams': [{
            'id': 'synthetic-subteam', 'name': 'Synthetic', 'createdBy': 'owner',
            'memberIds': ['owner', 'collab']}]})
        self.store_automation(nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar mensagem',
                                     'config': {'actionType': 'send_team', 'scope': 'subteam',
                                                'recipientId': 'synthetic-subteam', 'message': 'Synthetic task occurred'}}])
        await self.queue_task_event()
        await events.process_job(events.claim_job())
        self.assertEqual('done', events.recent_jobs('collab', 'primary')[0]['status'])
        self.assertEqual({'owner', 'collab'}, self.sent.await_args.args[1])
        self.assertEqual(1, len((await team.list_subteam_messages('synthetic-subteam', self.users[1]))['messages']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        self.assertEqual([], (await team.list_subteam_messages('synthetic-subteam', self.users[1]))['messages'])

    async def test_task_permission_or_team_revocation_cancels_queued_event(self):
        for change in ('module', 'team'):
            with self.subTest(change=change):
                write_json_file(auth.USERS_DB_PATH, {'users': self.users})
                self.store_automation()
                await self.queue_task_event()
                users = [dict(item, permissions=dict(item['permissions'])) for item in self.users]
                if change == 'module':
                    users[1]['permissions']['tarefas'] = False
                else:
                    users[1]['teamOwnerId'] = 'outsider'
                write_json_file(auth.USERS_DB_PATH, {'users': users})
                job = events.claim_job()
                await events.process_job(job)
                self.assertEqual('cancelled', self.retained_job_status(job['id']))
                self.assertEqual([], (await automations.listar_eventos_automaticos(self.users[1]))['jobs'])
                self.assertEqual([], automations.read_store('collab')['history'])
                self.sent.assert_not_awaited()

    async def test_non_task_automation_keeps_external_messaging_support(self):
        item = self.store_automation(nodes=[{'id': 'send', 'kind': 'action', 'title': 'Enviar WhatsApp',
                                            'config': {'actionType': 'send_whatsapp', 'recipientMode': 'number',
                                                       'recipient': '5511999999999', 'message': 'Synthetic ordinary event'}}])
        with patch('app.modules.chat.router.enviar_mensagem', AsyncMock()) as send:
            result = await automations.execute_automation('collab', item['id'])
        self.assertEqual('sucesso', result['historyItem']['status'])
        self.assertEqual(1, send.await_count)

    async def test_retry_keeps_origin_and_never_repeats_completed_task_creation(self):
        item = self.store_automation(nodes=[{'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'},
                                           {'id': 'notice', 'kind': 'action', 'title': 'Notificar equipe'}])
        item['variables'] = {'taskProjectId': 'private'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        source = await self.queue_task_event()
        first = await automations.execute_automation('collab', item['id'], event=source)
        stored = automations.read_store('collab')
        for log in [stored['history'][0], stored['automations'][0]['logs'][0]]:
            log['status'] = 'erro'
        automations.write_store('collab', stored)
        second = await automations.reexecutar_automacao(item['id'], first['historyItem']['id'], self.users[1])
        self.assertEqual(source['id'], second['lastExecution']['historyItem']['input']['event']['id'])
        self.assertEqual(2, len(task_store.list_tasks('owner')['tasks']))
        self.assertEqual(2, self.sent.await_count)

    async def test_reconciliation_cannot_reveal_or_mutate_revoked_execution(self):
        item = self.store_automation(nodes=[{'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'}])
        item['variables'] = {'taskProjectId': 'private'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        self.sent.side_effect = OSError('Synthetic transport unavailable')
        first = await automations.execute_automation('collab', item['id'])
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        with self.assertRaises(Exception) as denied:
            await automations.reconcile_automation_effect(item['id'], first['historyItem']['id'], 'task:create',
                automations.EffectReconciliationPayload(outcome='completed', note='Synthetic reconciliation'), self.users[1])
        self.assertEqual(404, denied.exception.status_code)
        persisted = automations.read_store('collab')['history'][0]
        self.assertEqual('uncertain', persisted['effectCheckpoints']['task:create']['status'])

    async def test_legacy_execution_with_missing_task_scope_stays_hidden(self):
        item = self.store_automation()
        legacy = {'id': 'synthetic-legacy', 'automationId': item['id'], 'timestamp': '2026-10-09T00:00:00+00:00',
                  'input': {'event': {'source': 'kanban', 'metadata': {'action': 'task_updated', 'taskId': self.task['id']}}},
                  'effectCheckpoints': {}, 'result': 'Synthetic private old result'}
        item['logs'] = [legacy]
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': [legacy]})
        response = await automations.listar_automacoes(self.users[1])
        self.assertEqual([], response['history'])
        self.assertEqual([], response['automations'][0]['logs'])
        self.assertEqual(1, len(automations.read_store('collab')['history']))


    async def test_public_queue_hides_revoked_history_and_keeps_server_evidence(self):
        self.store_automation()
        await self.queue_task_event()
        job = events.claim_job()
        await events.process_job(job)
        self.assertEqual(1, len((await automations.listar_eventos_automaticos(self.users[1]))['jobs']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        self.assertEqual([], (await automations.listar_eventos_automaticos(self.users[1]))['jobs'])
        self.assertEqual('done', self.retained_job_status(job['id']))

    async def test_email_grouping_trigger_notification_keeps_task_origin_scope(self):
        self.store_automation(nodes=[{'id': 'group', 'kind': 'action', 'title': 'Agrupar e-mails'}])
        await self.queue_task_event()
        with patch.object(automations, 'GmailService') as gmail:
            gmail.return_value.list_messages.return_value = {'messages': [{
                'id': 'synthetic-mail', 'subject': 'Synthetic commercial proposal',
                'fromName': 'Synthetic sender', 'labels': []}]}
            await events.process_job(events.claim_job())
        self.assertEqual('done', events.recent_jobs('collab', 'primary')[0]['status'])
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        self.assertEqual([], await inbox.read_events('collab'))
        after = await automations.listar_automacoes(self.users[1])
        self.assertNotIn('lastEmailGrouping', after['automations'][0]['variables'])
        self.assertNotIn('lastEmailGroupingSummary', after['automations'][0]['variables'])
        with self.assertRaises(Exception) as blocked:
            await automations.executar_automacao('synthetic-auto', self.users[1])
        self.assertEqual(403, blocked.exception.status_code)
        self.assertIn('lastEmailGrouping', automations.read_store('collab')['automations'][0]['variables'])


    async def test_private_runtime_values_inherit_scope_on_manual_run_and_stay_durable(self):
        item = self.store_automation()
        ref = {'ownerId': 'owner', 'projectId': 'private'}
        item['variables'] = {'lastModelOutput': 'Synthetic private output', 'taskCategory': 'ordinary-config'}
        item['variableTaskProjects'] = {'lastModelOutput': [ref]}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        result = await automations.execute_automation('collab', item['id'])
        self.assertEqual([ref], result['historyItem']['taskProjects'])
        self.assertNotIn('variableTaskProjects', result['automation'])
        for user in self.users:
            history = await team.list_messages(scope='team', recipientId=None, user=user)
            self.assertEqual(1 if user['id'] in {'owner', 'collab'} else 0, len(history['messages']))
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        with self.assertRaises(Exception) as denied:
            await automations.simular_automacao(item['id'], self.users[1])
        self.assertEqual(403, denied.exception.status_code)
        self.assertEqual('Synthetic private output', automations.read_store('collab')['automations'][0]['variables']['lastModelOutput'])

    async def test_legacy_runtime_provenance_is_conservative_and_public_outputs_still_work(self):
        item = self.store_automation()
        item['variables'] = {'lastModelOutput': 'Synthetic retained output'}
        legacy = {'id': 'legacy-output', 'automationId': item['id'], 'input': {'event': {
            'metadata': {'action': 'task_updated', 'taskId': self.task['id']}}},
            'effectCheckpoints': {'model:run': {'status': 'succeeded', 'result': {
                'variableUpdates': {'lastModelOutput': 'Synthetic retained output'}}}}}
        item['logs'] = [legacy]
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': [legacy]})
        response = await automations.listar_automacoes(self.users[1])
        self.assertNotIn('lastModelOutput', response['automations'][0]['variables'])
        with self.assertRaises(Exception) as denied:
            await automations.execute_automation('collab', item['id'])
        self.assertEqual(403, denied.exception.status_code)
        item['logs'] = []
        item['variableTaskProjects'] = {'lastModelOutput': []}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        response = await automations.execute_automation('collab', item['id'])
        self.assertEqual('Synthetic retained output', response['automation']['variables']['lastModelOutput'])
        self.assertNotIn('taskProjects', response['historyItem'])

    async def test_snapshots_clone_restore_and_legacy_inputs_never_strip_private_provenance(self):
        item = self.store_automation()
        ref = {'ownerId': 'owner', 'projectId': 'private'}
        item['variables'] = {'lastModelOutput': 'Synthetic private output', 'taskCategory': 'ordinary-config'}
        item['variableTaskProjects'] = {'lastModelOutput': [ref]}
        legacy_version = {'id': 'old-version', 'version': 1, 'content': dict(item)}
        item['versions'] = [legacy_version]
        legacy_log = {'id': 'ordinary-log', 'automationId': item['id'], 'timestamp': '2026-10-09T00:00:00+00:00',
                      'input': {'variables': dict(item['variables'])}}
        item['logs'] = [legacy_log]
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': [legacy_log]})
        snapshot = automations.automation_snapshot(item)
        self.assertEqual({'taskCategory': 'ordinary-config'}, snapshot['content']['variables'])
        self.assertNotIn('variableTaskProjects', snapshot['content'])
        task_store.update_project('owner', 'private', {'sharedUserIds': []})
        response = await automations.listar_automacoes(self.users[1])
        self.assertNotIn('lastModelOutput', response['history'][0]['input']['variables'])
        self.assertNotIn('variableTaskProjects', response['automations'][0])
        versions = await automations.listar_versoes_automacao(item['id'], self.users[1])
        self.assertEqual({'taskCategory': 'ordinary-config'}, versions['versions'][0]['content']['variables'])
        self.assertNotIn('variableTaskProjects', versions['versions'][0]['content'])
        await automations.duplicar_automacao(item['id'], self.users[1])
        stored = automations.read_store('collab')
        clone = next(auto for auto in stored['automations'] if auto['id'] != item['id'])
        self.assertEqual({'taskCategory': 'ordinary-config'}, clone['variables'])
        await automations.restaurar_versao_automacao(item['id'], 'old-version', automations.AutomationRestorePayload(), self.users[1])
        retained = automations.find_automation(automations.read_store('collab'), item['id'])
        self.assertEqual('Synthetic private output', retained['variables']['lastModelOutput'])
        self.assertEqual([ref], retained['variableTaskProjects']['lastModelOutput'])
        with self.assertRaises(Exception) as denied:
            await automations.execute_automation('collab', item['id'])
        self.assertEqual(403, denied.exception.status_code)


    async def test_destination_audience_is_rechecked_after_an_await_before_task_creation(self):
        task_store.create_project('owner', {'id': 'destination', 'name': 'Synthetic destination', 'sharedUserIds': ['collab']})
        item = self.store_automation(nodes=[
            {'id': 'send', 'kind': 'action', 'title': 'Chat da Equipe', 'config': {
                'actionType': 'send_team', 'scope': 'team', 'message': 'Synthetic scoped notice'}},
            {'id': 'create', 'kind': 'action', 'title': 'Criar tarefa'}])
        item['variables'] = {'taskProjectId': 'destination'}
        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
        source = await self.queue_task_event()
        async def change_audience(*args, **kwargs):
            task_store.update_project('owner', 'destination', {'sharedUserIds': ['collab', 'denied']})
        self.sent.side_effect = change_audience
        result = await automations.execute_automation('collab', item['id'], event=source)
        self.assertEqual('erro', result['historyItem']['status'])
        self.assertIn('amplia o publico', result['historyItem']['error'])
        self.assertEqual('retryable', result['historyItem']['effectCheckpoints']['task:create']['status'])
        self.assertEqual(1, len(task_store.list_tasks('owner')['tasks']))
        denied = await team.list_messages(scope='team', recipientId=None, user=self.users[2])
        self.assertEqual([], denied['messages'])


    async def test_task_origin_cannot_delegate_work_to_modules_without_project_scope(self):
        for title in ['Preparar leitura paginada de e-mails', 'Agente Navegador']:
            for provenance in ['event', 'variable']:
                with self.subTest(title=title, provenance=provenance):
                    item = self.store_automation(nodes=[{'id': 'delegate', 'kind': 'action', 'title': title,
                                                         'config': {'targetUrl': 'https://example.com'}}])
                    source = None
                    if provenance == 'event':
                        source = await self.queue_task_event()
                    else:
                        item['variables'] = {'lastModelOutput': 'Synthetic retained private output'}
                        item['variableTaskProjects'] = {'lastModelOutput': [{'ownerId': 'owner', 'projectId': 'private'}]}
                        write_user_db('collab', 'automacoes', {'automations': [item], 'history': []})
                    with patch('app.modules.mail.productivity.create', AsyncMock()) as work, patch(
                        'app.modules.intelligence.service.create_browser_plan', AsyncMock()) as plan, patch(
                        'app.modules.intelligence.browser_runtime.queue_browser_run', AsyncMock()) as queue:
                        result = await automations.execute_automation('collab', item['id'], event=source)
                    self.assertEqual('erro', result['historyItem']['status'])
                    self.assertIn('operacao delegada bloqueada', result['historyItem']['error'])
                    self.assertEqual({}, result['historyItem']['effectCheckpoints'])
                    work.assert_not_awaited()
                    plan.assert_not_awaited()
                    queue.assert_not_awaited()

    async def test_unrelated_automation_can_still_delegate_mail_and_browser_work(self):
        for title in ['Preparar leitura paginada de e-mails', 'Agente Navegador']:
            with self.subTest(title=title):
                item = self.store_automation(nodes=[{'id': 'delegate', 'kind': 'action', 'title': title,
                                                     'config': {'targetUrl': 'https://example.com'}}])
                with patch('app.modules.mail.productivity.create', AsyncMock(return_value={'id': 'synthetic-work'})) as work, patch(
                    'app.modules.intelligence.service.create_browser_plan', AsyncMock(return_value={'id': 'synthetic-plan'})) as plan, patch(
                    'app.modules.intelligence.browser_runtime.queue_browser_run', AsyncMock()) as queue:
                    result = await automations.execute_automation('collab', item['id'])
                self.assertEqual('sucesso', result['historyItem']['status'])
                self.assertEqual(1 if title.startswith('Preparar') else 0, work.await_count)
                self.assertEqual(1 if title == 'Agente Navegador' else 0, plan.await_count)
                self.assertEqual(1 if title == 'Agente Navegador' else 0, queue.await_count)


if __name__ == '__main__':
    unittest.main()
