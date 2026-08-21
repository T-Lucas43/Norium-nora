export type EventSource =
  | "gmail"
  | "whatsapp"
  | "calendar"
  | "kanban"
  | "financeiro"
  | "equipe"
  | "automacoes"
  | "brainstorm"
  | "relatorios"
  | "sistema";

export type OmnichannelEvent = {
  id: string;
  source: EventSource;
  title: string;
  description: string;
  timestamp: string;
  metadata: Record<string, unknown>;
};

export type SystemNotificationSeverity = "info" | "success" | "warning" | "error";

export type SystemNotification = {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  severity: SystemNotificationSeverity;
  read: boolean;
  metadata?: Record<string, unknown>;
};

export type SystemNotificationToast = {
  id: string;
  notification: SystemNotification;
  createdAt: number;
};

export type PerfilTema = "escuro" | "claro";

export type TemaCores = {
  primary: string;
  primaryStrong: string;
  primaryDeep: string;
  onPrimary: string;
  gradientStart: string;
  gradientMiddle: string;
  gradientEnd: string;
  background: string;
  surface: string;
  surfaceHover: string;
  border: string;
  text: string;
  textSecondary: string;
  success: string;
  warning: string;
  danger: string;
};

export type TemaPersonalizado = {
  enabled: boolean;
  claro: TemaCores;
  escuro: TemaCores;
};

export type PerfilOperador = {
  fotoUrl: string;
  nome: string;
  cep: string;
  idioma: string;
  tema: PerfilTema;
  tema_personalizado: TemaPersonalizado;
  configuracoes_nora: {
    sarcasmo: number;
  };
};
