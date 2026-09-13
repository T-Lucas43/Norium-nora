// Calculo de produtividade, financeiro e serie temporal - extraido de ReportsDashboard.tsx
// para separar a logica de dados da renderizacao (sem mudanca de comportamento).
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";
import type {
  EventImpact,
  FinanceCategoryTotal,
  FinanceData,
  FinanceEntry,
  FinanceMetrics,
  Period,
  ProductivityMetrics,
} from "./types";

export const sourceLabels: Record<EventSource, string> = {
  gmail: "Gmail",
  whatsapp: "WhatsApp",
  calendar: "Agenda",
  kanban: "Tarefas",
  financeiro: "Gastos",
  equipe: "Equipe",
  automacoes: "Automações",
  relatorios: "Relatórios",
  brainstorm: "Estúdio",
  sistema: "Sistema",
};

export const periodLabels: Record<Period, string> = {
  "24h": "Ultimas 24h",
  "7d": "Ultimos 7 dias",
  all: "Tudo",
};

export const emptyFinanceData: FinanceData = {
  lancamentos: [],
  programados: [],
  boletos: [],
  lembretes: [],
  resumo: {
    entradas: 0,
    saidas: 0,
    saldo: 0,
    pendente: 0,
    vencidos: 0,
    programadosAtivos: 0,
    boletosEncontrados: 0,
  },
};

export function withinPeriod(event: OmnichannelEvent, period: Period) {
  if (period === "all") return true;
  const parsed = Date.parse(event.timestamp);
  if (Number.isNaN(parsed)) return true;
  const range = period === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - parsed <= range;
}

export function timestampValue(timestamp: string) {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatDate(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export type TimeSeriesPoint = { key: string; label: string; total: number };

export function buildTimeSeries(events: OmnichannelEvent[], period: Period): TimeSeriesPoint[] {
  const byHour = period === "24h";
  const buckets = new Map<string, TimeSeriesPoint>();

  function ensureBucket(date: Date) {
    const key = byHour
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!buckets.has(key)) {
      const label = byHour
        ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit" }).format(date)
        : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date);
      buckets.set(key, { key, label, total: 0 });
    }
    return buckets.get(key) as TimeSeriesPoint;
  }

  const now = new Date();
  const spanCount = byHour ? 24 : period === "7d" ? 7 : 14;
  for (let index = spanCount - 1; index >= 0; index -= 1) {
    const reference = new Date(now);
    if (byHour) reference.setHours(reference.getHours() - index, 0, 0, 0);
    else reference.setDate(reference.getDate() - index);
    ensureBucket(reference);
  }

  events.forEach((event) => {
    const parsed = new Date(event.timestamp);
    if (Number.isNaN(parsed.getTime())) return;
    const bucket = ensureBucket(parsed);
    bucket.total += 1;
  });

  return Array.from(buckets.values()).slice(-spanCount);
}

export function formatGeneratedAt() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

export function formatSavedTime(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (hours <= 0) return `${remainingMinutes} min`;
  if (remainingMinutes === 0) return `${hours} h`;
  return `${hours} h ${remainingMinutes} min`;
}

export function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

export function formatFinanceDate(value?: string | null) {
  if (!value) return "Sem data";
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Sem data";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

export function financeTimestampValue(value?: string | null) {
  if (!value) return 0;
  const normalized = String(value).length <= 10 ? `${value}T12:00:00` : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function financeWithinPeriod(value: string | null | undefined, period: Period) {
  if (period === "all") return true;
  const parsed = financeTimestampValue(value);
  if (!parsed) return true;
  const range = period === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - parsed <= range;
}

export function isFinanceEntryInPeriod(entry: FinanceEntry, period: Period) {
  return financeWithinPeriod(entry.paidAt || entry.dueDate || entry.createdAt, period);
}

export function calculateFinanceMetrics(data: FinanceData, period: Period): FinanceMetrics {
  const entries = data.lancamentos
    .filter((entry) => isFinanceEntryInPeriod(entry, period))
    .sort((a, b) => financeTimestampValue(b.paidAt || b.dueDate || b.createdAt) - financeTimestampValue(a.paidAt || a.dueDate || a.createdAt));
  const scheduled = data.programados
    .filter((item) => item.active && financeWithinPeriod(item.nextDueDate, period))
    .sort((a, b) => financeTimestampValue(a.nextDueDate) - financeTimestampValue(b.nextDueDate));
  const boletos = data.boletos
    .filter((item) => financeWithinPeriod(item.dueDate, period))
    .sort((a, b) => financeTimestampValue(a.dueDate) - financeTimestampValue(b.dueDate));
  const paidEntries = entries.filter((entry) => entry.status === "pago");
  const pendingEntries = entries.filter((entry) => entry.status === "pendente");
  const entradas = paidEntries.filter((entry) => entry.type === "entrada").reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const saidas = paidEntries.filter((entry) => entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const pendente = pendingEntries.filter((entry) => entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const vencidos = pendingEntries.filter((entry) => {
    const due = financeTimestampValue(entry.dueDate);
    return due > 0 && due < today.getTime();
  }).length;
  const anexos = entries.reduce((sum, entry) => sum + (entry.attachments?.length || 0), 0);
  const boletosTotal = boletos.reduce((sum, boleto) => sum + Number(boleto.amount || 0), 0);
  const programadoMensal = scheduled.reduce((sum, item) => {
    const amount = item.type === "saida" ? Number(item.amount || 0) : -Number(item.amount || 0);
    if (item.frequency === "semanal") return sum + amount * 4;
    if (item.frequency === "anual") return sum + amount / 12;
    return sum + amount;
  }, 0);
  const categoriesMap = new Map<string, FinanceCategoryTotal>();
  entries
    .filter((entry) => entry.type === "saida")
    .forEach((entry) => {
      const key = entry.category || "geral";
      const current = categoriesMap.get(key) ?? { category: key, amount: 0, count: 0 };
      current.amount += Number(entry.amount || 0);
      current.count += 1;
      categoriesMap.set(key, current);
    });

  return {
    entries,
    scheduled,
    boletos,
    entradas: Number(entradas.toFixed(2)),
    saidas: Number(saidas.toFixed(2)),
    saldo: Number((entradas - saidas).toFixed(2)),
    pendente: Number(pendente.toFixed(2)),
    boletosTotal: Number(boletosTotal.toFixed(2)),
    programadoMensal: Number(programadoMensal.toFixed(2)),
    vencidos,
    anexos,
    pagos: paidEntries.length,
    abertos: pendingEntries.length,
    categories: Array.from(categoriesMap.values())
      .map((item) => ({ ...item, amount: Number(item.amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8),
  };
}

const COMBINING_DIACRITICS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "");
}

function readMetadataString(event: OmnichannelEvent, key: string) {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function readUpdatedStatus(event: OmnichannelEvent) {
  const updates = event.metadata?.updates;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return "";
  const status = (updates as Record<string, unknown>).status;
  return typeof status === "string" ? status : "";
}

export function classifyEvent(event: OmnichannelEvent): EventImpact {
  const title = normalizeText(event.title);
  const description = normalizeText(event.description);
  const status = normalizeText(readMetadataString(event, "status"));
  const updatedStatus = normalizeText(readUpdatedStatus(event));
  const fromMe = event.metadata?.fromMe === true;

  if (event.source === "gmail") {
    if (title.includes("resposta")) {
      return { productivePoints: 2.2, potentialPoints: 2.2, savedMinutes: 8, handled: true, completedTask: false, reason: "Resposta enviada" };
    }
    if (title.includes("rascunho")) {
      return { productivePoints: 1.3, potentialPoints: 1.8, savedMinutes: 4, handled: true, completedTask: false, reason: "Rascunho criado" };
    }
    if (title.includes("enviado")) {
      return { productivePoints: 2, potentialPoints: 2.1, savedMinutes: 6, handled: true, completedTask: false, reason: "E-mail enviado" };
    }
    return { productivePoints: 0.7, potentialPoints: 1.4, savedMinutes: 1, handled: false, completedTask: false, reason: "E-mail monitorado" };
  }

  if (event.source === "whatsapp") {
    if (fromMe || title.includes("enviad") || description.includes("voce:")) {
      return { productivePoints: 1.4, potentialPoints: 1.6, savedMinutes: 2.5, handled: true, completedTask: false, reason: "Mensagem respondida" };
    }
    return { productivePoints: 0.2, potentialPoints: 0.6, savedMinutes: 0.4, handled: false, completedTask: false, reason: "Mensagem triada" };
  }

  if (event.source === "kanban") {
    const isCompleted = status === "concluida" || updatedStatus === "concluida" || title.includes("concluida") || description.includes("concluida");
    if (isCompleted) {
      return { productivePoints: 2.8, potentialPoints: 2.8, savedMinutes: 12, handled: true, completedTask: true, reason: "Tarefa concluida" };
    }
    if (title.includes("criada")) {
      return { productivePoints: 1.4, potentialPoints: 1.7, savedMinutes: 4, handled: true, completedTask: false, reason: "Tarefa criada" };
    }
    if (title.includes("atualizada")) {
      return { productivePoints: 1.2, potentialPoints: 1.6, savedMinutes: 3, handled: true, completedTask: false, reason: "Tarefa movida/atualizada" };
    }
    if (title.includes("comentario")) {
      return { productivePoints: 0.8, potentialPoints: 1.2, savedMinutes: 1.5, handled: true, completedTask: false, reason: "Comentario registrado" };
    }
    if (title.includes("anexo")) {
      return { productivePoints: 0.9, potentialPoints: 1.2, savedMinutes: 2, handled: true, completedTask: false, reason: "Anexo organizado" };
    }
    if (title.includes("apagada")) {
      return { productivePoints: 0.6, potentialPoints: 1, savedMinutes: 1, handled: true, completedTask: false, reason: "Tarefa removida" };
    }
    return { productivePoints: 0.8, potentialPoints: 1.3, savedMinutes: 2, handled: true, completedTask: false, reason: "Movimento no Kanban" };
  }

  if (event.source === "calendar") {
    if (title.includes("criado") || title.includes("compromisso")) {
      return { productivePoints: 1.8, potentialPoints: 2, savedMinutes: 8, handled: true, completedTask: false, reason: "Compromisso criado" };
    }
    return { productivePoints: 0.8, potentialPoints: 1.4, savedMinutes: 2, handled: false, completedTask: false, reason: "Agenda monitorada" };
  }

  if (event.source === "financeiro") {
    if (title.includes("criado") || title.includes("lancamento") || title.includes("boleto")) {
      return { productivePoints: 1.8, potentialPoints: 2.1, savedMinutes: 6, handled: true, completedTask: false, reason: "Financeiro atualizado" };
    }
    if (title.includes("anexo") || description.includes("comprovante")) {
      return { productivePoints: 1.2, potentialPoints: 1.5, savedMinutes: 3, handled: true, completedTask: false, reason: "Comprovante organizado" };
    }
    return { productivePoints: 0.9, potentialPoints: 1.4, savedMinutes: 2, handled: true, completedTask: false, reason: "Gasto monitorado" };
  }

  if (event.source === "equipe") {
    return { productivePoints: 1.1, potentialPoints: 1.5, savedMinutes: 2, handled: true, completedTask: false, reason: "Equipe notificada" };
  }

  if (event.source === "automacoes") {
    return { productivePoints: 2.4, potentialPoints: 2.6, savedMinutes: 8, handled: true, completedTask: false, reason: "Automacao executada" };
  }

  if (event.source === "relatorios") {
    return { productivePoints: 1.6, potentialPoints: 1.8, savedMinutes: 5, handled: true, completedTask: false, reason: "Relatorio gerado" };
  }

  if (event.source === "brainstorm") {
    return { productivePoints: 1.8, potentialPoints: 2, savedMinutes: 5, handled: true, completedTask: false, reason: "Ideia organizada" };
  }

  return { productivePoints: 0.4, potentialPoints: 1, savedMinutes: 0.5, handled: false, completedTask: false, reason: "Evento monitorado" };
}

function createEmptySavedBySource(): Record<EventSource, number> {
  return {
    gmail: 0,
    whatsapp: 0,
    calendar: 0,
    kanban: 0,
    financeiro: 0,
    equipe: 0,
    automacoes: 0,
    relatorios: 0,
    brainstorm: 0,
    sistema: 0,
  };
}

export function calculateProductivity(events: OmnichannelEvent[]): ProductivityMetrics {
  const savedBySource = createEmptySavedBySource();
  let productivePoints = 0;
  let potentialPoints = 0;
  let savedMinutes = 0;
  let productiveEvents = 0;
  let monitoredEvents = 0;
  let completedTasks = 0;
  let emailsHandled = 0;
  let messagesHandled = 0;
  let tasksMoved = 0;
  let scheduledEvents = 0;

  for (const event of events) {
    const impact = classifyEvent(event);
    productivePoints += impact.productivePoints;
    potentialPoints += impact.potentialPoints;
    savedMinutes += impact.savedMinutes;
    savedBySource[event.source] += impact.savedMinutes;

    if (impact.handled) productiveEvents += 1;
    else monitoredEvents += 1;
    if (impact.completedTask) completedTasks += 1;
    if (event.source === "gmail" && impact.handled) emailsHandled += 1;
    if (event.source === "whatsapp" && impact.handled) messagesHandled += 1;
    if (event.source === "kanban" && impact.handled) tasksMoved += 1;
    if (event.source === "calendar" && impact.handled) scheduledEvents += 1;
  }

  const score = potentialPoints > 0 ? Math.min(100, Math.round((productivePoints / potentialPoints) * 100)) : 0;
  return {
    score,
    productivePoints,
    potentialPoints,
    savedMinutes,
    productiveEvents,
    monitoredEvents,
    completedTasks,
    emailsHandled,
    messagesHandled,
    tasksMoved,
    scheduledEvents,
    savedBySource,
  };
}
