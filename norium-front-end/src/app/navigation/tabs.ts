import type { PermissionKey } from "../../types/auth";


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
  Chat: "chat",
  Tarefas: "tarefas",
  Gastos: "gastos",
  Financeiro: "gastos",
  Automacoes: "automacoes",
  "Automações": "automacoes",
  Relatorios: "relatorios",
  "Relatórios": "relatorios",
  Perfil: "perfil",
  Configuracoes: "perfil",
  "Configurações": "perfil",
  Equipe: "equipe",
  Brainstorm: "equipe",
  Clientes: "central",
  Governanca: "equipe",
  Ajuda: "dashboard",
  Mais: "dashboard",
};

export const PRIMARY_TABS = [
  "Dashboard",
  "Controle",
  "Central",
  "Pendencias",
  "E-mails",
  "Agenda",
  "Chat",
  "Tarefas",
  "Financeiro",
  "Automações",
  "Relatorios",
  "Equipe",
  "Clientes",
  "Governanca",
  "Brainstorm",
  "Mais",
];

export const ACTIVE_TAB_STORAGE = "norium-active-tab";

export function initialTab() {
  const saved = localStorage.getItem(ACTIVE_TAB_STORAGE);
  return saved && TAB_PERMISSIONS[saved] !== undefined ? saved : "Dashboard";
}
