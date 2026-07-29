import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BrainCircuit,
  CalendarDays,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  CreditCard,
  Ellipsis,
  GitBranch,
  Inbox,
  LayoutDashboard,
  Mail,
  MessageSquare,
  ListChecks,
  Settings,
  ShieldCheck,
  UsersRound,
  UserRoundCheck,
  X,
} from "lucide-react";
import type { NoriumUser } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import BrandLogo from "./BrandLogo";

type NavigationItem = {
  title: string;
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
};

const navigation: NavigationItem[] = [
  { title: "Dashboard", icon: LayoutDashboard },
  { title: "Controle", icon: ClipboardCheck },
  { title: "Central", icon: Inbox },
  { title: "Pendencias", icon: ListChecks },
  { title: "E-mails", icon: Mail },
  { title: "Agenda", icon: CalendarDays },
  { title: "Chat", icon: MessageSquare },
  { title: "Tarefas", icon: CheckSquare },
  { title: "Gastos", icon: CreditCard },
  { title: "Automações", icon: GitBranch },
  { title: "Relatorios", icon: BarChart3 },
  { title: "Equipe", icon: UsersRound },
  { title: "Clientes", icon: UserRoundCheck },
  { title: "Governanca", icon: ShieldCheck },
  { title: "Brainstorm", icon: BrainCircuit },
  { title: "Mais", icon: Ellipsis },
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
            const Icon = item.icon;
            const active =
              activeTab === item.title ||
              (activeTab === "Inbox" && item.title === "Central") ||
              (activeTab === "Automacoes" && item.title === "Automações");

            return (
              <button
                key={item.title}
                type="button"
                className={`norium-sidebar-item ${active ? "is-active" : ""}`}
                onClick={() => navigate(item.title)}
                title={compact ? item.title : undefined}
                aria-current={active ? "page" : undefined}
              >
                <span className="norium-sidebar-item-icon">
                  <Icon size={18} />
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
            onClick={() => navigate("Configuracoes")}
            title={compact ? "Configurações" : undefined}
          >
            <span className="norium-sidebar-item-icon">
              <Settings size={18} />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Configurações</span>}
          </button>
          <button
            type="button"
            className={`norium-sidebar-item ${activeTab === "Ajuda" ? "is-active" : ""}`}
            onClick={() => navigate("Ajuda")}
            title={compact ? "Ajuda" : undefined}
            aria-current={activeTab === "Ajuda" ? "page" : undefined}
          >
            <span className="norium-sidebar-item-icon">
              <CircleHelp size={18} />
            </span>
            {!compact && <span className="norium-sidebar-item-label">Ajuda</span>}
          </button>
        </div>

        <button
          type="button"
          className="norium-sidebar-profile"
          onClick={() => navigate("Perfil")}
          title={compact ? profileName : undefined}
        >
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
