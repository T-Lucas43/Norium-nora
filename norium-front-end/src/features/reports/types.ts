// Contratos dos indicadores extraidos para manter o dashboard legivel.
import type { EventSource } from "../../types/omnichannel";

export type Period = "24h" | "7d" | "all";
export type ReportSource = EventSource | "all";
export type ReportSection = "summary" | "productivity" | "savedTime" | "channels" | "finance" | "health" | "events";

export type ReportCustomizerState = {
  title: string;
  period: Period;
  source: ReportSource;
  eventLimit: number;
  sections: Record<ReportSection, boolean>;
};

export type EventImpact = {
  productivePoints: number;
  potentialPoints: number;
  savedMinutes: number;
  handled: boolean;
  completedTask: boolean;
  reason: string;
};

export type ProductivityMetrics = {
  score: number;
  productivePoints: number;
  potentialPoints: number;
  savedMinutes: number;
  productiveEvents: number;
  monitoredEvents: number;
  completedTasks: number;
  emailsHandled: number;
  messagesHandled: number;
  tasksMoved: number;
  scheduledEvents: number;
  savedBySource: Record<EventSource, number>;
};

export type FinanceAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
};

export type FinanceEntry = {
  id: string;
  title: string;
  description: string;
  type: "entrada" | "saida";
  amount: number;
  category: string;
  method: string;
  status: "pendente" | "pago" | "cancelado";
  dueDate: string | null;
  paidAt: string | null;
  attachments: FinanceAttachment[];
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceScheduled = {
  id: string;
  title: string;
  description: string;
  type: "entrada" | "saida";
  amount: number;
  category: string;
  frequency: "unico" | "semanal" | "mensal" | "anual";
  nextDueDate: string | null;
  remindDaysBefore: number;
  active: boolean;
};

export type FinanceBoleto = {
  id: string;
  title: string;
  beneficiary: string;
  amount: number;
  dueDate: string | null;
  status: string;
  barcode: string;
  source: string;
};

export type FinanceData = {
  lancamentos: FinanceEntry[];
  programados: FinanceScheduled[];
  boletos: FinanceBoleto[];
  lembretes: Array<{ id: string; kind: string; title: string; amount: number; dueDate: string | null; daysUntil: number }>;
  resumo: {
    entradas: number;
    saidas: number;
    saldo: number;
    pendente: number;
    vencidos: number;
    programadosAtivos: number;
    boletosEncontrados: number;
  };
  updatedAt?: string;
};

export type FinanceCategoryTotal = {
  category: string;
  amount: number;
  count: number;
};

export type FinanceMetrics = {
  entries: FinanceEntry[];
  scheduled: FinanceScheduled[];
  boletos: FinanceBoleto[];
  entradas: number;
  saidas: number;
  saldo: number;
  pendente: number;
  boletosTotal: number;
  programadoMensal: number;
  vencidos: number;
  anexos: number;
  pagos: number;
  abertos: number;
  categories: FinanceCategoryTotal[];
};

export type PdfColor = [number, number, number];

export type PdfLine = {
  text: string;
  size?: number;
  gap?: number;
  indent?: number;
  bold?: boolean;
  color?: PdfColor;
  variant?: "text" | "section" | "card" | "bar" | "event";
  value?: string;
  ratio?: number;
  barColor?: PdfColor;
  keepWithNext?: number;
};
