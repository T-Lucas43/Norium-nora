import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CheckSquare,
  CircleHelp,
  CreditCard,
  GitBranch,
  Inbox,
  Keyboard,
  Mail,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  UsersRound,
} from "lucide-react";
import noraAvatar from "../../assets/nora-brand.webp";
import "../../styles/screens/inteligencia-equipe-conta.css";

type HelpDashboardProps = {
  onNavigate: (tab: string) => void;
  onOpenNora: () => void;
};

type GuideSection = {
  id: string;
  title: string;
  description: string;
  icon: typeof CircleHelp;
  topics: Array<{
    title: string;
    description: string;
    action?: string;
    tab?: string;
  }>;
};

const sections: GuideSection[] = [
  {
    id: "primeiros-passos",
    title: "Primeiros passos",
    description: "Configure o essencial e comece a operar em poucos minutos.",
    icon: Sparkles,
    topics: [
      { title: "Complete seu perfil", description: "Defina nome, foto, CEP, idioma e preferências.", action: "Abrir perfil", tab: "Perfil" },
      { title: "Conecte suas contas", description: "Autorize Gmail, Google Agenda e WhatsApp nos módulos correspondentes.", action: "Abrir e-mails", tab: "E-mails" },
      { title: "Acompanhe a operação", description: "Use a Central para ver eventos separados por canal em tempo real.", action: "Abrir Central", tab: "Central" },
    ],
  },
  {
    id: "modulos",
    title: "Módulos",
    description: "Entenda onde cada parte do Norium entra no seu trabalho.",
    icon: Inbox,
    topics: [
      { title: "E-mails", description: "Leia, pesquise, responda e envie mensagens pelo Gmail com apoio da Nora.", action: "Abrir e-mails", tab: "E-mails" },
      { title: "Agenda", description: "Visualize compromissos e crie eventos integrados ao Google Agenda.", action: "Abrir agenda", tab: "Agenda" },
      { title: "Chat", description: "Centralize conversas do WhatsApp, mídias, áudios e grupos.", action: "Abrir chat", tab: "Chat" },
      { title: "Tarefas", description: "Organize projetos, Kanban, responsáveis, prazos, anexos e comentários.", action: "Abrir tarefas", tab: "Tarefas" },
      { title: "Gastos", description: "Registre entradas e saídas, acompanhe vencimentos e anexe comprovantes.", action: "Abrir gastos", tab: "Gastos" },
      { title: "Automações", description: "Monte fluxos visuais com gatilhos, ações e participação da Nora.", action: "Abrir automações", tab: "Automações" },
    ],
  },
  {
    id: "nora",
    title: "Nora",
    description: "Sua assistente de IA usa o contexto do módulo e aciona agentes especializados.",
    icon: Bot,
    topics: [
      { title: "Fale naturalmente", description: "Peça ações com frases simples, por exemplo: “crie uma tarefa no projeto Comercial para amanhã”." },
      { title: "Use o contexto", description: "Abra um e-mail, conversa, projeto ou lançamento antes de pedir uma análise mais específica." },
      { title: "Mencione no chat da equipe", description: "Digite @nora no canal geral. Ela só responde quando é mencionada e considera as mensagens recentes do time." },
      { title: "Confirme ações importantes", description: "Revise destinatários, valores, datas e textos antes de confirmar operações sensíveis." },
    ],
  },
  {
    id: "integracoes",
    title: "Integrações",
    description: "Saiba como os canais conectados trabalham juntos.",
    icon: GitBranch,
    topics: [
      { title: "Google", description: "Gmail e Agenda usam autorização individual por conta e mantêm os dados separados por usuário." },
      { title: "Conversas", description: "O WhatsApp aparece no Chat; mensagens recentes também alimentam a Central." },
      { title: "Equipe", description: "Membros autorizados compartilham chat interno, projetos e relatórios conforme suas permissões.", action: "Abrir equipe", tab: "Equipe" },
      { title: "Tempo real", description: "A Central e os contadores recebem novos eventos por WebSocket sem recarregar a página." },
    ],
  },
  {
    id: "atalhos",
    title: "Atalhos",
    description: "Acesse telas e ações sem interromper seu fluxo.",
    icon: Keyboard,
    topics: [
      { title: "Pesquisa global", description: "Use Ctrl + K para buscar telas, recursos e ações em qualquer lugar do sistema." },
      { title: "Barra lateral", description: "Recolha a navegação para ganhar espaço; seus ícones continuam disponíveis." },
      { title: "Chat da equipe", description: "Use o ícone de conversa no topo para falar com todo o time ou enviar mensagem direta." },
      { title: "Configurações", description: "Altere tema, aparência e preferências sem misturar essas opções com os dados do perfil.", action: "Abrir configurações", tab: "Configurações" },
    ],
  },
];

const moduleIcons = [Mail, CalendarDays, MessageSquare, CheckSquare, CreditCard, GitBranch, UsersRound, Settings];

export default function HelpDashboard({ onNavigate, onOpenNora }: HelpDashboardProps) {
  const [activeSection, setActiveSection] = useState(sections[0].id);
  const [query, setQuery] = useState("");

  const currentSection = sections.find((section) => section.id === activeSection) || sections[0];
  const filteredTopics = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return currentSection.topics;
    return sections
      .flatMap((section) => section.topics)
      .filter((topic) => `${topic.title} ${topic.description}`.toLocaleLowerCase("pt-BR").includes(normalized));
  }, [currentSection.topics, query]);

  return (
    <main className="nx-page nxi-screen">
      <div className="nxi-help nxi-stack" style={{ gap: 20 }}>
        <header className="nxi-help-hero">
          <span className="nx-badge is-blue"><CircleHelp size={13} /> Central de ajuda</span>
          <h1 style={{ marginTop: 10 }}>Como podemos ajudar?</h1>
          <p>Guia prático para usar o Norium, suas integrações e a Nora.</p>
          <label className="nxi-search is-lg">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar na central de ajuda"
              aria-label="Buscar no guia do Norium"
            />
            <kbd>Ctrl K</kbd>
          </label>
        </header>

        <nav className="nxi-cards" aria-label="Seções do guia">
          {sections.map((section) => {
            const Icon = section.icon;
            const active = section.id === activeSection && !query;
            return (
              <button
                key={section.id}
                type="button"
                aria-pressed={active}
                className={`nxi-topic-card ${active ? "is-active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setActiveSection(section.id);
                }}
              >
                <span className="nxi-tile is-sm is-blue"><Icon size={18} /></span>
                <strong>{section.title}</strong>
                <small>{section.description}</small>
              </button>
            );
          })}
        </nav>

        <section className="nx-card">
          <div className="nx-card-h">
            <h2>{query ? "Resultados da busca" : currentSection.title}</h2>
            <span className="nx-faint nx-small" style={{ marginLeft: "auto" }}>{query ? `${filteredTopics.length} tópico(s) encontrado(s)` : currentSection.description}</span>
            <span className="hidden gap-1 sm:flex" aria-hidden="true" style={{ color: "var(--nx-text-3)" }}>
              {moduleIcons.slice(0, 5).map((Icon, index) => <Icon key={index} size={14} />)}
            </span>
          </div>
          <div className="nx-card-b">
            {filteredTopics.map((topic) => (
              <article key={`${topic.title}-${topic.description}`} className="nx-row" style={{ flexWrap: "wrap" }}>
                <div className="nx-grow" style={{ flexBasis: 240 }}>
                  <h3 className="nx-row-t" style={{ margin: 0 }}>{topic.title}</h3>
                  <p className="nx-row-sub" style={{ margin: "2px 0 0", lineHeight: 1.45 }}>{topic.description}</p>
                </div>
                {topic.tab && topic.action && (
                  <button type="button" className="nx-btn is-sm" onClick={() => onNavigate(topic.tab!)}>
                    {topic.action} <ArrowRight size={14} />
                  </button>
                )}
              </article>
            ))}
            {!filteredTopics.length && (
              <div className="nxi-empty">
                <CircleHelp size={22} />
                <strong>Nenhum tópico encontrado</strong>
                <span>Tente outra expressão ou pergunte diretamente à Nora.</span>
              </div>
            )}
          </div>
        </section>

        <section className="nx-card flex flex-wrap items-center gap-3.5" style={{ padding: "16px 18px" }}>
          <img src={noraAvatar} alt="" className="nxi-nora-av" draggable={false} />
          <div className="min-w-0 flex-1"><div style={{ fontWeight: 600 }}>Não encontrou?</div><div className="nx-muted nx-small">Pergunte à Nora sobre qualquer tela ou recurso do Norium.</div></div>
          <button type="button" className="nx-btn is-primary" onClick={onOpenNora}>
            <Sparkles size={16} /> Perguntar à Nora
          </button>
        </section>
      </div>
    </main>
  );
}
