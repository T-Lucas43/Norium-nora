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
  "PDF Studio": "propostas",
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
  "PDF Studio",
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

// Identificadores opacos e URL-safe, derivados uma unica vez com SHA-256 e
// mantidos estaveis para preservar favoritos e links internos. Eles escondem os
// nomes dos modulos na barra de endereco; autorizacao continua sendo validada
// pelas permissoes do usuario e pelas APIs do backend.
export const TAB_ROUTES: Record<string, string> = {
  Dashboard: "exrNGzzgnOk0lYO3BYgt",
  Controle: "jfxYjHMnHwHBjSbINCdM",
  Central: "kwdnrV6CNYF5O4g7S10v",
  "Notificações": "9kFx3XKmTCFQkxAC5ay7",
  "E-mails": "JKN2Ao2FEOCj2RkjEPpH",
  Agenda: "2JmCCrXr4UkP7niJzS_c",
  Agendamentos: "2SZ5TBMsipUWdiU0F1XR",
  Chat: "dSlgZL0DMGQm5JjdLMrs",
  Tarefas: "VVmtt4GQBMGjMOuNiSKO",
  Financeiro: "ys87LpNel5w6xYGCVbIf",
  "Automações": "lp0o-NInK2OC0mKzfmFn",
  "Relatórios": "3cJFfwt2cAzPvEuDRHES",
  Documentos: "Dg0lq0vU62BoSxh9kL-8",
  "PDF Studio": "dprD0Dro2ucZ75g3P1nl",
  "Agente Navegador": "AARiyfLZK5fNF9M0Gvxq",
  Conhecimento: "0Ft7l1c9zvMbx_CcmLO3",
  Marketplace: "j8h-EllyyxZtlMcOZx1J",
  "IA e Modelos": "-kxWBFn1A67cb8Evxw8z",
  Equipe: "Xwv19qjfPOj9px_vx0iB",
  "Chat da Equipe": "mWUGDR9WnHA2zM0AvIOv",
  Clientes: "WvuuIjoboC60OWXjOQUY",
  Governanca: "x8j96NfSqKs0GJ7sKISt",
  "Estúdio": "4UXAqQ7JdDt88e6Js6_f",
  Nora: "khW_OrvF3ZYPq5Io7Lf_",
  Mais: "0TeJT8GQTU6jtJUgVxol",
  Perfil: "-wsdJB_o7sZC7jWPw8XT",
  "Configurações": "yIH5s7vdXPjuecFkMSNJ",
  Ajuda: "6iwSNyjEDdb4gPjPQMoL",
};

const LEGACY_TAB_ROUTES: Record<string, string> = {
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
  "PDF Studio": "pdf-studio",
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

const ROUTE_TABS = new Map(Object.entries(TAB_ROUTES).map(([tab, route]) => [route.toLowerCase(), tab]));
const LEGACY_ROUTE_TABS = new Map(Object.entries(LEGACY_TAB_ROUTES).map(([tab, route]) => [route, tab]));

LEGACY_ROUTE_TABS.set("brainstorm", "Estúdio");
LEGACY_ROUTE_TABS.set("pendencias", "Central");

export function canonicalTab(tab: string) {
  return TAB_ALIASES[tab] || tab;
}

export function tabPath(tab: string) {
  const canonical = canonicalTab(tab);
  return `/app/${TAB_ROUTES[canonical] || TAB_ROUTES.Dashboard}`;
}

export function tabFromPath(pathname = window.location.pathname) {
  const match = pathname.match(/^\/app\/([^/]+)\/?$/i);
  if (!match) return null;
  const route = match[1].toLowerCase();
  return ROUTE_TABS.get(route) || LEGACY_ROUTE_TABS.get(route) || null;
}

export function normalizeNoriumTabPath() {
  const tab = tabFromPath();
  if (!tab) return null;
  const path = tabPath(tab);
  if (window.location.pathname !== path) {
    const state = { ...(window.history.state || {}), noriumView: "app", noriumTab: canonicalTab(tab) };
    window.history.replaceState(state, "", `${path}${window.location.search}`);
  }
  return tab;
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
