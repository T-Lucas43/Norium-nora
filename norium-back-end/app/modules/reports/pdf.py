"""The shared Norium report layout used by exports and Nora attachments."""
from __future__ import annotations
import io
from html import escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


def render_report(report: dict, options: dict, analysis: dict | None = None) -> bytes:
    output = io.BytesIO()
    dark = options.get('theme') == 'dark'
    ink, muted, paper, surface = ('#f4f4f5','#b6b6c0','#101113','#1b1d21') if dark else ('#18181b','#61616b','#ffffff','#f4f4f5')
    width = A4[0] - 80
    styles = {name: ParagraphStyle(name, fontName='Helvetica-Bold' if bold else 'Helvetica', fontSize=size, leading=size*1.4, textColor=colors.HexColor(color), spaceAfter=8) for name,size,bold,color in [('title',21,True,ink),('heading',12,True,ink),('body',9,False,ink),('muted',8,False,muted),('cell',8.5,False,ink)]}
    def p(value, style='body'):
        return Paragraph(escape(str(value or '')).replace('\n','<br/>'),styles[style])
    def frame(canvas, doc):
        canvas.saveState(); canvas.setFillColor(colors.HexColor(paper)); canvas.rect(0,0,*A4,fill=1,stroke=0)
        canvas.setFillColor(colors.HexColor('#121315')); canvas.rect(0,A4[1]-72,A4[0],72,fill=1,stroke=0)
        canvas.setFillColor(colors.white); canvas.setFont('Helvetica-Bold',18); canvas.drawString(40,A4[1]-44,'NORIUM')
        canvas.setFont('Helvetica-Bold',8); canvas.drawRightString(A4[0]-40,A4[1]-31,'CENTRAL DE RELATÓRIOS')
        canvas.setFont('Helvetica',7); canvas.drawRightString(A4[0]-40,A4[1]-47,str(report.get('period',''))[:105])
        canvas.setStrokeColor(colors.HexColor('#61616b')); canvas.line(40,32,A4[0]-40,32)
        canvas.setFillColor(colors.HexColor(muted)); canvas.drawString(40,18,'NORIUM / Relatório de gestão'); canvas.drawRightString(A4[0]-40,18,f'Página {doc.page}'); canvas.restoreState()
    story=[p(options.get('title') or report['title'],'title'),p(report.get('subtitle',''),'muted'),p('Recorte: '+' | '.join(report.get('filters',[])),'muted'),p(f"{report.get('recordCount',0)} registros · {report.get('period','')}",'muted')]
    def table(title, columns, rows, widths=None):
        story.extend([Spacer(1,8),p(title,'heading')])
        if not rows: story.append(p('Nenhum registro neste recorte.','muted')); return
        weights=widths or [1]*len(columns); total=sum(weights)
        grid=Table([[p(c,'cell') for c in columns]]+[[p(c,'cell') for c in row] for row in rows],colWidths=[width*w/total for w in weights],repeatRows=1,hAlign='LEFT',splitInRow=1)
        grid.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor(surface)),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor(paper),colors.HexColor(surface)]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,-1),.25,colors.HexColor('#777777'))]))
        story.append(grid)
    table('Indicadores',['Indicador','Valor','Critério'],[[m['label'],m['value'],m['detail']] for m in report.get('metrics',[])],[30,20,50])
    if options.get('includeAnalysis',True) and analysis:
        story.extend([Spacer(1,10),p('Leitura executiva da Nora','heading'),p(analysis['summary'])])
        labels={'positive':'Ponto positivo','attention':'Ponto de atenção','opportunity':'Oportunidade','neutral':'Observação'}
        table('Comentários e recomendações da Nora',['Leitura','Análise e contexto','Próxima ação'],[[labels[i['kind']],i['title']+'\n'+i['explanation'],i['recommendation']] for i in analysis.get('insights',[])],[18,48,34])
    if options.get('includeDetails',True):
        for item in report.get('tables',[]): table(item['title'],[c['label'] for c in item['columns']],[r['cells'] for r in item['rows']],[c['width'] for c in item['columns']])
    if options.get('comments','').strip(): story.extend([p('Comentários do responsável','heading'),p(options['comments'])])
    story.extend([Spacer(1,10),p('Critérios e notas de leitura','heading')])
    for note in [*report.get('notes',[]),*((analysis or {}).get('limitations',[]) if options.get('includeAnalysis',True) else [])]: story.append(p('- '+note,'muted'))
    SimpleDocTemplate(output,pagesize=A4,leftMargin=40,rightMargin=40,topMargin=94,bottomMargin=48,title=options.get('title') or report['title'],author='Norium',creator='Norium - Central de relatórios').build(story,onFirstPage=frame,onLaterPages=frame)
    return output.getvalue()
