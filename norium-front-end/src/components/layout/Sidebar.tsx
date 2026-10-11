import {
  BrainCircuit,
  BriefcaseBusiness,
  CalendarDays,
  ChartPie,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  House,
  MessagesSquare,
  UsersRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import BrandLogo from "./BrandLogo";
import IntegrationLogo from "../shared/IntegrationLogo";
import NoraAvatar from "./NoraAvatar";
import { preloadPanel } from "../../app/navigation/panelModules";
import { NAVIGATION_GROUPS, displayLabel, normalizeTab } from "../../app/navigation/navigationGroups";
import type { InterfacePreferences } from "../../utils/interfacePreferences";

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
  counts?: Record<string, number>;
};

const NORA_ENTRY = "Nora";
const PRIMARY_ENTRIES = ["Dashboard", NORA_ENTRY];

const GROUP_ICONS: Record<string, LucideIcon> = {
  "Início": House,
  "Comunicação": MessagesSquare,
  Agenda: CalendarDays,
  Trabalho: BriefcaseBusiness,
  "Gestão": ChartPie,
  "Inteligência": BrainCircuit,
  Equipe: UsersRound,
};

function matchesTab(activeTab: string, title: string) {
  return normalizeTab(activeTab) === title;
}

export default function Sidebar({
  activeTab,
  allowedTabs,
  collapsed,
  mobileOpen,
  onCloseMobile,
  onNavigate,
  onToggleCollapsed,
  navigationStyle = "grouped",
  counts = {},
}: SidebarProps) {
  const activeGroup = NAVIGATION_GROUPS.find((group) => !group.single && group.items.some((title) => matchesTab(activeTab, title)))?.label ?? null;
  const [expandedGroup, setExpandedGroup] = useState<string | null>(activeGroup);
  // A tela aberta fica sempre visível no menu: o grupo dela abre ao navegar.
  useEffect(() => {
    if (activeGroup) setExpandedGroup(activeGroup);
  }, [activeGroup]);
  const isAllowed = (title: string) => !allowedTabs || allowedTabs.includes(title);
  const compact = collapsed && !mobileOpen;

  function navigate(tab: string) {
    onNavigate(tab);
    onCloseMobile();
  }

  function renderItem(title: string, options: { label?: string; icon?: LucideIcon; target?: string; active?: boolean } = {}) {
    const active = options.active ?? matchesTab(activeTab, title);
    const label = options.label ?? displayLabel(title);
    const target = options.target ?? title;
    const Icon = options.icon;
    const count = counts[title] || 0;

    return (
      <button
        key={title}
        type="button"
        className={`norium-sidebar-item ${active ? "is-active" : ""} ${title === NORA_ENTRY ? "is-nora" : ""}`}
        onClick={() => navigate(target)}
        onPointerEnter={() => preloadPanel(target)}
        onFocus={() => preloadPanel(target)}
        title={compact ? label : undefined}
        aria-current={active ? "page" : undefined}
        aria-label={compact ? label : undefined}>
        <span className="norium-sidebar-item-icon" aria-hidden="true">
          {title === NORA_ENTRY ? <NoraAvatar variant="navigation" className="norium-sidebar-nora-avatar" />
            : Icon ? <Icon size={16} />
            : <IntegrationLogo name={title} size={16} className="norium-sidebar-channel-icon" monochrome />}
        </span>
        {!compact && <span className="norium-sidebar-item-label">{label}</span>}
        {!compact && count > 0 && <span className="norium-sidebar-item-count">{count > 99 ? "99+" : count}</span>}
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
            aria-label="Abrir Painel"
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
            {PRIMARY_ENTRIES.filter(isAllowed).map((title) => renderItem(title))}
          </div>
          {NAVIGATION_GROUPS.map((group) => {
            const visible = group.items.filter(isAllowed);
            if (!visible.length) return null;
            const Icon = GROUP_ICONS[group.label] ?? BrainCircuit;
            if (group.single) {
              // Telas de uma mesma área abertas por um item só; as abas internas trocam entre elas.
              const current = visible.find((title) => matchesTab(activeTab, title));
              return (
                <div key={group.label} className="norium-sidebar-group">
                  {renderItem(group.label, { label: group.label, icon: Icon, target: current ?? visible[0], active: Boolean(current) })}
                </div>
              );
            }
            if (navigationStyle === "classic") {
              return (
                <div key={group.label} className="norium-sidebar-group">
                  {!compact && <p className="norium-sidebar-group-label" aria-hidden="true">{group.label}</p>}
                  {visible.map((title) => renderItem(title))}
                </div>
              );
            }
            const expanded = expandedGroup === group.label;
            const groupActive = visible.some((title) => matchesTab(activeTab, title));
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
                  <span className="norium-sidebar-group-icon"><Icon size={16} /></span>
                  {!compact && <span>{group.label}</span>}
                  {!compact && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                </button>
                {expanded && !compact && <div id={`norium-sidebar-group-${group.label}`} className="norium-sidebar-group-items">{visible.map((title) => renderItem(title))}</div>}
              </div>
            );
          })}
        </nav>

        <div className="norium-sidebar-secondary">
          {renderItem("Configurações", { active: ["Configurações", "Perfil"].includes(normalizeTab(activeTab)) })}
          {renderItem("Ajuda")}
        </div>

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
