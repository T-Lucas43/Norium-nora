export type PermissionKey =
  | "dashboard"
  | "central"
  | "emails"
  | "agenda"
  | "chat"
  | "tarefas"
  | "gastos"
  | "automacoes"
  | "relatorios"
  | "propostas"
  | "nora"
  | "perfil"
  | "equipe"
  | "admin"
  | "integracao_gmail"
  | "integracao_whatsapp"
  | "integracao_agenda"
  | "integracao_financeiro";

export type UserRole = "owner" | "member";
export type UserPlan = "free" | "individual" | "equipe" | "enterprise";
export type UserStatus = "ativo" | "inativo";
export type AppMode = "app" | "admin";

export type PermissionMap = Record<PermissionKey, boolean>;

export interface NoriumUser {
  id: string;
  nome: string;
  email: string;
  fotoUrl?: string;
  online?: boolean;
  role: UserRole;
  plan: UserPlan;
  status: UserStatus;
  systemAdmin: boolean;
  teamOwnerId?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string | null;
  requiresPlanSelection?: boolean;
  permissions: PermissionMap;
}

export interface AuthSession {
  token: string;
  user: NoriumUser;
  availableModes: AppMode[];
}

export interface NoriumTeam {
  id: string;
  ownerUserId: string;
  ownerName: string;
  name: string;
  memberCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanInfo {
  code: UserPlan;
  name: string;
  description: string;
  teamSeats: number;
  monthlyPrice: number;
  features: string[];
}

export const permissionLabels: Record<PermissionKey, string> = {
  dashboard: "Dashboard",
  central: "Central de atividades",
  emails: "E-mails",
  agenda: "Agenda",
  chat: "Chat",
  tarefas: "Tarefas",
  gastos: "Financeiro",
  automacoes: "Automações",
  relatorios: "Relatorios",
  propostas: "Propostas e contratos",
  nora: "Nora",
  perfil: "Perfil",
  equipe: "Modo equipe",
  admin: "Admin do sistema",
  integracao_gmail: "Integracao Gmail",
  integracao_whatsapp: "Integracao WhatsApp",
  integracao_agenda: "Integracao Agenda",
  integracao_financeiro: "Integracao financeiro",
};

export const permissionGroups: Array<{ title: string; keys: PermissionKey[] }> = [
  { title: "Telas", keys: ["dashboard", "central", "emails", "agenda", "chat", "tarefas", "gastos", "automacoes", "relatorios", "propostas", "perfil"] },
  { title: "IA e equipe", keys: ["nora", "equipe", "admin"] },
  { title: "Integracoes", keys: ["integracao_gmail", "integracao_whatsapp", "integracao_agenda", "integracao_financeiro"] },
];

export const defaultMemberPermissions: PermissionMap = {
  dashboard: true,
  central: true,
  emails: false,
  agenda: false,
  chat: false,
  tarefas: true,
  gastos: false,
  automacoes: false,
  relatorios: false,
  propostas: false,
  nora: false,
  perfil: true,
  equipe: false,
  admin: false,
  integracao_gmail: false,
  integracao_whatsapp: false,
  integracao_agenda: false,
  integracao_financeiro: false,
};

export const ownerPermissions: PermissionMap = {
  dashboard: true,
  central: true,
  emails: true,
  agenda: true,
  chat: true,
  tarefas: true,
  gastos: true,
  automacoes: true,
  relatorios: true,
  propostas: true,
  nora: true,
  perfil: true,
  equipe: true,
  admin: true,
  integracao_gmail: true,
  integracao_whatsapp: true,
  integracao_agenda: true,
  integracao_financeiro: true,
};

export function normalizePermissions(value?: Partial<PermissionMap> | null, fallback: PermissionMap = defaultMemberPermissions): PermissionMap {
  return {
    ...fallback,
    ...(value || {}),
  };
}

export function canUse(user: NoriumUser | null | undefined, permission: PermissionKey) {
  if (!user) return false;
  if (user.systemAdmin) return true;
  return Boolean(normalizePermissions(user.permissions, user.role === "owner" ? ownerPermissions : defaultMemberPermissions)[permission]);
}
