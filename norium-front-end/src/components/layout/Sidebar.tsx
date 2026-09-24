import {
  BrainCircuit,
  BriefcaseBusiness,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  House,
  MessagesSquare,
  UsersRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import BrandLogo from "./BrandLogo";
import IntegrationLogo from "../shared/IntegrationLogo";
import NoraAvatar from "./NoraAvatar";
import { preloadPanel } from "../../app/navigation/panelModules";
import type { InterfacePreferences } from "../../utils/interfacePreferences";

type NavigationItem = {
  title: string;
};

type NavigationGroup = {
  label: string;
  items: string[];
  icon: LucideIcon;
};

type SidebarProps = {
  activeTab: string;
  allowedTabs?: string[];
  collapsed: boolean;
  mobileOpen: boolean;
  currentUser?: NoriumUser | null;
  profile: PerfilOperador | null;
  onCloseMobile: () => void;
  onNavigate: (tab: string) => void;
  onToggleCollapsed: () => void;
  navigationStyle?: InterfacePreferences["navigationStyle"];
};

const NORA_ENTRY = "Nora";
const PRIMARY_ENTRIES = ["Dashboard", NORA_ENTRY];

const NAVIGATION_GROUPS: NavigationGroup[] = [
  { label: "Início", icon: House, items: ["Controle", "Central"] },
  { label: "Comunicação", icon: MessagesSquare, items: ["E-mails", "Agenda", "Agendamentos", "Chat", "Chat da Equipe"] },
  { label: "Trabalho", icon: BriefcaseBusiness, items: ["Tarefas", "Financeiro", "Documentos", "PDF Studio", "Clientes"] },
  { label: "Inteligência", icon: BrainCircuit, items: ["Automações", "Relatórios", "Agente Navegador", "Conhecimento", "Marketplace", "IA e Modelos"] },
  { label: "Equipe", icon: UsersRound, items: ["Equipe", "Estúdio", "Governanca", "Mais"] },
];

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export default function Sidebar({
  activeTab,
  allowedTabs,
  collapsed,
  mobileOpen,
  currentUser,
  profile,
  onCloseMobile,
  onNavigate,
  onToggleCollapsed,
  navigationStyle = "grouped",
}: SidebarProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const isAllowed = (title: string) => !allowedTabs || allowedTabs.includes(title);
  const compact = collapsed && !mobileOpen;
  const profileName = currentUser?.nome || profile?.nome || "Operador";
  const planLabel = currentUser?.plan
    ? `Plano ${currentUser.plan.charAt(0).toUpperCase()}${currentUser.plan.slice(1)}`
    : "Norium";

  function navigate(tab: string) {
    onNavigate(tab);
    onCloseMobile();
  }

  function renderItem(item: NavigationItem) {
    const active =
      activeTab === item.title ||
      (activeTab === "Inbox" && item.title === "Central") ||
      (activeTab === "Automacoes" && item.title === "Automações") ||
      (activeTab === "Relatorios" && item.title === "Relatórios");

    return (
      <button
        key={item.title}
        type="button"
        className={`norium-sidebar-item ${active ? "is-active" : ""} ${item.title === NORA_ENTRY ? "is-nora" : ""}`}
        onClick={() => navigate(item.title)}
        onPointerEnter={() => preloadPanel(item.title)}
        onFocus={() => preloadPanel(item.title)}
        title={compact ? item.title : undefined}
        aria-current={active ? "page" : undefined}
       aria-label={compact ? item.title : undefined}>
        <span className="norium-sidebar-item-icon" aria-hidden="true">
          {item.title === NORA_ENTRY ? <NoraAvatar variant="navigation" className="norium-sidebar-nora-avatar" />
            : <IntegrationLogo name={item.title} size={20} className="norium-sidebar-channel-icon" monochrome />}
        </span>
        {!compact && <span className="norium-sidebar-item-label">{item.title}</span>}
      </button>
    );
  }

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="norium-sidebar-backdrop"
          aria-label="Fechar navegação"
          onClick={onCloseMobile}
        />
      )}

      <aside
        className={`norium-sidebar ${compact ? "is-collapsed" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}
        aria-label="Navegação principal"
      >
        <div className="norium-sidebar-brand">
          <button
            type="button"
            className="norium-sidebar-brand-button"
            onClick={() => navigate("Dashboard")}
            aria-label="Abrir Dashboard"
          >
            <BrandLogo className={compact ? "h-10 w-10 object-left" : "h-12 w-[126px] object-left"} />
          </button>

          <button
            type="button"
            className="norium-sidebar-mobile-close"
            onClick={onCloseMobile}
            aria-label="Fechar navegação"
          >
            <X size={19} />
          </button>
        </div>

        <nav className="norium-sidebar-navigation">
          <div className="norium-sidebar-primary">
            {PRIMARY_ENTRIES.filter(isAllowed).map((title) => renderItem({ title }))}
          </div>
          {NAVIGATION_GROUPS.map((group) => {
            const visible = group.items.filter(isAllowed);
            if (!visible.length) return null;
            if (navigationStyle === "classic") {
              return (
                <div key={group.label} className="norium-sidebar-group">
                  {!compact && <p className="norium-sidebar-group-label" aria-hidden="true">{group.label}</p>}
                  {visible.map((title) => renderItem({ title }))}
                </div>
              );
            }
            const Icon = group.icon;
            const expanded = expandedGroup === group.label;
            const groupActive = visible.some((title) => activeTab === title || (activeTab === "Inbox" && title === "Central"));
            return (
              <div key={group.label} className={`norium-sidebar-group ${expanded ? "is-expanded" : ""}`}>
                <button
                  type="button"
                  className={`norium-sidebar-group-toggle ${groupActive ? "has-active-item" : ""}`}
                  onClick={() => {
                    setExpandedGroup((current) => current === group.label ? null : group.label);
                    if (compact) onToggleCollapsed();
                  }}
                  aria-expanded={expanded}
                  aria-controls={`norium-sidebar-group-${group.label}`}
                  aria-label={compact ? group.label : undefined}
                  title={compact ? group.label : undefined}
                >
                  <span className="norium-sidebar-group-icon"><Icon size={20} /></span>
                  {!compact && <span>{group.label}</span>}
                  {!compact && (expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                </button>
                {expanded && !compact && <div id={`norium-sidebar-group-${group.label}`} className="norium-sidebar-group-items">{visible.map((title) => renderItem({ title }))}</div>}
              </div>
            );
          })}
        </nav>

        <div className="norium-sidebar-secondary">
          <button
            type="button"
            className={`norium-sidebar-item ${activeTab === "Configuracoes" || activeTab === "Configurações" ? "is-active" : ""}`}
            onClick={() => navigate("Configurações")}
            title="Configurações">
            <span className="norium-sidebar-item-icon">
              <IntegrationLogo name="Configurações" size={20} className="norium-sidebar-channel-icon" monochrome />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Configurações</span>}
          </button>
          <button
            type="button"
            className={`norium-sidebar-item ${activeTab === "Ajuda" ? "is-active" : ""}`}
            onClick={() => navigate("Ajuda")}
            title="Ajuda"
            aria-current={activeTab === "Ajuda" ? "page" : undefined}
          >
            <span className="norium-sidebar-item-icon">
              <IntegrationLogo name="Ajuda" size={20} className="norium-sidebar-channel-icon" monochrome />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Ajuda</span>}
          </button>
        </div>

        <button
          type="button"
          className="norium-sidebar-profile"
          onClick={() => navigate("Perfil")}
          title={profileName}>
          <span className="norium-sidebar-profile-avatar">
            {profile?.fotoUrl ? (
              <img src={profile.fotoUrl} alt="" />
            ) : (
              initials(profileName)
            )}
          </span>
          {!compact && (
            <span className="norium-sidebar-profile-copy">
              <strong>{profileName}</strong>
              <small>{planLabel}</small>
            </span>
          )}
        </button>

        <button
          type="button"
          className="norium-sidebar-collapse"
          onClick={onToggleCollapsed}
          aria-label={compact ? "Expandir barra lateral" : "Recolher barra lateral"}
          title={compact ? "Expandir" : "Recolher"}
        >
          {compact ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </button>
      </aside>
    </>
  );
}
