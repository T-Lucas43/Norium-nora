"""Grounded Nora chat reports using the central report renderer."""
import asyncio
from datetime import datetime, timezone
from app.modules.reports.router import AnalyzePayload, analyze_report
from app.modules.reports.pdf import render_report
from app.modules.auth.router import assert_route_permissions


async def generate_chat_report(user, user_id, text):
    from app.services.nora_files import normalize_command, save_bytes, _money
    from app.services.finance_store import list_finance
    from app.services.task_store import list_tasks
    command = normalize_command(text)
    if 'relatorio' not in command:
        return None
    finance = any(term in command for term in ('finance', 'gasto', 'receita'))
    operations = any(term in command for term in ('operacional','operacao','tarefas','equipe'))
    if not (finance or operations):
        return None
    assert_route_permissions(user, '/api/relatorios')
    assert_route_permissions(user, '/api/nora')
    now = datetime.now(timezone.utc).isoformat()
    notes = ['Posição atual dos registros disponíveis; não representa uma comparação histórica.']
    if finance:
        assert_route_permissions(user, '/api/financeiro')
        data = await asyncio.to_thread(list_finance, user_id)
        entries = data.get('lancamentos', [])
        paid = [e for e in entries if e.get('status') == 'pago']
        income = sum(float(e.get('amount') or 0) for e in paid if e.get('type') == 'entrada')
        expense = sum(float(e.get('amount') or 0) for e in paid if e.get('type') == 'saida')
        title, kind = 'Relatório financeiro', 'finance'
        metrics = [{'id':k,'label':label,'value':_money(value),'detail':'Somente lançamentos pagos','tone':'neutral'} for k,label,value in [('income','Entradas realizadas',income),('expense','Saídas realizadas',expense),('balance','Saldo realizado',income-expense)]]
        columns = ['Lançamento','Tipo','Valor','Situação','Vencimento']
        rows = [[str(e.get('title') or ''),str(e.get('type') or ''),_money(e.get('amount')),str(e.get('status') or ''),str(e.get('dueDate') or 'Sem data')] for e in entries]
        notes.append('Saldo realizado não é saldo bancário nem lucro. Programações e boletos não são somados aos lançamentos.')
    elif 'equipe' in command:
        from app.modules.tasks.router import relatorio_equipe
        data = await relatorio_equipe(user)
        members = data['members']
        title, kind = 'Produtividade da equipe', 'team'
        metrics = [{'id':k,'label':label,'value':str(data['totals'].get(k,0)),'detail':'Estado atual das tarefas','tone':'neutral'} for k,label in [('pendentes','Pendentes'),('andamento','Em execução'),('concluidas','Concluídas'),('vencidas','Vencidas')]]
        columns = ['Membro','Total','Execução','Concluídas','Vencidas']
        rows = [[m['nome'],*[str(m['stats'].get(k,0)) for k in ('total','andamento','concluidas','vencidas')]] for m in members]
        notes.append('Tarefas compartilhadas podem aparecer em mais de um responsável. Volume não comprova produtividade ou qualidade individual.')
    else:
        assert_route_permissions(user, '/api/tarefas')
        data = await asyncio.to_thread(list_tasks,user_id,status='todas')
        title,kind='Relatório operacional','operations'
        metrics=[{'id':k,'label':label,'value':str(data.get('stats',{}).get(k,0)),'detail':'Estado atual das tarefas','tone':'neutral'} for k,label in [('pendentes','Pendentes'),('andamento','Em execução'),('concluidas','Concluídas'),('vencidas','Vencidas')]]
        columns=['Tarefa','Situação','Prioridade','Responsável','Vencimento']
        rows=[[str(t.get(k) or 'Não informado') for k in ('title','status','priority','assigneeName','dueDate')] for t in data.get('tasks',[])]
        notes.append('O volume de tarefas não permite inferir qualidade das entregas nem esforço individual.')
    total=len(rows)
    if total>5000:
        from fastapi import HTTPException
        raise HTTPException(422,'O relatório excede 5.000 registros. Use os filtros da Central de relatórios.')
    table={'id':'records','title':'Registros do relatório','columns':[{'label':c,'width':20} for c in columns],'rows':[{'id':str(i),'cells':r} for i,r in enumerate(rows)]}
    report={'id':kind,'title':title,'subtitle':'Dados do Norium com comentários e recomendações da Nora.','period':'Todo o histórico disponível','filters':[],'generatedAt':now,'recordCount':total,'metrics':metrics,'tables':[table],'notes':notes}
    evidence={k:report[k] for k in ('title','period','filters','recordCount','metrics','notes')}
    evidence['tables']=[{'id':'records','title':table['title'],'columns':columns,'totalRows':total,'rows':[{'id':f'records:{i}','cells':[c[:600] for c in r]} for i,r in enumerate(rows[:25])]}]
    analysis = (await analyze_report(AnalyzePayload(report=evidence),user))['item'] if total else {'summary':'Não há registros disponíveis para avaliar resultados neste relatório.','insights':[],'limitations':['Nota de disponibilidade; não houve análise por IA.'],'generatedAt':now}
    content=await asyncio.to_thread(render_report,report,{'title':title,'theme':'light','includeDetails':True,'includeAnalysis':True},analysis)
    artifact=await asyncio.to_thread(save_bytes,user_id,content,f'relatorio-{kind}.pdf','application/pdf',source=f'report:{kind}')
    return {'status':'arquivo_pronto','response':'Relatório gerado no padrão da Central de relatórios, com os comentários da Nora e os limites da análise.','files':[artifact],'tokenUsage':0}
