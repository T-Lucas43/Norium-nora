import { useState } from "react";
import { ArrowUpRight, Search, LogOut, Sparkles } from "lucide-react";
import IntegrationLogo from "../shared/IntegrationLogo";
import "../../styles/screens/inteligencia-equipe-conta.css";
import "./moreDashboard.css";

type Props = { onNavigate: (tab: string) => void; onOpenNora: () => void; onLogout: () => void };
const groups = [
  { title: "Comunicação e integrações", items: [
    ["Gmail", "E-mails, respostas e conexão da sua conta.", "E-mails"],
    ["Google Agenda", "Compromissos e conexão com o Google.", "Agenda"],
    ["WhatsApp", "Conversas, contatos e conexão do WhatsApp.", "Chat"],
    ["Chat da Equipe", "Converse com membros e subequipes.", "Chat da Equipe"],
  ] },
  { title: "Organize o trabalho", items: [
    ["Automações", "Monte fluxos e acompanhe as execuções.", "Automações"],
    ["Tarefas", "Projetos, prazos e responsáveis.", "Tarefas"],
    ["Clientes", "Consulte e organize seus clientes.", "Clientes"],
    ["Estúdio", "Quadros, ideias e colaboração.", "Estúdio"],
    ["Financeiro", "Acompanhe entradas, saídas e gastos.", "Financeiro"],
    ["Relatórios", "Indicadores e relatórios da operação.", "Relatórios"],
    ["Documentos", "Crie e organize propostas e documentos.", "Documentos"],
    ["Central de atividades", "Eventos e atualizações dos módulos.", "Central"],
  ] },
  { title: "Conta e administração", items: [
    ["Equipe", "Membros e permissões da equipe.", "Equipe"],
    ["Controle operacional", "Aprovações e acompanhamento da operação.", "Controle"],
    ["Configurações", "Aparência e preferências do sistema.", "Configurações"],
    ["Notificações", "Consulte seus alertas e avisos.", "Notificações"],
    ["Perfil", "Informações da sua conta.", "Perfil"],
  ] },
];
export default function MoreDashboard({ onNavigate, onOpenNora, onLogout }: Props) {
  const [query, setQuery] = useState("");
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visible = groups.map(group => ({ ...group, items: group.items.filter(item => normalize(item.join(" ")).includes(normalize(query))) })).filter(group => group.items.length);
  return <main className="nx-page nxi-screen more-workspace">
    <header className="nx-ph"><div><h1>Mais possibilidades, no mesmo lugar</h1><p>Acesse os recursos e os canais do Norium.</p></div><div className="nx-ph-actions"><button type="button" className="nx-btn" onClick={onOpenNora}><Sparkles size={16}/> Abrir Nora <ArrowUpRight size={14}/></button></div></header>
    <label className="nxi-search" style={{ maxWidth: 480 }}><Search size={16}/><input aria-label="Buscar recursos" placeholder="Buscar um recurso ou integração…" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {visible.map(group => <section key={group.title} className="nxi-stack is-sm"><h2 className="nxi-card-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>{group.title} <span className="nx-badge">{group.items.length}</span></h2><div className="nxi-cards is-4">{group.items.map(([title, description, tab]) => <button key={title} type="button" className="nxi-res-card" onClick={() => onNavigate(tab)}><span style={{ display: "flex", width: "100%", alignItems: "flex-start", justifyContent: "space-between" }}><span className="nxi-tile"><IntegrationLogo name={title}/></span><ArrowUpRight size={16} style={{ color: "var(--nx-text-3)" }}/></span><strong>{title}</strong><p>{description}</p><span className="nxi-res-open">Abrir recurso</span></button>)}</div></section>)}
    {!visible.length && <p role="status" className="nx-card nxi-empty">Nenhum recurso encontrado para “{query}”.</p>}
    <footer className="flex flex-wrap items-center justify-between gap-3" style={{ borderTop: "1px solid var(--nx-border)", paddingTop: 16, color: "var(--nx-text-3)", fontSize: 12.5 }}><span>Norium · Seu trabalho conectado</span><button type="button" className="nx-btn is-danger" onClick={onLogout}><LogOut size={16}/> Sair da conta</button></footer>
  </main>;
}
