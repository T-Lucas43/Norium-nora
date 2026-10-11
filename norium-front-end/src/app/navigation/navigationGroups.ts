// Estrutura do menu (layout do PDF). As chaves das telas continuam as mesmas
// para rotas e permissões; só a organização e os rótulos exibidos mudam.

// Telas exibidas juntas, com abas internas.
export const INTELLIGENCE_TABS = ["Conhecimento", "Agente Navegador", "Marketplace", "IA e Modelos"];
export const SETTINGS_TABS = ["Configurações", "Perfil"];

export type NavigationGroupConfig = {
  label: string;
  items: string[];
  /** Grupo exibido como um item único que abre a primeira aba permitida. */
  single?: boolean;
};

export const NAVIGATION_GROUPS: NavigationGroupConfig[] = [
  { label: "Início", items: ["Central", "Controle"] },
  { label: "Comunicação", items: ["Chat", "E-mails", "Modelos de mensagens", "Chat da Equipe"] },
  { label: "Agenda", items: ["Agenda", "Agendamentos"] },
  { label: "Trabalho", items: ["Tarefas", "Clientes", "Documentos", "PDF Studio", "Estúdio"] },
  { label: "Gestão", items: ["Financeiro", "Automações", "Relatórios"] },
  { label: "Inteligência", items: INTELLIGENCE_TABS, single: true },
  { label: "Equipe", items: ["Equipe", "Governanca", "Mais"] },
];

export const DISPLAY_LABELS: Record<string, string> = {
  Dashboard: "Painel",
  Chat: "Conversas",
  "Chat da Equipe": "Chat da equipe",
  Governanca: "Governança",
  Configuracoes: "Configurações",
  Automacoes: "Automações",
  Relatorios: "Relatórios",
  Notificacoes: "Notificações",
  Inbox: "Central",
  Gastos: "Financeiro",
  Brainstorm: "Estúdio",
};

const ALIASES: Record<string, string> = {
  Inbox: "Central",
  Automacoes: "Automações",
  Relatorios: "Relatórios",
  Configuracoes: "Configurações",
  Gastos: "Financeiro",
  Brainstorm: "Estúdio",
  "E-mail": "E-mails",
  Propostas: "Documentos",
  Resumo: "Dashboard",
  Notificacoes: "Notificações",
};

export function normalizeTab(tab: string) {
  return ALIASES[tab] ?? tab;
}

export function displayLabel(tab: string) {
  return DISPLAY_LABELS[tab] ?? tab;
}

/** Caminho exibido no topo: "Grupo / Tela". */
export function breadcrumbFor(tab: string): { group: string | null; title: string } {
  const key = normalizeTab(tab);
  if (SETTINGS_TABS.includes(key)) return { group: "Configurações", title: displayLabel(key) };
  const group = NAVIGATION_GROUPS.find((item) => item.items.includes(key));
  return { group: group?.label ?? null, title: displayLabel(key) };
}
