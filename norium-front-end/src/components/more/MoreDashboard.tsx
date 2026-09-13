import { useState } from "react";
import { ArrowUpRight, Search, LogOut, Sparkles } from "lucide-react";
import IntegrationLogo from "../shared/IntegrationLogo";
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
  return <main className="more-workspace">
    <header className="more-heading"><div><span className="more-eyebrow">SEU ESPAÇO DE TRABALHO</span><h1>Mais possibilidades, no mesmo lugar.</h1><p>Acesse os recursos e os canais do Norium.</p></div><button className="more-nora" onClick={onOpenNora}><Sparkles size={20}/> Abrir Nora <ArrowUpRight size={16}/></button></header>
    <label className="more-search"><Search size={18}/><input aria-label="Buscar recursos" placeholder="Buscar um recurso ou integração…" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {visible.map(group => <section key={group.title}><h2>{group.title} <span>{group.items.length}</span></h2><div className="more-grid">{group.items.map(([title, description, tab]) => <button key={title} className="more-card" onClick={() => onNavigate(tab)}><span className="more-logo"><IntegrationLogo name={title}/></span><ArrowUpRight className="more-arrow" size={17}/><strong>{title}</strong><p>{description}</p><span className="more-open">Abrir recurso</span></button>)}</div></section>)}
    {!visible.length && <p role="status">Nenhum recurso encontrado para “{query}”.</p>}
    <footer className="more-footer"><span>Norium · Seu trabalho conectado</span><button onClick={onLogout}><LogOut size={16}/> Sair da conta</button></footer>
  </main>;
}
