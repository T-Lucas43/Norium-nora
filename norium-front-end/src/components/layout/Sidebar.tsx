import {
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import BrandLogo from "./BrandLogo";
import IntegrationLogo from "../shared/IntegrationLogo";
import NoraAvatar from "./NoraAvatar";
import { preloadPanel } from "../../app/navigation/panelModules";

type NavigationItem = {
  title: string;
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
};

const navigation: NavigationItem[] = [
  { title: "Nora" },
  { title: "Dashboard" },
  { title: "Controle" },
  { title: "Central" },
  { title: "E-mails" },
  { title: "Agenda" },
  { title: "Chat" },
  { title: "Tarefas" },
  { title: "Financeiro" },
  { title: "Automações" },
  { title: "Relatórios" },
  { title: "Documentos" },
  { title: "Agente Navegador" },
  { title: "Conhecimento" },
  { title: "Marketplace" },
  { title: "IA e Modelos" },
  { title: "Equipe" },
  { title: "Chat da Equipe" },
  { title: "Clientes" },
  { title: "Governanca" },
  { title: "Estúdio" },
  { title: "Mais" },
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
}: SidebarProps) {
  const items = navigation.filter((item) => !allowedTabs || allowedTabs.includes(item.title));
  const compact = collapsed && !mobileOpen;
  const profileName = currentUser?.nome || profile?.nome || "Operador";
  const planLabel = currentUser?.plan
    ? `Plano ${currentUser.plan.charAt(0).toUpperCase()}${currentUser.plan.slice(1)}`
    : "Norium";

  function navigate(tab: string) {
    onNavigate(tab);
    onCloseMobile();
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
            <BrandLogo className={compact ? "h-11 w-11 object-left" : "h-12 w-[126px] object-left"} />
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
          {items.map((item) => {
            const active =
              activeTab === item.title ||
              (activeTab === "Inbox" && item.title === "Central") ||
              (activeTab === "Automacoes" && item.title === "Automações") ||
              (activeTab === "Relatorios" && item.title === "Relatórios");

            return (
              <button
                key={item.title}
                type="button"
                className={`norium-sidebar-item ${active ? "is-active" : ""} ${item.title === "Nora" ? "is-nora" : ""}`}
                onClick={() => navigate(item.title)}
                onPointerEnter={() => preloadPanel(item.title)}
                onFocus={() => preloadPanel(item.title)}
                title={compact ? item.title : undefined}
                aria-current={active ? "page" : undefined}
               aria-label={compact ? item.title : undefined}>
                <span className="norium-sidebar-item-icon" aria-hidden="true">
                  {item.title === "Nora" ? <NoraAvatar variant="navigation" className="norium-sidebar-nora-avatar" />
                    : <IntegrationLogo name={item.title} size={18} className="norium-sidebar-channel-icon" />}
                </span>
                {!compact && <span className="norium-sidebar-item-label">{item.title}</span>}
              </button>
            );
          })}
        </nav>

        <div className="norium-sidebar-secondary">
          <button
            type="button"
            className={`norium-sidebar-item ${activeTab === "Configuracoes" || activeTab === "Configurações" ? "is-active" : ""}`}
            onClick={() => navigate("Configurações")}
            title={compact ? "Configurações" : undefined}
           aria-label={compact ? "Configurações" : undefined}>
            <span className="norium-sidebar-item-icon">
              <IntegrationLogo name="Configurações" size={18} />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Configurações</span>}
          </button>
          <button
            type="button"
            className={`norium-sidebar-item ${activeTab === "Ajuda" ? "is-active" : ""}`}
            onClick={() => navigate("Ajuda")}
            title={compact ? "Ajuda" : undefined}
            aria-current={activeTab === "Ajuda" ? "page" : undefined}
           aria-label={compact ? "Ajuda" : undefined}>
            <span className="norium-sidebar-item-icon">
              <IntegrationLogo name="Ajuda" size={18} />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Ajuda</span>}
          </button>
        </div>

        <button
          type="button"
          className="norium-sidebar-profile"
          onClick={() => navigate("Perfil")}
          title={compact ? profileName : undefined}
         aria-label={compact ? profileName : undefined}>
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
