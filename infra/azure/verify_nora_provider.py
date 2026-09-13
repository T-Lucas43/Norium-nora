"""Run a synthetic report in the deployed container without exposing secrets."""
import base64
import os

import pexpect

probe = '''
import asyncio
from app.modules.reports.router import AnalyzePayload, analyze_report
from app.modules.reports.pdf import render_report
from app.modules.auth.router import OWNER_PERMISSIONS
async def check():
    report = {'title':'Verificação de disponibilidade','period':'Dados fictícios','filters':[],'recordCount':1,'notes':['Dados fictícios de teste; não são registros de clientes.'],'metrics':[{'id':'done','label':'Tarefas concluídas','value':'1','detail':'Cenário fictício','tone':'neutral'}],'tables':[]}
    analysis = (await analyze_report(AnalyzePayload(report=report), {'id':'synthetic-nora-probe','role':'owner','plan':'enterprise','permissions':dict(OWNER_PERMISSIONS)}))['item']
    assert analysis['insights'] and analysis['generatedAt']
    pdf = render_report(report, {'includeAnalysis':True}, analysis)
    assert pdf.startswith(b'%PDF')
    print('NORA_RUNTIME_PDF_VERIFIED', flush=True)
asyncio.run(check())
'''

if __name__ == '__main__':
    encoded = base64.b64encode(probe.encode()).decode()
    command = f"python -c \"import base64;exec(base64.b64decode('{encoded}'))\""
    child = pexpect.spawn('az', ['containerapp', 'exec', '-g', os.environ['RESOURCE_GROUP'], '-n', os.environ['APP_NAME'], '--command', command], encoding='utf-8', timeout=240)
    try:
        child.expect('NORA_RUNTIME_PDF_VERIFIED')
        print('Deployed Nora provider generated a valid analysis and PDF with synthetic data.')
    except (pexpect.EOF, pexpect.TIMEOUT):
        # Do not print console payloads, which can contain runtime details.
        raise SystemExit('Nora runtime verification did not complete; no secrets were logged.') from None
    finally:
        child.close(force=True)
