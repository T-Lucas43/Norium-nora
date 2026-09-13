import { useMemo, useState } from "react";
import { Download, Search, UsersRound, ArrowUpRight } from "lucide-react";
import type { ReportDocument } from "../../features/reports/reportDocument";
import ReportNoraPanel, { type SavedReportAnalysis } from "../reports/ReportNoraPanel";
import ReportExportDialog from "../reports/ReportExportDialog";
import { reportFingerprint } from "../../features/reports/reportDocument";
import Button from "../shared/Button";
import "../reports/reports.css";
import "./team.css";

type Member = { id: string; nome: string; email: string; status: string; jobTitle?: string; stats: { total: number; pendentes: number; andamento: number; revisao: number; concluidas: number; vencidas: number; urgentes: number }; recentes: { id: string; title: string; status: string; priority: string; dueDate?: string }[] };
export type TeamProductivityData = { members: Member[]; totals: Record<string, number>; updatedAt: string };
function teamReport(data: TeamProductivityData, name: string): ReportDocument {
  const totals = data.totals;
  const metrics = ([['pendentes', 'Pendentes'], ['andamento', 'Em execução'], ['revisao', 'Em revisão'], ['concluidas', 'Concluídas'], ['vencidas', 'Vencidas']] as const).map(([id,label]) => ({ id, label, value: String(totals[id] || 0), detail: 'Tarefas no estado atual', tone: id === 'vencidas' ? 'warning' as const : id === 'concluidas' ? 'positive' as const : 'neutral' as const }));
  return { id: 'team', title: `Produtividade · ${name}`, subtitle: 'Entregas, carga de trabalho e prazos da equipe.', period: 'Posição atual · todo o histórico disponível', generatedAt: data.updatedAt, filters: [], recordCount: data.members.length, metrics,
    tables: [{ id: 'members', title: 'Distribuição de tarefas por responsável', columns: [{label:'Membro',width:30},{label:'Total',width:14},{label:'Execução',width:14},{label:'Revisão',width:14},{label:'Concluídas',width:14},{label:'Vencidas',width:14}], rows: data.members.map(m => ({id:m.id,cells:[m.nome,String(m.stats.total),String(m.stats.andamento),String(m.stats.revisao),String(m.stats.concluidas),String(m.stats.vencidas)]})) }],
    notes: ['O relatório descreve o estado atual das tarefas; não mede horas trabalhadas ou qualidade das entregas.', 'Tarefas compartilhadas podem aparecer para mais de um responsável. Não some linhas individuais para obter o total da equipe.', 'Sem metas, esforço estimado e histórico comparável, não é possível classificar o desempenho individual.'] };
}

export default function TeamProductivity({ data, name, onManage }: { data: TeamProductivityData | null; name: string; onManage: (id: string) => void }) {
  const [search,setSearch] = useState(''), [selected,setSelected] = useState(''), [saved,setSaved] = useState<SavedReportAnalysis|null>(null), [exporting,setExporting] = useState(false);
  const document = useMemo(() => data ? teamReport(data,name) : null,[data,name]);
  const members = (data?.members || []).filter(m => `${m.nome} ${m.email}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const member = data?.members.find(m=>m.id===selected) || members[0];
  const analysis = document && saved?.fingerprint === reportFingerprint(document) ? saved.analysis : null;
  if (!data || !document) return <div className="team-loading" role="status">Carregando tarefas e indicadores da equipe…</div>;
  return <>
    <div className="team-section-heading"><div><span className="team-eyebrow">VISÃO GERAL</span><h2>Trabalho em perspectiva</h2><p>Uma leitura de entregas, capacidade e prioridades.</p></div><Button size="sm" onClick={()=>setExporting(true)}><Download size={14}/>Relatório PDF com Nora</Button></div>
    <div className="team-kpis">{document.metrics.map(m=><article key={m.id} className={`tone-${m.tone}`}><span>{m.label}</span><strong>{m.value}</strong><small>{m.detail}</small></article>)}</div>
    <div className="team-productivity-grid"><section className="team-panel"><header><h3><UsersRound size={16}/>Carga por membro</h3><label className="team-search"><Search size={14}/><input aria-label="Buscar membro" placeholder="Buscar membro" value={search} onChange={e=>setSearch(e.target.value)}/></label></header><div className="team-table-wrap"><table><thead><tr><th>Membro</th><th>Concluídas / total</th><th>Em execução</th><th>Vencidas</th></tr></thead><tbody>{members.map(m=><tr key={m.id} className={member?.id===m.id?'is-selected':''}><td><button onClick={()=>setSelected(m.id)} aria-label={`Ver tarefas de ${m.nome}`}><span className="team-initial">{m.nome.slice(0,1)}</span><span><strong>{m.nome}</strong><small>{m.jobTitle || 'Membro'} · {m.status}</small></span></button></td><td><span>{m.stats.concluidas} / {m.stats.total}</span><progress aria-label={`Conclusão de ${m.nome}`} value={m.stats.concluidas} max={Math.max(1,m.stats.total)}/></td><td>{m.stats.andamento}</td><td><span className={m.stats.vencidas?'team-overdue':''}>{m.stats.vencidas}</span></td></tr>)}</tbody></table>{!members.length&&<p className="team-empty">Nenhum membro encontrado.</p>}</div></section>
    <aside className="team-panel team-recent"><header><div><span className="team-eyebrow">TAREFAS RECENTES</span><h3>{member?.nome || 'Equipe'}</h3></div>{member&&<button aria-label={`Gerenciar ${member.nome}`} onClick={()=>onManage(member.id)}><ArrowUpRight size={17}/></button>}</header>{member?.recentes.length?member.recentes.map(t=><article key={t.id}><strong>{t.title}</strong><div><span>{t.status}</span><span>{t.dueDate?new Date(`${t.dueDate.slice(0,10)}T12:00:00`).toLocaleDateString('pt-BR'):'Sem prazo'}</span></div></article>):<p className="team-empty">Nenhuma tarefa atribuída neste histórico.</p>}</aside></div>
    <ReportNoraPanel report={document} saved={saved} onAnalyzed={setSaved} disabled={false}/>
    <p className="team-footnote">Atualizado em {new Date(data.updatedAt).toLocaleString('pt-BR')} · Indicadores de tarefas, sem ranking de pessoas.</p>
    {exporting&&<ReportExportDialog report={document} analysis={analysis} onClose={()=>setExporting(false)}/>}
  </>;
}
