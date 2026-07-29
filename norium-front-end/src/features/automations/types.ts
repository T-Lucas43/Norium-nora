// Contratos compartilhados retirados do dashboard para reduzir acoplamento.
export type AutomationStatus = "ativa" | "desativada";
export type AutomationEnvironment = "rascunho" | "homologacao" | "producao";
export type FilterKey = "todas" | "ativas" | "desativadas" | "ia" | "recentes";
export type StepKind = "trigger" | "action" | "nora";

export type AutomationNode = {
  id: string;
  kind: StepKind;
  icon: string;
  title: string;
  description: string;
  x: number;
  y: number;
  config?: Record<string, string>;
};

export type AutomationConnection = {
  source: string;
  target: string;
};

export type AutomationFlow = {
  nodes: AutomationNode[];
  connections: AutomationConnection[];
};

export type AutomationHistoryItem = {
  id: string;
  automationId: string;
  automationName: string;
  timestamp: string;
  status: "sucesso" | "erro" | "simulado";
  durationMs: number;
  result: string;
  executedBy: string;
  savedMinutes: number;
  attempt?: number;
  input?: Record<string, unknown>;
  steps?: Array<{
    id: string;
    title: string;
    kind?: StepKind | string;
    status: "pendente" | "executando" | "sucesso" | "erro" | "simulado" | string;
    attempt?: number;
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
    preview?: string;
  }>;
  error?: string | null;
  sideEffects?: boolean;
  resumedFromLogId?: string;
  resumedFromStepId?: string | null;
};

export type AutomationVersion = {
  id: string;
  version: number;
  environment: AutomationEnvironment;
  createdAt: string;
  note?: string;
  content?: Record<string, unknown>;
};

export type Automation = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  trigger: string;
  actions: string[];
  status: AutomationStatus;
  active: boolean;
  aiEnabled: boolean;
  favorite: boolean;
  lastRunAt: string | null;
  executions: number;
  savedMinutes: number;
  savedMinutesPerRun: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  environment?: AutomationEnvironment;
  versions?: AutomationVersion[];
  variables: Record<string, string>;
  schedule: string;
  flow: AutomationFlow;
  logs: AutomationHistoryItem[];
};

export type AutomationTemplate = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

export type AutomationIntegration = {
  name: string;
  status: string;
};

export type TaskProject = {
  id: string;
  name: string;
  category?: string;
  archived?: boolean;
};

export type AutomationMetrics = {
  total: number;
  active: number;
  runsToday: number;
  savedMinutes: number;
};

export type AutomationResponse = {
  automations: Automation[];
  history: AutomationHistoryItem[];
  templates: AutomationTemplate[];
  integrations: AutomationIntegration[];
  metrics: AutomationMetrics;
  updatedAt?: string;
  imported?: number;
};

export type AutomationFormState = {
  name: string;
  description: string;
  icon: string;
  category: string;
  trigger: string;
  actions: string;
  active: boolean;
  aiEnabled: boolean;
  schedule: string;
  taskProjectId: string;
  taskProjectName: string;
  taskCategory: string;
  emailCategory: string;
  retryPolicy: "none" | "once" | "three_times";
  failureAction: "notify" | "pause" | "continue";
  approvalRequired: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
};
