import io
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from pypdf import PdfReader

from app.modules.reports import router as reports
from app.modules.reports.nora_export import generate_chat_report
from app.modules.reports.pdf import render_report
from app.modules.auth.router import OWNER_PERMISSIONS, current_user
from tests.unit.test_reports_analysis import payload, valid_analysis


def document():
    result = payload().report.model_dump()
    result['tables'] = [{'id': 'entries', 'title': 'Lançamentos', 'columns': [{'label': 'Descrição', 'width': 75}, {'label': 'Valor', 'width': 25}], 'rows': [{'id': str(i), 'cells': [f'Despesa operacional {i}', 'R$ 200,00']} for i in range(100)]}]
    return result


class ReportsPdfTests(unittest.IsolatedAsyncioTestCase):
    async def test_pdf_contains_all_rows_comments_and_repeated_header(self):
        pdf = render_report(document(), {'comments': 'Revisar vencimentos.', 'includeAnalysis': True}, valid_analysis())
        pages = PdfReader(io.BytesIO(pdf)).pages
        text = '\n'.join(page.extract_text() for page in pages)
        self.assertGreater(len(pages), 1)
        for expected in ('Despesa operacional 99', 'Revisar vencimentos.', 'Saídas superiores às entradas', 'Critérios e notas'):
            self.assertIn(expected, text)
        self.assertTrue(all('NORIUM' in page.extract_text() for page in pages))

    async def test_pdf_api_rejects_missing_analysis_and_invalid_structure(self):
        app = FastAPI(); app.include_router(reports.router)
        app.dependency_overrides[current_user] = lambda: {'id': 'pdf-test', 'role': 'owner', 'permissions': dict(OWNER_PERMISSIONS), 'plan': 'enterprise'}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            for body in ({'report': {}, 'options': {}}, {'report': document(), 'options': {}}, {'report': document(), 'options': {}, 'analysis': {'summary': 'invalid'}}):
                response = await client.post('/api/relatorios/pdf', json=body)
                self.assertEqual(response.status_code, 422, response.text)
            analysis = valid_analysis(); analysis['limitations'] *= 10
            response = await client.post('/api/relatorios/pdf', json={'report': document(), 'options': {}, 'analysis': analysis})
            self.assertEqual(response.status_code, 200, response.text[:100])
            self.assertTrue(response.content.startswith(b'%PDF'))
        app.dependency_overrides.clear()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/relatorios/pdf', json={'report': document(), 'options': {'includeAnalysis': False}})
            self.assertIn(response.status_code, (401, 403))

    async def test_chat_uses_shared_renderer_and_analysis_before_saving(self):
        user = {'id': 'pdf-test', 'role': 'owner', 'permissions': dict(OWNER_PERMISSIONS), 'plan': 'enterprise'}
        entries = {'lancamentos': [{'title': 'Teste', 'status': 'pago', 'type': 'entrada', 'amount': 50}]}
        with patch('app.services.finance_store.list_finance', return_value=entries), patch('app.modules.reports.nora_export.analyze_report', AsyncMock(return_value={'item': valid_analysis()})) as analyze, patch('app.modules.reports.nora_export.render_report', return_value=b'%PDF-test') as render, patch('app.services.nora_files.save_bytes', return_value={'id': 'file'}) as save:
            result = await generate_chat_report(user, user['id'], 'Gere relatório financeiro em PDF')
            self.assertEqual(result['files'], [{'id': 'file'}])
            analyze.assert_awaited_once()
            self.assertEqual(render.call_args.args[2], valid_analysis())
            self.assertEqual(save.call_args.args[1], b'%PDF-test')
            analyze.side_effect = RuntimeError('provider unavailable')
            save.reset_mock()
            with self.assertRaises(RuntimeError):
                await generate_chat_report(user, user['id'], 'Relatório financeiro')
            save.assert_not_called()
