import { canonicalTab } from "./tabs";

// Download code on navigation intent. Modules still mount only when selected.
export const panelModules = {
  Nora: () => import("../../components/nora/NoraWorkspace"),
  Dashboard: () => import("../../components/dashboard/Dashboard"),
  Central: () => import("../../components/workhub/WorkHubDashboard"),
  Controle: () => import("../../components/operations/OperationsDashboard"),
  "Notificações": () => import("../../components/notifications/SystemNotificationsCenter"),
  "E-mails": () => import("../../components/emails/EmailDashboard"),
  Agenda: () => import("../../components/agenda/AgendaDashboard"),
  Chat: () => import("../../components/chat/ChatCentral"),
  Tarefas: () => import("../../components/tasks/TasksDashboard"),
  Financeiro: () => import("../../components/finance/FinanceDashboard"),
  "Automações": () => import("../../components/automations/AutomationsDashboard"),
  "Relatórios": () => import("../../components/reports/ReportsDashboard"),
  Documentos: () => import("../../components/commercial/CommercialDashboard"),
  "Estúdio": () => import("../../components/brainstorm/BrainstormDashboard"),
  Clientes: () => import("../../components/clients/ClientsDashboard"),
  Equipe: () => import("../../components/team/TeamDashboard"),
  "Chat da Equipe": () => import("../../components/team-chat/TeamChatDrawer"),
  Governanca: () => import("../../components/platform/PlatformDashboard"),
  Mais: () => import("../../components/more/MoreDashboard"),
  Perfil: () => import("../../components/profile/ProfileSettings"),
  "Configurações": () => import("../../components/settings/SettingsDashboard"),
  Ajuda: () => import("../../components/help/HelpDashboard"),
  Conhecimento: () => import("../../components/intelligence/IntelligenceHubDashboard"),
  Marketplace: () => import("../../components/intelligence/IntelligenceHubDashboard"),
  "IA e Modelos": () => import("../../components/intelligence/IntelligenceHubDashboard"),
  "Agente Navegador": () => import("../../components/intelligence/IntelligenceHubDashboard"),
};
const warming = new Set<string>();

export function preloadPanel(tab: string) {
  const key = canonicalTab(tab);
  const loader = panelModules[key as keyof typeof panelModules];
  if (!loader || warming.has(key)) return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || "")) return;
  warming.add(key);
  void loader().catch(() => warming.delete(key));
}
