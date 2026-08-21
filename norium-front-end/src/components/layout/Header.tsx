import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  BrainCircuit,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  CircleHelp,
  CreditCard,
  GitBranch,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserCircle2,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import NoraAvatar from "./NoraAvatar";
import ThemeToggle from "./ThemeToggle";
import { apiBaseUrl, authToken } from "../../utils/api";

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenNora: () => void;
  onOpenTeamChat?: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenLegal: () => void;
  onLogout: () => void;
  onToggleSidebar: () => void;
  unreadNotifications: number;
  profile: PerfilOperador | null;
  currentUser?: NoriumUser | null;
  allowedTabs?: string[];
  canUseNora?: boolean;
  canUseTeamChat?: boolean;
  teamChatUnread?: number;
}

type SearchCommand = {
  title: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
  tab?: string;
  run?: () => void;
};

type SearchResult = {
  id: string;
  kind: string;
  title: string;
  description: string;
  tab: string;
};

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export default function Header({
  activeTab,
  setActiveTab,
  onOpenNora,
  onOpenTeamChat,
  onOpenNotifications,
  onOpenProfile,
  onOpenSettings,
  onOpenLegal,
  onLogout,
  onToggleSidebar,
  unreadNotifications,
  profile,
  currentUser,
  allowedTabs,
  canUseNora = true,
  canUseTeamChat = false,
  teamChatUnread = 0,
}: HeaderProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileName = currentUser?.nome || profile?.nome || "Perfil";

  const commands = useMemo<SearchCommand[]>(
    () => [
      { title: "Dashboard", description: "Resumo operacional e atalhos.", keywords: "inicio home resumo painel", icon: LayoutDashboard, tab: "Dashboard" },
      { title: "Central", description: "Atividades de todas as integrações.", keywords: "eventos inbox notificacoes", icon: Inbox, tab: "Central" },
      { title: "E-mails", description: "Ler, responder e enviar pelo Gmail.", keywords: "gmail caixa entrada mensagem", icon: Mail, tab: "E-mails" },
      { title: "Agenda", description: "Compromissos e novos eventos.", keywords: "calendario reuniao compromisso", icon: CalendarDays, tab: "Agenda" },
      { title: "Chat", description: "WhatsApp, grupos e mídia.", keywords: "conversas mensagens whatsapp", icon: MessageSquare, tab: "Chat" },
      { title: "Tarefas", description: "Projetos, Kanban, prazos e responsáveis.", keywords: "cards projetos prioridade", icon: CheckSquare, tab: "Tarefas" },
      { title: "Financeiro", description: "Entradas, saídas, boletos e anexos.", keywords: "financeiro pagamentos lancamentos", icon: CreditCard, tab: "Financeiro" },
      { title: "Automações", description: "Fluxos, gatilhos e execuções.", keywords: "workflow fluxo nora gatilho", icon: GitBranch, tab: "Automações" },
      { title: "Relatórios", description: "Produtividade, canais e exportações.", keywords: "graficos pdf indicadores", icon: BarChart3, tab: "Relatórios" },
      { title: "Equipe", description: "Membros, acessos e produtividade.", keywords: "usuarios permissoes time", icon: UsersRound, tab: "Equipe" },
      { title: "Brainstorm", description: "Quadros colaborativos da equipe.", keywords: "ideias miro postit reuniao", icon: BrainCircuit, tab: "Brainstorm" },
      { title: "Clientes", description: "Relacionamentos, etapas e proximos contatos.", keywords: "crm cliente lead proposta contato", icon: UserRoundCheck, tab: "Clientes" },
      { title: "Meu perfil", description: "Foto, nome, idioma e CEP.", keywords: "perfil foto nome cep", icon: UserCircle2, tab: "Perfil" },
      { title: "Configurações", description: "Tema, aparência e preferências.", keywords: "tema cores nora notificacoes", icon: Settings, tab: "Configurações" },
      { title: "Ajuda e guia", description: "Guia prático de módulos, integrações e atalhos.", keywords: "ajuda suporte guia como usar primeiros passos", icon: CircleHelp, tab: "Ajuda" },
      { title: "Nora", description: "Conversar com sua assistente inteligente.", keywords: "assistente ia voz ajuda", icon: Sparkles, run: onOpenNora },
    ],
    [onOpenNora],
  );

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return commands
      .filter((command) => !command.tab || !allowedTabs || allowedTabs.includes(command.tab) || command.tab === "Perfil" || command.tab === "Configurações" || command.tab === "Ajuda")
      .filter((command) =>
        !normalized ||
        `${command.title} ${command.description} ${command.keywords}`
          .toLocaleLowerCase("pt-BR")
          .includes(normalized),
      )
      .slice(0, query.trim().length >= 2 ? 4 : 7);
  }, [allowedTabs, commands, query]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const token = authToken();
        const response = await fetch(`${apiBaseUrl()}/api/operacao/busca?q=${encodeURIComponent(normalized)}&limit=8`, {
          signal: controller.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) throw new Error("Busca operacional indisponivel.");
        const payload = (await response.json()) as { items?: SearchResult[] };
        setSearchResults(
          (payload.items || []).filter((result) => !allowedTabs || allowedTabs.includes(result.tab) || result.tab === "Controle"),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 240);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [allowedTabs, query]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setProfileMenuOpen(false);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function runCommand(command: SearchCommand) {
    if (command.tab) setActiveTab(command.tab);
    else command.run?.();
    setQuery("");
    setSearchOpen(false);
  }

  function openSearchResult(result: SearchResult) {
    setActiveTab(result.tab);
    setQuery("");
    setSearchOpen(false);
  }

  return (
    <header className="norium-topbar">
      <div className="norium-topbar-search-group">
        <button
          type="button"
          className="norium-topbar-menu"
          onClick={onToggleSidebar}
          aria-label="Abrir ou recolher navegação"
        >
          <Menu size={20} />
        </button>

        <div className="norium-command-search">
          <Search size={18} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            autoComplete="off"
            aria-label="Buscar no Norium"
            placeholder="Buscar no Norium..."
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filteredCommands[0]) runCommand(filteredCommands[0]);
            }}
          />
          <kbd>Ctrl K</kbd>

          {searchOpen && (
            <div className="norium-command-results">
              <p className="norium-command-results-label">{query.trim() ? "Resultados" : "Acessos rápidos"}</p>
              {filteredCommands.length ? (
                filteredCommands.map((command) => {
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.title}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => runCommand(command)}
                    >
                      <span><Icon size={17} /></span>
                      <span>
                        <strong>{command.title}</strong>
                        <small>{command.description}</small>
                      </span>
                    </button>
                  );
                })
              ) : (
                !searchLoading && searchResults.length === 0 && <div className="norium-command-empty">Nenhum resultado encontrado.</div>
              )}
              {query.trim().length >= 2 && (
                <>
                  <p className="norium-command-results-label mt-2 border-t border-[var(--border)] pt-2">
                    {searchLoading ? "Buscando nos seus dados..." : "Dados encontrados"}
                  </p>
                  {searchLoading ? (
                    <div className="norium-command-empty flex items-center gap-2"><LoaderCircle className="animate-spin" size={15} /> Consultando tarefas, atividades e financeiro...</div>
                  ) : searchResults.length > 0 ? (
                    searchResults.map((result) => (
                      <button
                        key={`${result.kind}-${result.id}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openSearchResult(result)}
                      >
                        <span><Search size={17} /></span>
                        <span>
                          <strong>{result.title}</strong>
                          <small>{result.kind} · {result.description || `Abrir ${result.tab}`}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="norium-command-empty">Nenhum dado operacional corresponde à busca.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="norium-topbar-actions">
        <button
          type="button"
          className={`norium-topbar-icon ${activeTab === "Agenda" ? "is-active" : ""}`}
          onClick={() => setActiveTab("Agenda")}
          title="Abrir Agenda"
         aria-label="Abrir Agenda">
          <CalendarDays size={19} />
        </button>

        <button
          type="button"
          className="norium-topbar-icon"
          onClick={onOpenNotifications}
          title="Notificações do sistema"
         aria-label="Notificações do sistema">
          <Bell size={19} />
          {unreadNotifications > 0 && (
            <span className="norium-topbar-badge">{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>
          )}
        </button>

        {canUseTeamChat && (
          <button type="button" className="norium-topbar-icon" onClick={onOpenTeamChat} title="Chat da equipe" aria-label="Chat da equipe">
            <MessageSquare size={19} />
            {teamChatUnread > 0 && (
              <span className="norium-topbar-badge">{teamChatUnread > 99 ? "99+" : teamChatUnread}</span>
            )}
          </button>
        )}

        {canUseNora && (
          <button type="button" className="norium-topbar-nora" onClick={() => onOpenNora()} title="Conversar com a Nora" aria-label="Conversar com a Nora">
            <NoraAvatar className="h-8 w-8" />
            <span>Nora</span>
          </button>
        )}

        <div ref={profileMenuRef} className="norium-profile-menu">
          <button
            type="button"
            className={`norium-topbar-profile ${profileMenuOpen ? "is-open" : ""}`}
            onClick={() => setProfileMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
          >
            <span className="norium-topbar-profile-avatar">
              {profile?.fotoUrl ? (
                <img src={profile.fotoUrl} alt="" />
              ) : profileName ? (
                initials(profileName)
              ) : (
                <UserCircle2 size={20} />
              )}
            </span>
            <span className="norium-topbar-profile-name">{profileName.split(/\s+/)[0]}</span>
            <ChevronDown size={15} className={profileMenuOpen ? "rotate-180" : ""} />
          </button>

          {profileMenuOpen && (
            <div className="norium-profile-dropdown" role="menu">
              <div className="norium-profile-dropdown-user">
                <span className="norium-topbar-profile-avatar">
                  {profile?.fotoUrl ? <img src={profile.fotoUrl} alt="" /> : initials(profileName)}
                </span>
                <span>
                  <strong>{profileName}</strong>
                  <small>{currentUser?.email || "Operador Norium"}</small>
                </span>
              </div>

              <div className="norium-profile-dropdown-theme">
                <span><Moon size={16} /> Tema</span>
                <ThemeToggle />
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenProfile();
                  setProfileMenuOpen(false);
                }}
              >
                <UserCircle2 size={17} />
                <span><strong>Editar perfil</strong><small>Foto e dados pessoais</small></span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenSettings();
                  setProfileMenuOpen(false);
                }}
              >
                <Settings size={17} />
                <span><strong>Configurações</strong><small>Aparência, Nora e notificações</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setProfileMenuOpen(false); onOpenLegal(); }}>
                <ShieldCheck size={17} />
                <span><strong>Termos e privacidade</strong><small>Documentos do produto</small></span>
              </button>
              <button type="button" role="menuitem" className="is-danger" onClick={onLogout}>
                <LogOut size={17} />
                <span><strong>Sair</strong><small>Encerrar esta sessão</small></span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
