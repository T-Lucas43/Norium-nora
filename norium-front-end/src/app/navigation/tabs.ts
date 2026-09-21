import { canParticipateInTeamChat, canUse, type NoriumUser, type PermissionKey } from "../../types/auth";


export const TAB_PERMISSIONS: Record<string, PermissionKey | null> = {
  Dashboard: "dashboard",
  Resumo: "dashboard",
  Controle: "dashboard",
  Central: "central",
  Pendencias: "central",
  Inbox: "central",
  Notificacoes: "central",
  "Notificações": "central",
  "E-mails": "emails",
  "E-mail": "emails",
  Agenda: "agenda",
  Agendamentos: "agenda",
  Chat: "chat",
  "Chat da Equipe": "chat",
  Tarefas: "tarefas",
  Gastos: "gastos",
  Financeiro: "gastos",
  Automacoes: "automacoes",
  "Automações": "automacoes",
  Relatorios: "relatorios",
  Documentos: "propostas",
  Propostas: "propostas",
  "Agente Navegador": "navegador",
  Conhecimento: "conhecimento",
  Marketplace: "marketplace",
  "IA e Modelos": "modelos",
  "Relatórios": "relatorios",
  Perfil: "perfil",
  Configuracoes: "perfil",
  "Configurações": "perfil",
  Equipe: "equipe",
  Brainstorm: "equipe",
  "Estúdio": "equipe",
  Nora: "nora",
  Clientes: "central",
  Governanca: "equipe",
  Ajuda: "dashboard",
  Mais: "dashboard",
};

export const PRIMARY_TABS = [
  "Dashboard",
  "Controle",
  "Central",
  "E-mails",
  "Agenda",
  "Agendamentos",
  "Chat",
  "Tarefas",
  "Financeiro",
  "Automações",
  "Relatórios",
  "Documentos",
  "Agente Navegador",
  "Conhecimento",
  "Marketplace",
  "IA e Modelos",
  "Equipe",
  "Chat da Equipe",
  "Clientes",
  "Governanca",
  "Estúdio",
  "Nora",
  "Mais",
];

export const ACTIVE_TAB_STORAGE = "norium-active-tab";

const TAB_ALIASES: Record<string, string> = {
  Brainstorm: "Estúdio",
  Resumo: "Dashboard",
  Inbox: "Central",
  Pendencias: "Central",
  "Pendências": "Central",
  "E-mail": "E-mails",
  Gastos: "Financeiro",
  Automacoes: "Automações",
  Relatorios: "Relatórios",
  Propostas: "Documentos",
  Configuracoes: "Configurações",
  Notificacoes: "Notificações",
};

export function canAccessModule(user: NoriumUser | null | undefined, tab: string): boolean {
  if (tab === "Chat da Equipe") return canParticipateInTeamChat(user);
  const permission = TAB_PERMISSIONS[tab];
  return !permission || canUse(user, permission);
}

export const TAB_ROUTES: Record<string, string> = {
  Dashboard: "dashboard",
  Controle: "controle",
  Central: "central",
  "Notificações": "notificacoes",
  "E-mails": "emails",
  Agenda: "agenda",
  Agendamentos: "agendamentos",
  Chat: "chat",
  Tarefas: "tarefas",
  Financeiro: "financeiro",
  "Automações": "automacoes",
  "Relatórios": "relatorios",
  Documentos: "documentos",
  "Agente Navegador": "navegador",
  Conhecimento: "conhecimento",
  Marketplace: "marketplace",
  "IA e Modelos": "ia-modelos",
  Equipe: "equipe",
  "Chat da Equipe": "chat-equipe",
  Clientes: "clientes",
  Governanca: "governanca",
  "Estúdio": "estudio",
  Nora: "nora",
  Mais: "mais",
  Perfil: "perfil",
  "Configurações": "configuracoes",
  Ajuda: "ajuda",
};

const ROUTE_TABS = new Map(Object.entries(TAB_ROUTES).map(([tab, route]) => [route, tab]));

ROUTE_TABS.set("brainstorm", "Estúdio");
ROUTE_TABS.set("pendencias", "Central");

export function canonicalTab(tab: string) {
  return TAB_ALIASES[tab] || tab;
}

export function tabPath(tab: string) {
  const canonical = canonicalTab(tab);
  return `/app/${TAB_ROUTES[canonical] || TAB_ROUTES.Dashboard}`;
}

export function tabFromPath(pathname = window.location.pathname) {
  const match = pathname.match(/^\/app\/([^/]+)\/?$/i);
  return match ? ROUTE_TABS.get(match[1].toLowerCase()) || null : null;
}

export function navigateNoriumTab(tab: string, options: { replace?: boolean } = {}) {
  const canonical = canonicalTab(tab);
  const path = tabPath(canonical);
  const destination = `${path}${window.location.search}`;
  const state = { ...(window.history.state || {}), noriumView: "app", noriumTab: canonical };
  if (options.replace || window.location.pathname === path) {
    window.history.replaceState(state, "", destination);
  } else {
    window.history.pushState(state, "", destination);
  }
}

export function initialTab() {
  const routed = tabFromPath();
  if (routed) return routed;
  const saved = localStorage.getItem(ACTIVE_TAB_STORAGE);
  const canonical = saved ? canonicalTab(saved) : "";
  return canonical && TAB_PERMISSIONS[canonical] !== undefined ? canonical : "Dashboard";
}
