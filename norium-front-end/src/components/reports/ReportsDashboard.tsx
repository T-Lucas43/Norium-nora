import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import {
  Activity,
  BarChart3,
  CalendarDays,
  CheckSquare,
  Clock3,
  CreditCard,
  Download,
  FileText,
  Gauge,
  GitBranch,
  Lightbulb,
  ListChecks,
  Mail,
  MessageSquare,
  PanelLeftOpen,
  Printer,
  RefreshCw,
  Receipt,
  ShieldAlert,
  SlidersHorizontal,
  Target,
  Wallet,
  TrendingUp,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EventSource, OmnichannelEvent, SystemNotification } from "../../types/omnichannel";
import { loadFinanceReportData, registerReportEvent } from "../../features/reports/api";
import type {
  EventImpact,
  FinanceCategoryTotal,
  FinanceData,
  FinanceEntry,
  FinanceMetrics,
  PdfColor,
  PdfLine,
  Period,
  ProductivityMetrics,
  ReportCustomizerState,
  ReportSection,
  ReportSource,
} from "../../features/reports/types";
import noriumLogo from "../../assets/logo-text-white.png";

type ReportsDashboardProps = {
  eventsBySource: Record<EventSource, OmnichannelEvent[]>;
  notifications: SystemNotification[];
  connected: boolean;
  userId?: string;
};

const sourceMeta: Record<EventSource, { label: string; icon: LucideIcon; color: string; tabColor: string }> = {
  gmail: { label: "Gmail", icon: Mail, color: "bg-red-500", tabColor: "text-red-400 bg-red-500/10" },
  whatsapp: { label: "WhatsApp", icon: MessageSquare, color: "bg-emerald-500", tabColor: "text-emerald-400 bg-emerald-500/10" },
  telegram: { label: "Telegram", icon: MessageSquare, color: "bg-sky-500", tabColor: "text-sky-400 bg-sky-500/10" },
  calendar: { label: "Agenda", icon: CalendarDays, color: "bg-blue-500", tabColor: "text-blue-400 bg-blue-500/10" },
  kanban: { label: "Tarefas", icon: CheckSquare, color: "bg-cyan-500", tabColor: "text-cyan-400 bg-cyan-500/10" },
  financeiro: { label: "Gastos", icon: CreditCard, color: "bg-teal-500", tabColor: "text-teal-400 bg-teal-500/10" },
  equipe: { label: "Equipe", icon: UsersRound, color: "bg-indigo-500", tabColor: "text-indigo-300 bg-indigo-500/10" },
  automacoes: { label: "Automações", icon: GitBranch, color: "bg-sky-600", tabColor: "text-sky-300 bg-sky-500/10" },
  relatorios: { label: "Relatórios", icon: BarChart3, color: "bg-amber-500", tabColor: "text-amber-300 bg-amber-500/10" },
  brainstorm: { label: "Brainstorm", icon: Lightbulb, color: "bg-cyan-600", tabColor: "text-cyan-300 bg-cyan-500/10" },
  sistema: { label: "Sistema", icon: ShieldAlert, color: "bg-violet-500", tabColor: "text-violet-300 bg-violet-500/10" },
};

const periodLabels: Record<Period, string> = {
  "24h": "Ultimas 24h",
  "7d": "Ultimos 7 dias",
  all: "Tudo",
};

const defaultReportSections: Record<ReportSection, boolean> = {
  summary: true,
  productivity: true,
  savedTime: true,
  channels: true,
  finance: true,
  health: true,
  events: true,
};

const defaultReportCustomizer: ReportCustomizerState = {
  title: "Relatorio operacional Norium",
  period: "7d",
  source: "all",
  eventLimit: 18,
  sections: defaultReportSections,
};

const sectionLabels: Record<ReportSection, string> = {
  summary: "Resumo executivo",
  productivity: "Produtividade",
  savedTime: "Tempo economizado",
  channels: "Volume por canal",
  finance: "Financeiro",
  health: "Saude operacional",
  events: "Eventos recentes",
};

type PdfThemeName = "dark" | "light";

const pdfTheme = {
  background: [0.043, 0.071, 0.125] as PdfColor,
  surface: [0.082, 0.118, 0.196] as PdfColor,
  surfaceSoft: [0.118, 0.165, 0.267] as PdfColor,
  border: [0.18, 0.26, 0.4] as PdfColor,
  text: [0.96, 0.98, 1] as PdfColor,
  muted: [0.64, 0.72, 0.84] as PdfColor,
  blue: [0.10, 0.38, 0.88] as PdfColor,
  cyan: [0.02, 0.72, 0.88] as PdfColor,
  emerald: [0.02, 0.74, 0.52] as PdfColor,
  amber: [0.96, 0.66, 0.22] as PdfColor,
};

const lightPdfTheme = {
  background: [0.94, 0.97, 1] as PdfColor,
  surface: [1, 1, 1] as PdfColor,
  surfaceSoft: [0.92, 0.96, 1] as PdfColor,
  border: [0.70, 0.79, 0.91] as PdfColor,
  text: [0.04, 0.10, 0.20] as PdfColor,
  muted: [0.30, 0.39, 0.52] as PdfColor,
  blue: [0.08, 0.36, 0.86] as PdfColor,
  cyan: [0.02, 0.62, 0.78] as PdfColor,
  emerald: [0.02, 0.58, 0.40] as PdfColor,
  amber: [0.88, 0.48, 0.08] as PdfColor,
};

function renderPdfColor(color: PdfColor | undefined, theme: typeof pdfTheme, fallback: PdfColor) {
  if (!color) return fallback;
  const key = (Object.keys(pdfTheme) as Array<keyof typeof pdfTheme>).find((candidate) =>
    pdfTheme[candidate].every((channel, index) => Math.abs(channel - color[index]) < 0.0001),
  );
  return key ? theme[key] : color;
}

const sourcePdfColors: Record<EventSource, PdfColor> = {
  gmail: [0.94, 0.24, 0.32],
  whatsapp: [0.02, 0.74, 0.52],
  telegram: [0.18, 0.62, 0.92],
  calendar: [0.22, 0.48, 0.96],
  kanban: [0.02, 0.72, 0.88],
  financeiro: [0.05, 0.70, 0.62],
  equipe: [0.39, 0.45, 0.96],
  automacoes: [0.10, 0.55, 0.90],
  relatorios: [0.96, 0.66, 0.22],
  brainstorm: [0.02, 0.72, 0.88],
  sistema: [0.55, 0.36, 0.96],
};

function sourceChartColor(source: EventSource) {
  const [r, g, b] = pdfColor(sourcePdfColors[source]);
  return `rgb(${r}, ${g}, ${b})`;
}

const emptyFinanceData: FinanceData = {
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

function withinPeriod(event: OmnichannelEvent, period: Period) {
  if (period === "all") return true;
  const parsed = Date.parse(event.timestamp);
  if (Number.isNaN(parsed)) return true;
  const range = period === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - parsed <= range;
}

function timestampValue(timestamp: string) {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

type TimeSeriesPoint = { key: string; label: string; total: number };

function buildTimeSeries(events: OmnichannelEvent[], period: Period): TimeSeriesPoint[] {
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

function formatGeneratedAt() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

function formatSavedTime(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (hours <= 0) return `${remainingMinutes} min`;
  if (remainingMinutes === 0) return `${hours} h`;
  return `${hours} h ${remainingMinutes} min`;
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function formatFinanceDate(value?: string | null) {
  if (!value) return "Sem data";
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Sem data";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

function financeTimestampValue(value?: string | null) {
  if (!value) return 0;
  const normalized = String(value).length <= 10 ? `${value}T12:00:00` : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function financeWithinPeriod(value: string | null | undefined, period: Period) {
  if (period === "all") return true;
  const parsed = financeTimestampValue(value);
  if (!parsed) return true;
  const range = period === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - parsed <= range;
}

function isFinanceEntryInPeriod(entry: FinanceEntry, period: Period) {
  return financeWithinPeriod(entry.paidAt || entry.dueDate || entry.createdAt, period);
}

function calculateFinanceMetrics(data: FinanceData, period: Period): FinanceMetrics {
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

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

function classifyEvent(event: OmnichannelEvent): EventImpact {
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

  if (event.source === "whatsapp" || event.source === "telegram") {
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
    telegram: 0,
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

function calculateProductivity(events: OmnichannelEvent[]): ProductivityMetrics {
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
    if ((event.source === "whatsapp" || event.source === "telegram") && impact.handled) messagesHandled += 1;
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

function csvEscape(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function sanitizePdfText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapPdfText(text: string, maxChars: number) {
  const words = sanitizePdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pushPdfLine(lines: PdfLine[], text = "", options: Omit<PdfLine, "text"> = {}) {
  const maxChars = options.size && options.size >= 16 ? 64 : 92;
  const wrapped = wrapPdfText(text, maxChars);
  wrapped.forEach((line, index) => {
    lines.push({
      ...options,
      text: line,
      gap: index === 0 ? options.gap : options.size ? options.size + 4 : 14,
    });
  });
}

function pushPdfSection(lines: PdfLine[], text: string, keepWithNext = 32) {
  lines.push({ text, variant: "section", size: 15, gap: 30, bold: true, color: pdfTheme.cyan, keepWithNext });
}

function pushPdfCard(lines: PdfLine[], label: string, value: string, color: PdfColor = pdfTheme.text) {
  lines.push({ text: label, value, variant: "card", gap: 66, color, barColor: color });
}

function pushPdfBar(lines: PdfLine[], label: string, value: string, ratio: number, color: PdfColor = pdfTheme.cyan) {
  lines.push({ text: label, value, ratio, variant: "bar", gap: 24, barColor: color });
}

function pushPdfEvent(lines: PdfLine[], title: string, description: string) {
  lines.push({
    text: sanitizePdfText(title),
    value: sanitizePdfText(description),
    variant: "event",
    color: pdfTheme.text,
  });
}

function pdfChannel(color: number) {
  return Math.max(0, Math.min(255, Math.round(color * 255)));
}

function pdfColor(color: PdfColor): [number, number, number] {
  return [pdfChannel(color[0]), pdfChannel(color[1]), pdfChannel(color[2])];
}

async function loadReportLogo() {
  try {
    const response = await fetch(noriumLogo);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function createPdfBlob(lines: PdfLine[], themeName: PdfThemeName = "dark") {
  const theme = themeName === "light" ? lightPdfTheme : pdfTheme;
  const document = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait", compress: true });
  const pageWidth = document.internal.pageSize.getWidth();
  const pageHeight = document.internal.pageSize.getHeight();
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;
  const headerHeight = 126;
  const contentTop = headerHeight + 46;
  const contentBottom = pageHeight - 54;
  const logoData = await loadReportLogo();
  let cursorY = contentTop;
  let pageNumber = 1;

  const fill = (color: PdfColor) => document.setFillColor(...pdfColor(color));
  const stroke = (color: PdfColor) => document.setDrawColor(...pdfColor(color));
  const textColor = (color: PdfColor) => document.setTextColor(...pdfColor(color));

  function drawPageFrame() {
    fill(theme.background);
    document.rect(0, 0, pageWidth, pageHeight, "F");
    fill(theme.surface);
    document.roundedRect(24, 20, pageWidth - 48, pageHeight - 40, 10, 10, "F");

    const gradientSteps = 24;
    for (let index = 0; index < gradientSteps; index += 1) {
      const ratio = index / Math.max(1, gradientSteps - 1);
      const color: PdfColor = [
        theme.blue[0] + (theme.cyan[0] - theme.blue[0]) * ratio,
        theme.blue[1] + (theme.cyan[1] - theme.blue[1]) * ratio,
        theme.blue[2] + (theme.cyan[2] - theme.blue[2]) * ratio,
      ];
      fill(color);
      document.rect(24 + ((pageWidth - 48) / gradientSteps) * index, 20, (pageWidth - 48) / gradientSteps + 1, headerHeight, "F");
    }

    if (logoData) {
      document.addImage(logoData, "PNG", marginX, 43, 74, 28, undefined, "FAST");
    } else {
      document.setFont("helvetica", "bold");
      document.setFontSize(17);
      document.setTextColor(255, 255, 255);
      document.text("NORIUM", marginX, 64);
    }
    document.setFont("helvetica", "bold");
    document.setFontSize(15);
    document.setTextColor(255, 255, 255);
    document.text("Relatorio operacional inteligente", marginX, 96);
    document.setFont("helvetica", "normal");
    document.setFontSize(8.5);
    document.setTextColor(222, 240, 255);
    document.text("Dados, produtividade e canais em uma leitura executiva.", marginX, 113);
  }

  function drawFooter() {
    stroke(theme.border);
    document.setLineWidth(0.8);
    document.line(marginX, pageHeight - 40, pageWidth - marginX, pageHeight - 40);
    document.setFont("helvetica", "normal");
    document.setFontSize(7.5);
    textColor(theme.muted);
    document.text(`Norium | Gerado em ${sanitizePdfText(formatGeneratedAt())}`, marginX, pageHeight - 25);
    document.text(`Pagina ${pageNumber}`, pageWidth - marginX, pageHeight - 25, { align: "right" });
  }

  function addPage() {
    drawFooter();
    document.addPage();
    pageNumber += 1;
    drawPageFrame();
    cursorY = contentTop;
  }

  function ensureSpace(height: number) {
    if (cursorY + height > contentBottom) addPage();
  }

  drawPageFrame();

  for (const line of lines) {
    const size = line.size ?? 10;
    const x = marginX + (line.indent ?? 0);
    const availableWidth = contentWidth - (line.indent ?? 0);

    if (line.variant === "section") {
      ensureSpace(38 + (line.keepWithNext ?? 0));
      document.setFont("helvetica", "bold");
      document.setFontSize(size);
      textColor(renderPdfColor(line.color, theme, theme.cyan));
      document.text(sanitizePdfText(line.text), x, cursorY + 13);
      stroke(theme.border);
      document.setLineWidth(0.8);
      document.line(x, cursorY + 22, marginX + contentWidth, cursorY + 22);
      cursorY += 38;
      continue;
    }

    if (line.variant === "event") {
      document.setFont("helvetica", "bold");
      document.setFontSize(10);
      const titleLines = document.splitTextToSize(sanitizePdfText(line.text), availableWidth);
      document.setFont("helvetica", "normal");
      document.setFontSize(9);
      const detailLines = document.splitTextToSize(sanitizePdfText(line.value ?? ""), availableWidth - 12);
      const blockHeight = titleLines.length * 13.5 + detailLines.length * 12.2 + 10;
      ensureSpace(blockHeight);

      document.setFont("helvetica", "bold");
      document.setFontSize(10);
      textColor(renderPdfColor(line.color, theme, theme.text));
      document.text(titleLines, x, cursorY + 10, { lineHeightFactor: 1.35 });
      const detailY = cursorY + titleLines.length * 13.5 + 8;
      document.setFont("helvetica", "normal");
      document.setFontSize(9);
      textColor(theme.muted);
      document.text(detailLines, x + 12, detailY, { lineHeightFactor: 1.35 });
      cursorY += blockHeight;
      continue;
    }

    if (line.variant === "card") {
      const cardHeight = 56;
      ensureSpace(cardHeight + 8);
      fill(theme.surfaceSoft);
      stroke(theme.border);
      document.setLineWidth(0.8);
      document.roundedRect(x, cursorY, availableWidth, cardHeight, 7, 7, "FD");
      fill(renderPdfColor(line.barColor, theme, theme.cyan));
      document.roundedRect(x, cursorY, 5, cardHeight, 2, 2, "F");
      document.setFont("helvetica", "bold");
      document.setFontSize(7.5);
      textColor(theme.muted);
      document.text(sanitizePdfText(line.text), x + 16, cursorY + 17);
      const value = sanitizePdfText(line.value ?? "");
      document.setFontSize(value.length > 34 ? 12 : 16);
      textColor(renderPdfColor(line.color, theme, theme.text));
      const valueLines = document.splitTextToSize(value, availableWidth - 32).slice(0, 2);
      document.text(valueLines, x + 16, cursorY + 39, { lineHeightFactor: 1.05 });
      cursorY += cardHeight + 8;
      continue;
    }

    if (line.variant === "bar") {
      ensureSpace(32);
      const label = sanitizePdfText(line.text);
      const value = sanitizePdfText(line.value ?? "");
      document.setFont("helvetica", "bold");
      document.setFontSize(8.5);
      textColor(theme.text);
      document.text(document.splitTextToSize(label, 180)[0] || "", x, cursorY + 9);
      document.setFont("helvetica", "normal");
      document.setFontSize(8);
      textColor(theme.muted);
      document.text(value, marginX + contentWidth, cursorY + 9, { align: "right", maxWidth: 205 });
      const trackY = cursorY + 17;
      fill(theme.background);
      document.roundedRect(x, trackY, availableWidth, 7, 3, 3, "F");
      const safeRatio = Math.max(0, Math.min(1, line.ratio ?? 0));
      if (safeRatio > 0) {
        fill(renderPdfColor(line.barColor, theme, theme.cyan));
        document.roundedRect(x, trackY, Math.max(3, availableWidth * safeRatio), 7, 3, 3, "F");
      }
      cursorY += 32;
      continue;
    }

    if (!line.text) {
      cursorY += Math.max(8, line.gap ?? 12);
      continue;
    }

    document.setFont("helvetica", line.bold ? "bold" : "normal");
    document.setFontSize(size);
    textColor(renderPdfColor(line.color, theme, line.bold ? theme.text : theme.muted));
    const wrapped = document.splitTextToSize(sanitizePdfText(line.text), availableWidth);
    const lineHeight = size * 1.35;
    ensureSpace(Math.max(line.gap ?? 0, wrapped.length * lineHeight + 4));
    document.text(wrapped, x, cursorY + size, { lineHeightFactor: 1.35 });
    cursorY += Math.max(line.gap ?? size + 7, wrapped.length * lineHeight + 4);
  }

  drawFooter();
  return document.output("blob");
}

async function buildPdfReport(params: {
  events: OmnichannelEvent[];
  productivity: ProductivityMetrics;
  sourceCounts: Array<{ source: EventSource; count: number }>;
  notifications: SystemNotification[];
  finance?: FinanceMetrics;
  period: Period;
  activeSource: ReportSource;
  connected: boolean;
  settings?: ReportCustomizerState;
  theme?: PdfThemeName;
}) {
  const lines: PdfLine[] = [];
  const sourceLabel = params.activeSource === "all" ? "Todos os canais" : sourceMeta[params.activeSource].label;
  const warningCount = params.notifications.filter((item) => item.severity === "warning" || item.severity === "error").length;
  const settings = params.settings ?? {
    ...defaultReportCustomizer,
    period: params.period,
    source: params.activeSource,
  };
  const sections = settings.sections;
  const reportTitle = settings.title.trim() || "Relatorio operacional Norium";

  const maxSourceCount = Math.max(1, ...params.sourceCounts.map((item) => item.count));
  const maxSavedBySource = Math.max(1, ...Object.values(params.productivity.savedBySource));
  const severityCounts = (["error", "warning", "info", "success"] as const).map((severity) => ({
    severity,
    count: params.notifications.filter((notification) => notification.severity === severity).length,
  }));
  const maxSeverityCount = Math.max(1, ...severityCounts.map((item) => item.count));
  const finance = params.finance;
  const maxFinanceCategory = Math.max(1, ...(finance?.categories.map((item) => item.amount) ?? [1]));

  pushPdfLine(lines, reportTitle, { size: 22, gap: 34, bold: true, color: pdfTheme.text });
  pushPdfLine(lines, `Gerado em ${formatGeneratedAt()}`, { size: 10, gap: 16, color: pdfTheme.cyan });
  pushPdfLine(lines, `Periodo: ${periodLabels[params.period]} | Filtro: ${sourceLabel} | Tempo real: ${params.connected ? "Online" : "Reconectando"}`, {
    size: 10,
    gap: 30,
    color: pdfTheme.muted,
  });

  if (sections.summary) {
    pushPdfSection(lines, "Resumo executivo");
    pushPdfCard(lines, "EVENTOS FILTRADOS", String(params.events.length), pdfTheme.blue);
    pushPdfCard(lines, "PRODUTIVIDADE", `${params.productivity.score}%`, pdfTheme.emerald);
    pushPdfCard(lines, "TEMPO ECONOMIZADO", formatSavedTime(params.productivity.savedMinutes), pdfTheme.cyan);
    pushPdfCard(lines, "ACOES PRODUTIVAS", String(params.productivity.productiveEvents), pdfTheme.text);
    pushPdfCard(lines, "ALERTAS DO SISTEMA", String(warningCount), warningCount > 0 ? pdfTheme.amber : pdfTheme.emerald);
    pushPdfLine(lines, "", { gap: 12 });
  }

  if (sections.productivity) {
    pushPdfSection(lines, "Produtividade operacional");
    pushPdfBar(lines, "Indice", `${params.productivity.score}%`, params.productivity.score / 100, pdfTheme.emerald);
    pushPdfBar(
      lines,
      "Pontos produtivos",
      `${params.productivity.productivePoints.toFixed(1)} / ${params.productivity.potentialPoints.toFixed(1)}`,
      params.productivity.potentialPoints > 0 ? params.productivity.productivePoints / params.productivity.potentialPoints : 0,
      pdfTheme.cyan,
    );
    pushPdfCard(lines, "E-MAILS TRATADOS", String(params.productivity.emailsHandled), sourcePdfColors.gmail);
    pushPdfCard(lines, "MENSAGENS RESPONDIDAS", String(params.productivity.messagesHandled), sourcePdfColors.whatsapp);
    pushPdfCard(lines, "KANBAN MOVIMENTADO", String(params.productivity.tasksMoved), sourcePdfColors.kanban);
    pushPdfCard(lines, "TAREFAS CONCLUIDAS", String(params.productivity.completedTasks), pdfTheme.emerald);
    pushPdfLine(lines, "", { gap: 12 });
  }

  if (sections.savedTime) {
    pushPdfSection(lines, "Tempo economizado");
    pushPdfCard(lines, "TOTAL ESTIMADO", `${formatSavedTime(params.productivity.savedMinutes)} (${Math.round(params.productivity.savedMinutes)} min)`, pdfTheme.emerald);
    (Object.keys(sourceMeta) as EventSource[]).forEach((source) => {
      const saved = params.productivity.savedBySource[source];
      pushPdfBar(lines, sourceMeta[source].label, formatSavedTime(saved), saved / maxSavedBySource, sourcePdfColors[source]);
    });
    pushPdfLine(lines, "", { gap: 14 });
  }

  if (sections.channels) {
    pushPdfSection(lines, "Volume por canal");
    params.sourceCounts.forEach((item) => {
      const saved = params.productivity.savedBySource[item.source];
      pushPdfBar(lines, sourceMeta[item.source].label, `${item.count} eventos | ${formatSavedTime(saved)}`, item.count / maxSourceCount, sourcePdfColors[item.source]);
    });
    pushPdfLine(lines, "", { gap: 14 });
  }

  if (sections.finance && finance) {
    pushPdfSection(lines, "Resumo financeiro");
    pushPdfCard(lines, "ENTRADAS PAGAS", money(finance.entradas), pdfTheme.emerald);
    pushPdfCard(lines, "SAIDAS PAGAS", money(finance.saidas), pdfTheme.amber);
    pushPdfCard(lines, "SALDO DO PERIODO", money(finance.saldo), finance.saldo >= 0 ? pdfTheme.emerald : pdfTheme.amber);
    pushPdfCard(lines, "PENDENTE", money(finance.pendente), pdfTheme.cyan);
    pushPdfCard(lines, "BOLETOS MAPEADOS", `${finance.boletos.length} | ${money(finance.boletosTotal)}`, pdfTheme.blue);
    pushPdfCard(lines, "ANEXOS ARQUIVADOS", String(finance.anexos), pdfTheme.text);
    if (finance.categories.length) {
      pushPdfLine(lines, "", { gap: 10 });
      pushPdfLine(lines, "Categorias com maior volume de saidas", { size: 11, bold: true, color: pdfTheme.text, gap: 20 });
      finance.categories.forEach((item) => {
        pushPdfBar(lines, item.category, `${money(item.amount)} | ${item.count} item(ns)`, item.amount / maxFinanceCategory, pdfTheme.cyan);
      });
    }
    pushPdfLine(lines, "", { gap: 14 });
  }

  if (sections.health) {
    pushPdfSection(lines, "Saude operacional", 64);
    severityCounts.forEach((item) => {
      const color = item.severity === "error" || item.severity === "warning" ? pdfTheme.amber : pdfTheme.cyan;
      pushPdfBar(lines, item.severity, String(item.count), item.count / maxSeverityCount, color);
    });
    pushPdfLine(lines, "", { gap: 14 });
  }

  if (sections.events) {
    pushPdfSection(lines, "Eventos recentes", 64);
    params.events.slice(0, settings.eventLimit).forEach((event) => {
      const impact = classifyEvent(event);
      pushPdfEvent(
        lines,
        `${formatDate(event.timestamp)} - ${sourceMeta[event.source].label} - ${event.title}`,
        `${event.description || "Evento sem descricao"} | ${impact.reason} | +${impact.savedMinutes} min`,
      );
    });
  }

  return createPdfBlob(lines, params.theme);
}

async function buildFinancePdfReport(params: {
  finance: FinanceMetrics;
  period: Period;
  connected: boolean;
  theme?: PdfThemeName;
}) {
  const lines: PdfLine[] = [];
  const maxCategory = Math.max(1, ...params.finance.categories.map((item) => item.amount));
  const maxCashFlow = Math.max(1, params.finance.entradas, params.finance.saidas, Math.abs(params.finance.saldo), params.finance.pendente);

  pushPdfLine(lines, "Relatorio financeiro Norium", { size: 22, gap: 34, bold: true, color: pdfTheme.text });
  pushPdfLine(lines, `Gerado em ${formatGeneratedAt()}`, { size: 10, gap: 16, color: pdfTheme.cyan });
  pushPdfLine(lines, `Periodo: ${periodLabels[params.period]} | Dados persistidos: financeiro_db.json | Tempo real: ${params.connected ? "Online" : "Reconectando"}`, {
    size: 10,
    gap: 30,
    color: pdfTheme.muted,
  });

  pushPdfSection(lines, "Resumo executivo");
  pushPdfCard(lines, "ENTRADAS PAGAS", money(params.finance.entradas), pdfTheme.emerald);
  pushPdfCard(lines, "SAIDAS PAGAS", money(params.finance.saidas), pdfTheme.amber);
  pushPdfCard(lines, "SALDO DO PERIODO", money(params.finance.saldo), params.finance.saldo >= 0 ? pdfTheme.emerald : pdfTheme.amber);
  pushPdfCard(lines, "PENDENTE", money(params.finance.pendente), pdfTheme.cyan);
  pushPdfCard(lines, "BOLETOS", `${params.finance.boletos.length} | ${money(params.finance.boletosTotal)}`, pdfTheme.blue);
  pushPdfCard(lines, "ANEXOS", String(params.finance.anexos), pdfTheme.text);
  pushPdfLine(lines, "", { gap: 12 });

  pushPdfSection(lines, "Fluxo de caixa");
  pushPdfBar(lines, "Entradas", money(params.finance.entradas), params.finance.entradas / maxCashFlow, pdfTheme.emerald);
  pushPdfBar(lines, "Saidas", money(params.finance.saidas), params.finance.saidas / maxCashFlow, pdfTheme.amber);
  pushPdfBar(lines, "Saldo", money(params.finance.saldo), Math.abs(params.finance.saldo) / maxCashFlow, params.finance.saldo >= 0 ? pdfTheme.emerald : pdfTheme.amber);
  pushPdfBar(lines, "Pendente", money(params.finance.pendente), params.finance.pendente / maxCashFlow, pdfTheme.cyan);
  pushPdfBar(lines, "Programado mensal", money(params.finance.programadoMensal), Math.abs(params.finance.programadoMensal) / maxCashFlow, pdfTheme.blue);
  pushPdfLine(lines, "", { gap: 14 });

  pushPdfSection(lines, "Categorias");
  if (params.finance.categories.length === 0) {
    pushPdfLine(lines, "Nenhuma categoria financeira no periodo.", { color: pdfTheme.muted });
  } else {
    params.finance.categories.forEach((item) => {
      pushPdfBar(lines, item.category, `${money(item.amount)} | ${item.count} lancamento(s)`, item.amount / maxCategory, pdfTheme.cyan);
    });
  }
  pushPdfLine(lines, "", { gap: 14 });

  pushPdfSection(lines, "Pendencias e vencimentos");
  pushPdfCard(lines, "LANCAMENTOS ABERTOS", String(params.finance.abertos), params.finance.abertos ? pdfTheme.cyan : pdfTheme.emerald);
  pushPdfCard(lines, "VENCIDOS", String(params.finance.vencidos), params.finance.vencidos ? pdfTheme.amber : pdfTheme.emerald);
  pushPdfCard(lines, "GASTOS PROGRAMADOS", String(params.finance.scheduled.length), pdfTheme.blue);
  pushPdfLine(lines, "", { gap: 14 });

  pushPdfSection(lines, "Lancamentos recentes");
  if (params.finance.entries.length === 0) {
    pushPdfLine(lines, "Nenhum lancamento no periodo selecionado.", { color: pdfTheme.muted });
  } else {
    params.finance.entries.slice(0, 18).forEach((entry) => {
      pushPdfLine(lines, `${formatFinanceDate(entry.paidAt || entry.dueDate || entry.createdAt)} - ${entry.title}`, {
        size: 10,
        bold: true,
        color: pdfTheme.text,
      });
      pushPdfLine(lines, `${entry.type} | ${entry.status} | ${entry.category} | ${money(entry.amount)} | ${entry.attachments?.length || 0} anexo(s)`, {
        size: 9,
        indent: 12,
        gap: 16,
        color: pdfTheme.muted,
      });
    });
  }

  return createPdfBlob(lines, params.theme);
}

function escapePrintHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function printReportDocument(params: {
  title: string;
  theme: PdfThemeName;
  period: Period;
  activeSource: ReportSource;
  productivity: ProductivityMetrics;
  sourceCounts: Array<{ source: EventSource; count: number }>;
  events: OmnichannelEvent[];
  finance: FinanceMetrics;
}) {
  const printWindow = window.open("", "_blank", "width=1100,height=800");
  if (!printWindow) throw new Error("O navegador bloqueou a janela de impressao.");
  printWindow.opener = null;
  const isDark = params.theme === "dark";
  const colors = isDark
    ? { background: "#071220", surface: "#111f35", soft: "#182a45", border: "#2d4266", text: "#f7fbff", muted: "#a3b8d6" }
    : { background: "#eef5ff", surface: "#ffffff", soft: "#eaf2ff", border: "#b8cce8", text: "#0a1a33", muted: "#4d647f" };
  const sourceLabel = params.activeSource === "all" ? "Todos os canais" : sourceMeta[params.activeSource].label;
  const cards = [
    ["Eventos", params.events.length],
    ["Produtividade", `${params.productivity.score}%`],
    ["Tempo economizado", formatSavedTime(params.productivity.savedMinutes)],
    ["Tarefas concluidas", params.productivity.completedTasks],
    ["Saldo financeiro", money(params.finance.saldo)],
  ];
  const maxSource = Math.max(1, ...params.sourceCounts.map((item) => item.count));
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapePrintHtml(params.title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${colors.background}; color: ${colors.text}; font-family: Arial, sans-serif; font-size: 12px; }
  main { max-width: 980px; margin: 0 auto; }
  header { padding: 28px; border-radius: 10px; color: white; background: linear-gradient(120deg, #155bd7, #06a7c8); }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
  .brand img { display:block; width:112px; height:auto; object-fit:contain; }
  h1 { margin: 10px 0 6px; font-size: 28px; } h2 { margin: 24px 0 10px; font-size: 17px; }
  .eyebrow { font-weight: 800; letter-spacing: 1px; } .muted { color: ${colors.muted}; }
  .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 16px; }
  .card, .event, .channel { break-inside: avoid; border: 1px solid ${colors.border}; background: ${colors.surface}; border-radius: 8px; padding: 14px; }
  .card span { display: block; color: ${colors.muted}; font-size: 10px; font-weight: 800; text-transform: uppercase; }
  .card strong { display: block; margin-top: 7px; font-size: 18px; }
  .channels { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .bar { height: 7px; margin-top: 8px; overflow: hidden; border-radius: 8px; background: ${colors.soft}; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, #1764e8, #08b9d7); }
  .event { margin-bottom: 8px; } .event strong { display: block; margin-bottom: 5px; }
  footer { margin-top: 24px; border-top: 1px solid ${colors.border}; padding-top: 10px; color: ${colors.muted}; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head><body><main>
<header><div class="brand"><img src="${escapePrintHtml(noriumLogo)}" alt="Norium"><div class="eyebrow">RELATORIO INTELIGENTE</div></div><h1>${escapePrintHtml(params.title)}</h1><div>Gerado em ${escapePrintHtml(formatGeneratedAt())} | ${escapePrintHtml(periodLabels[params.period])} | ${escapePrintHtml(sourceLabel)}</div></header>
<section class="grid">${cards.map(([label, value]) => `<article class="card"><span>${escapePrintHtml(label)}</span><strong>${escapePrintHtml(value)}</strong></article>`).join("")}</section>
<h2>Volume por canal</h2><section class="channels">${params.sourceCounts.map((item) => `<article class="channel"><strong>${escapePrintHtml(sourceMeta[item.source].label)}: ${item.count}</strong><div class="bar"><i style="width:${Math.max(2, Math.round((item.count / maxSource) * 100))}%"></i></div></article>`).join("")}</section>
<h2>Resumo financeiro</h2><section class="channels"><article class="card"><span>Entradas pagas</span><strong>${escapePrintHtml(money(params.finance.entradas))}</strong></article><article class="card"><span>Saidas pagas</span><strong>${escapePrintHtml(money(params.finance.saidas))}</strong></article><article class="card"><span>Pendente</span><strong>${escapePrintHtml(money(params.finance.pendente))}</strong></article><article class="card"><span>Vencidos</span><strong>${params.finance.vencidos}</strong></article></section>
<h2>Eventos recentes</h2>${params.events.slice(0, 30).map((event) => `<article class="event"><strong>${escapePrintHtml(formatDate(event.timestamp))} | ${escapePrintHtml(sourceMeta[event.source].label)} | ${escapePrintHtml(event.title)}</strong><div class="muted">${escapePrintHtml(event.description || "Evento sem descricao")}</div></article>`).join("") || '<article class="event">Nenhum evento no periodo.</article>'}
<footer>Norium | Relatorio operacional | Desenvolvido pela Equipe Norium</footer>
</main><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

export default function ReportsDashboard({ eventsBySource, notifications, connected, userId = "lucas123" }: ReportsDashboardProps) {
  const [period, setPeriod] = useState<Period>("7d");
  const [activeSource, setActiveSource] = useState<ReportSource>("all");
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [financeData, setFinanceData] = useState<FinanceData>(emptyFinanceData);
  const [financeLoading, setFinanceLoading] = useState(true);
  const [financeError, setFinanceError] = useState("");
  const [reportActionError, setReportActionError] = useState("");
  const [reportTheme, setReportTheme] = useState<PdfThemeName>(() =>
    localStorage.getItem("norium-report-theme") === "light" ? "light" : "dark",
  );
  const [customReport, setCustomReport] = useState<ReportCustomizerState>(() => ({
    ...defaultReportCustomizer,
    sections: { ...defaultReportSections },
  }));

  useEffect(() => {
    let cancelled = false;

    async function loadFinance() {
      try {
        setFinanceLoading(true);
        setFinanceError("");
        const payload = await loadFinanceReportData(userId);
        if (!cancelled) setFinanceData(payload);
      } catch (err) {
        if (!cancelled) setFinanceError(err instanceof Error ? err.message : "Falha ao carregar financeiro.");
      } finally {
        if (!cancelled) setFinanceLoading(false);
      }
    }

    void loadFinance();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    localStorage.setItem("norium-report-theme", reportTheme);
  }, [reportTheme]);

  const periodEvents = useMemo(
    () =>
      Object.values(eventsBySource)
        .flat()
        .filter((event) => withinPeriod(event, period))
        .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp)),
    [eventsBySource, period],
  );

  const filteredEvents = useMemo(
    () => periodEvents.filter((event) => activeSource === "all" || event.source === activeSource),
    [activeSource, periodEvents],
  );

  const sourceCounts = useMemo(() => {
    return (Object.keys(sourceMeta) as EventSource[]).map((source) => ({
      source,
      count: eventsBySource[source].filter((event) => withinPeriod(event, period)).length,
    }));
  }, [eventsBySource, period]);

  const productivity = useMemo(() => calculateProductivity(filteredEvents), [filteredEvents]);
  const finance = useMemo(() => calculateFinanceMetrics(financeData, period), [financeData, period]);
  const timeSeries = useMemo(() => buildTimeSeries(filteredEvents, period), [filteredEvents, period]);
  const channelChartData = useMemo(
    () =>
      sourceCounts
        .filter((item) => item.count > 0)
        .map((item) => ({ name: sourceMeta[item.source].label, value: item.count, source: item.source })),
    [sourceCounts],
  );
  const maxCount = Math.max(1, ...sourceCounts.map((item) => item.count));
  const maxFinanceCategory = Math.max(1, ...finance.categories.map((item) => item.amount));
  const totalEvents = filteredEvents.length;
  const systemWarnings = notifications.filter((item) => item.severity === "warning" || item.severity === "error").length;
  const activeChannels = sourceCounts.filter((item) => item.count > 0).length;
  const latestEvents = filteredEvents.slice(0, 10);

  function getEventsForConfig(config: ReportCustomizerState) {
    return Object.values(eventsBySource)
      .flat()
      .filter((event) => withinPeriod(event, config.period))
      .filter((event) => config.source === "all" || event.source === config.source)
      .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp));
  }

  function getSourceCountsForPeriod(selectedPeriod: Period) {
    return (Object.keys(sourceMeta) as EventSource[]).map((source) => ({
      source,
      count: eventsBySource[source].filter((event) => withinPeriod(event, selectedPeriod)).length,
    }));
  }

  function updateCustomReport<K extends keyof ReportCustomizerState>(key: K, value: ReportCustomizerState[K]) {
    setCustomReport((current) => ({ ...current, [key]: value }));
  }

  function toggleCustomSection(section: ReportSection) {
    setCustomReport((current) => ({
      ...current,
      sections: {
        ...current.sections,
        [section]: !current.sections[section],
      },
    }));
  }

  function exportCsv() {
    const rows = [
      ["metric", "value"],
      ["periodo", periodLabels[period]],
      ["filtro", activeSource === "all" ? "todos" : sourceMeta[activeSource].label],
      ["eventos_filtrados", totalEvents],
      ["produtividade_percentual", `${productivity.score}%`],
      ["tempo_economizado_minutos", Math.round(productivity.savedMinutes)],
      ["acoes_produtivas", productivity.productiveEvents],
      ["tarefas_concluidas", productivity.completedTasks],
      ["financeiro_entradas_pagas", finance.entradas],
      ["financeiro_saidas_pagas", finance.saidas],
      ["financeiro_saldo", finance.saldo],
      ["financeiro_pendente", finance.pendente],
      ["financeiro_boletos", finance.boletos.length],
      ["financeiro_anexos", finance.anexos],
      [],
      ["id", "source", "title", "description", "timestamp", "impacto", "minutos_economizados"],
      ...filteredEvents.map((event) => {
        const impact = classifyEvent(event);
        return [event.id, event.source, event.title, event.description, event.timestamp, impact.reason, impact.savedMinutes];
      }),
      [],
      ["financeiro_id", "tipo", "titulo", "categoria", "status", "valor", "vencimento", "pago_em", "anexos"],
      ...finance.entries.map((entry) => [
        entry.id,
        entry.type,
        entry.title,
        entry.category,
        entry.status,
        entry.amount,
        entry.dueDate || "",
        entry.paidAt || "",
        entry.attachments?.length || 0,
      ]),
    ];
    const csv = rows.map((row) => row.map((cell) => csvEscape(String(cell ?? ""))).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `norium-relatorio-${period}.csv`);
    registerReportEvent(
      "Relatorio CSV exportado",
      `CSV operacional gerado para ${periodLabels[period]} com ${totalEvents} eventos filtrados.`,
      { action: "report_csv_exported", userId, period, activeSource, totalEvents },
    );
  }

  async function exportPdf() {
    setReportActionError("");
    const blob = await buildPdfReport({
      events: filteredEvents,
      productivity,
      sourceCounts,
      notifications,
      finance,
      period,
      activeSource,
      connected,
      theme: reportTheme,
    });
    downloadBlob(blob, `norium-relatorio-${period}-${reportTheme}.pdf`);
    registerReportEvent(
      "Relatorio PDF gerado",
      `PDF operacional gerado para ${periodLabels[period]} com produtividade de ${productivity.score}%.`,
      { action: "report_pdf_exported", userId, period, activeSource, totalEvents, productivity: productivity.score },
    );
  }

  async function exportCustomPdf() {
    const events = getEventsForConfig(customReport);
    const customProductivity = calculateProductivity(events);
    const customSourceCounts = getSourceCountsForPeriod(customReport.period);
    const customFinance = calculateFinanceMetrics(financeData, customReport.period);
    setReportActionError("");
    const blob = await buildPdfReport({
      events,
      productivity: customProductivity,
      sourceCounts: customSourceCounts,
      notifications,
      finance: customFinance,
      period: customReport.period,
      activeSource: customReport.source,
      connected,
      settings: customReport,
      theme: reportTheme,
    });
    downloadBlob(blob, `norium-${sanitizePdfText(customReport.title || "relatorio").toLowerCase().replace(/\s+/g, "-")}-${reportTheme}.pdf`);
    registerReportEvent(
      "Relatorio personalizado gerado",
      `${customReport.title || "Relatorio personalizado"} exportado com ${events.length} eventos.`,
      { action: "report_custom_pdf_exported", userId, period: customReport.period, activeSource: customReport.source, totalEvents: events.length },
    );
  }

  async function exportFinancePdf() {
    setReportActionError("");
    const blob = await buildFinancePdfReport({ finance, period, connected, theme: reportTheme });
    downloadBlob(blob, `norium-relatorio-financeiro-${period}-${reportTheme}.pdf`);
    registerReportEvent(
      "Relatorio financeiro gerado",
      `PDF financeiro gerado com saldo de ${money(finance.saldo)} e ${finance.entries.length} lancamentos.`,
      { action: "report_finance_pdf_exported", userId, period, balance: finance.saldo, entries: finance.entries.length },
    );
  }

  function printCurrentReport() {
    try {
      setReportActionError("");
      printReportDocument({
        title: "Relatorio operacional Norium",
        theme: reportTheme,
        period,
        activeSource,
        productivity,
        sourceCounts,
        events: filteredEvents,
        finance,
      });
      registerReportEvent(
        "Relatorio enviado para impressao",
        `Relatorio ${reportTheme === "dark" ? "escuro" : "claro"} preparado para impressao.`,
        { action: "report_printed", userId, period, activeSource, theme: reportTheme },
      );
    } catch (error) {
      setReportActionError(error instanceof Error ? error.message : "Nao foi possivel abrir a impressao.");
    }
  }

  function printCustomReport() {
    const events = getEventsForConfig(customReport);
    try {
      setReportActionError("");
      printReportDocument({
        title: customReport.title || "Relatorio personalizado Norium",
        theme: reportTheme,
        period: customReport.period,
        activeSource: customReport.source,
        productivity: calculateProductivity(events),
        sourceCounts: getSourceCountsForPeriod(customReport.period),
        events,
        finance: calculateFinanceMetrics(financeData, customReport.period),
      });
    } catch (error) {
      setReportActionError(error instanceof Error ? error.message : "Nao foi possivel abrir a impressao.");
    }
  }

  function applyCustomFiltersToScreen() {
    setPeriod(customReport.period);
    setActiveSource(customReport.source);
    setCustomizerOpen(false);
  }

  return (
    <>
      <button
        onClick={() => setCustomizerOpen(true)}
        className="fixed left-0 top-1/2 z-30 flex -translate-y-1/2 items-center gap-2 rounded-r-xl border border-l-0 border-cyan-400/25 bg-gradient-to-b from-blue-700 to-cyan-500 px-3 py-4 text-xs font-black text-white shadow-xl shadow-blue-950/30 transition hover:translate-x-1"
        title="Gerar relatorio personalizado"
      >
        <PanelLeftOpen size={17} />
        <span className="[writing-mode:vertical-rl]">Relatorio</span>
      </button>

      {customizerOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={() => setCustomizerOpen(false)}>
          <aside
            className="flex h-full w-[390px] max-w-[92vw] flex-col border-r border-cyan-400/20 bg-[var(--surface)] text-[var(--text)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-cyan-400/20 bg-gradient-to-r from-blue-800 via-sky-700 to-cyan-500 p-5 text-white">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-white/15">
                  <SlidersHorizontal size={19} />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-black">Relatorio personalizado</h2>
                  <p className="truncate text-xs font-semibold text-white/75">Monte o PDF com o recorte que voce precisa.</p>
                </div>
              </div>
              <button onClick={() => setCustomizerOpen(false)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10">
                <X size={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <label className="block">
                <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Titulo do PDF</span>
                <input
                  value={customReport.title}
                  onChange={(event) => updateCustomReport("title", event.target.value)}
                  className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-cyan-400"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Tema da exportacao</span>
                <select
                  value={reportTheme}
                  onChange={(event) => setReportTheme(event.target.value as PdfThemeName)}
                  className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-cyan-400"
                >
                  <option value="dark">Escuro Norium</option>
                  <option value="light">Claro para impressao</option>
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Periodo</span>
                  <select
                    value={customReport.period}
                    onChange={(event) => updateCustomReport("period", event.target.value as Period)}
                    className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-cyan-400"
                  >
                    <option value="24h">Ultimas 24h</option>
                    <option value="7d">Ultimos 7 dias</option>
                    <option value="all">Tudo</option>
                  </select>
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Canal</span>
                  <select
                    value={customReport.source}
                    onChange={(event) => updateCustomReport("source", event.target.value as ReportSource)}
                    className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-cyan-400"
                  >
                    <option value="all">Todos</option>
                    {(Object.keys(sourceMeta) as EventSource[]).map((source) => (
                      <option key={source} value={source}>
                        {sourceMeta[source].label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="text-xs font-black uppercase text-[var(--text-secondary)]">Eventos no PDF</span>
                <select
                  value={customReport.eventLimit}
                  onChange={(event) => updateCustomReport("eventLimit", Number(event.target.value))}
                  className="mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold outline-none focus:border-cyan-400"
                >
                  <option value={8}>8 eventos</option>
                  <option value={18}>18 eventos</option>
                  <option value={35}>35 eventos</option>
                  <option value={60}>60 eventos</option>
                </select>
              </label>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ListChecks size={17} className="text-cyan-300" />
                  <h3 className="text-sm font-black">Secoes do relatorio</h3>
                </div>
                <div className="space-y-2">
                  {(Object.keys(sectionLabels) as ReportSection[]).map((section) => (
                    <label
                      key={section}
                      className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-bold"
                    >
                      <span>{sectionLabels[section]}</span>
                      <input
                        type="checkbox"
                        checked={customReport.sections[section]}
                        onChange={() => toggleCustomSection(section)}
                        className="h-4 w-4 accent-cyan-500"
                      />
                    </label>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-4">
                <p className="text-xs font-black uppercase text-cyan-200/80">Previa do recorte</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-[var(--surface)] p-3">
                    <span className="block text-[11px] font-bold uppercase text-[var(--text-secondary)]">Eventos</span>
                    <strong className="text-xl font-black">{getEventsForConfig(customReport).length}</strong>
                  </div>
                  <div className="rounded-lg bg-[var(--surface)] p-3">
                    <span className="block text-[11px] font-bold uppercase text-[var(--text-secondary)]">Canal</span>
                    <strong className="text-sm font-black">{customReport.source === "all" ? "Todos" : sourceMeta[customReport.source].label}</strong>
                  </div>
                </div>
              </section>
            </div>

            <footer className="grid gap-2 border-t border-[var(--border)] p-5">
              <button
                onClick={() => void exportCustomPdf().catch((error) => setReportActionError(error instanceof Error ? error.message : "Falha ao gerar PDF."))}
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-700 to-cyan-500 text-sm font-black text-white transition hover:brightness-110"
              >
                <FileText size={16} />
                Gerar PDF personalizado
              </button>
              <button
                type="button"
                onClick={printCustomReport}
                className="flex h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border)] text-sm font-black transition hover:bg-[var(--surface-hover)]"
              >
                <Printer size={16} />
                Imprimir personalizado
              </button>
              <button
                onClick={applyCustomFiltersToScreen}
                className="h-10 rounded-lg border border-[var(--border)] text-xs font-black text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                Aplicar filtros na tela
              </button>
            </footer>
          </aside>
        </div>
      )}

      <section className="norium-reports flex h-full min-h-0 w-full flex-col bg-[var(--background)] text-[var(--text)]">
      <header className="norium-reports-header flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--background)] text-blue-400">
            <BarChart3 size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-black">Relatorios</h1>
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
              Produtividade, tempo economizado e saude operacional em tempo real
            </p>
          </div>
        </div>

        <div className="norium-reports-actions flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCustomizerOpen(true)}
            className="flex h-10 items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 text-xs font-black text-cyan-200 transition hover:bg-cyan-400/20"
          >
            <SlidersHorizontal size={15} />
            Personalizar relatorio
          </button>
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value as Period)}
            className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none"
          >
            <option value="24h">Ultimas 24h</option>
            <option value="7d">Ultimos 7 dias</option>
            <option value="all">Tudo</option>
          </select>
          <select
            value={reportTheme}
            onChange={(event) => setReportTheme(event.target.value as PdfThemeName)}
            aria-label="Tema do relatorio"
            title="Tema usado no PDF e na impressao"
            className="h-10 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none"
          >
            <option value="dark">Tema escuro</option>
            <option value="light">Tema claro</option>
          </select>
          <button
            onClick={exportCsv}
            className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-4 text-xs font-black text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            type="button"
            onClick={printCurrentReport}
            className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-4 text-xs font-black text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            <Printer size={15} />
            Imprimir
          </button>
          <button
            onClick={() => void exportPdf().catch((error) => setReportActionError(error instanceof Error ? error.message : "Falha ao gerar PDF."))}
            className="flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-black text-white transition hover:bg-blue-500"
          >
            <FileText size={15} />
            Gerar PDF
          </button>
          <button
            onClick={() => void exportFinancePdf().catch((error) => setReportActionError(error instanceof Error ? error.message : "Falha ao gerar PDF financeiro."))}
            className="flex h-10 items-center gap-2 rounded-lg bg-cyan-600 px-4 text-xs font-black text-white transition hover:bg-cyan-500"
          >
            <CreditCard size={15} />
            PDF financeiro
          </button>
        </div>
      </header>

      {reportActionError && (
        <div className="mx-6 mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs font-bold text-rose-300">
          {reportActionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {[
            { label: "Eventos filtrados", value: totalEvents, icon: Activity, color: "text-blue-400 bg-blue-500/10" },
            { label: "Produtividade", value: `${productivity.score}%`, icon: Gauge, color: "text-emerald-400 bg-emerald-500/10" },
            { label: "Tempo economizado", value: formatSavedTime(productivity.savedMinutes), icon: Clock3, color: "text-cyan-400 bg-cyan-500/10" },
            { label: "Canais ativos", value: activeChannels, icon: TrendingUp, color: "text-sky-400 bg-sky-500/10" },
            { label: "Tempo real", value: connected ? "Online" : "Reconectando", icon: RefreshCw, color: "text-amber-400 bg-amber-500/10" },
          ].map((card) => {
            const Icon = card.icon;
            return (
              <article key={card.label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">{card.label}</p>
                    <h2 className="mt-3 break-words text-3xl font-black leading-tight text-[var(--text)]">{card.value}</h2>
                  </div>
                  <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${card.color}`}>
                    <Icon size={20} />
                  </span>
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.8fr)]">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-black">Produtividade operacional</h2>
                <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                  Calculada por pontos produtivos sobre o potencial dos eventos no filtro atual.
                </p>
              </div>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400">
                <Target size={20} />
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-[160px_1fr]">
              <div className="grid place-items-center rounded-xl border border-[var(--border)] bg-[var(--background)] p-5">
                <div className="grid h-28 w-28 place-items-center rounded-full border-[10px] border-emerald-400/25 bg-emerald-400/10 text-center">
                  <span>
                    <strong className="block text-3xl font-black text-emerald-300">{productivity.score}%</strong>
                    <small className="text-[10px] font-black uppercase text-[var(--text-secondary)]">indice</small>
                  </span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Acoes produtivas", productivity.productiveEvents],
                  ["Eventos triados", productivity.monitoredEvents],
                  ["E-mails tratados", productivity.emailsHandled],
                  ["Mensagens respondidas", productivity.messagesHandled],
                  ["Kanban movimentado", productivity.tasksMoved],
                  ["Tarefas concluidas", productivity.completedTasks],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                    <p className="text-[11px] font-bold uppercase text-[var(--text-secondary)]">{label}</p>
                    <strong className="mt-1 block text-xl font-black">{value}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--background)]">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style={{ width: `${productivity.score}%` }} />
            </div>
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-black">Tempo economizado</h2>
                <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                  Estimativa baseada em automacao, triagem centralizada e acoes registradas.
                </p>
              </div>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-cyan-500/10 text-cyan-400">
                <Zap size={20} />
              </span>
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-4">
              <p className="text-xs font-bold uppercase text-cyan-200/80">Total do filtro</p>
              <strong className="mt-2 block text-4xl font-black text-cyan-200">{formatSavedTime(productivity.savedMinutes)}</strong>
              <p className="mt-1 text-xs font-semibold text-cyan-100/70">{Math.round(productivity.savedMinutes)} minutos estimados</p>
            </div>

            <div className="mt-4 space-y-3">
              {(Object.keys(sourceMeta) as EventSource[]).map((source) => {
                const saved = productivity.savedBySource[source];
                return (
                  <div key={source} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2">
                    <span className="text-xs font-black text-[var(--text-secondary)]">{sourceMeta[source].label}</span>
                    <span className="text-sm font-black">{formatSavedTime(saved)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <section className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-black">Tendencia de eventos</h2>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                Volume de eventos {period === "24h" ? "por hora, nas ultimas 24h" : "por dia, no periodo selecionado"}.
              </p>
            </div>
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-400">
              <TrendingUp size={20} />
            </span>
          </div>
          {timeSeries.every((point) => point.total === 0) ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm font-semibold text-[var(--text-secondary)]">
              Nenhum evento no periodo para tracar a tendencia.
            </p>
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeSeries} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="reportsTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "var(--text)", fontWeight: 700 }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(((value: number) => [`${value} eventos`, ""]) as any)}
                  />
                  <Area type="monotone" dataKey="total" stroke="#22d3ee" strokeWidth={2} fill="url(#reportsTrendFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-black">Financeiro persistido</h2>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">
                Lancamentos, anexos, boletos e gastos programados salvos no financeiro local.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {financeLoading && (
                <span className="rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1 text-xs font-black text-cyan-200">
                  Carregando
                </span>
              )}
              <button
                onClick={exportFinancePdf}
                className="flex h-10 items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 text-xs font-black text-cyan-100 transition hover:bg-cyan-500/20"
              >
                <FileText size={15} />
                Gerar PDF financeiro
              </button>
            </div>
          </div>

          {financeError ? (
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm font-bold text-amber-200">
              {financeError}
            </div>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)]">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: "Entradas pagas", value: money(finance.entradas), icon: TrendingUp, color: "text-emerald-300 bg-emerald-500/10" },
                  { label: "Saidas pagas", value: money(finance.saidas), icon: CreditCard, color: "text-amber-300 bg-amber-500/10" },
                  { label: "Saldo", value: money(finance.saldo), icon: Wallet, color: finance.saldo >= 0 ? "text-cyan-300 bg-cyan-500/10" : "text-amber-300 bg-amber-500/10" },
                  { label: "Pendente", value: money(finance.pendente), icon: Receipt, color: "text-blue-300 bg-blue-500/10" },
                  { label: "Boletos", value: String(finance.boletos.length), icon: Receipt, color: "text-sky-300 bg-sky-500/10" },
                  { label: "Anexos", value: String(finance.anexos), icon: FileText, color: "text-cyan-300 bg-cyan-500/10" },
                  { label: "Vencidos", value: String(finance.vencidos), icon: ShieldAlert, color: finance.vencidos ? "text-amber-300 bg-amber-500/10" : "text-emerald-300 bg-emerald-500/10" },
                  { label: "Programados", value: money(finance.programadoMensal), icon: CalendarDays, color: "text-blue-300 bg-blue-500/10" },
                ].map((card) => {
                  const Icon = card.icon;
                  return (
                    <article key={card.label} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold uppercase text-[var(--text-secondary)]">{card.label}</p>
                          <strong className="mt-2 block truncate text-xl font-black">{card.value}</strong>
                        </div>
                        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${card.color}`}>
                          <Icon size={17} />
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-black">Categorias de saida</h3>
                    <p className="text-xs font-semibold text-[var(--text-secondary)]">Maiores volumes no periodo.</p>
                  </div>
                  <BarChart3 size={18} className="text-cyan-300" />
                </div>
                <div className="space-y-3">
                  {finance.categories.length === 0 ? (
                    <p className="rounded-lg border border-[var(--border)] px-3 py-4 text-sm font-semibold text-[var(--text-secondary)]">
                      Nenhuma categoria financeira no periodo.
                    </p>
                  ) : (
                    finance.categories.map((item) => (
                      <div key={item.category}>
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <span className="truncate text-xs font-black text-[var(--text-secondary)]">{item.category}</span>
                          <span className="shrink-0 text-xs font-black">{money(item.amount)}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-[var(--surface)]">
                          <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400" style={{ width: `${Math.max(6, (item.amount / maxFinanceCategory) * 100)}%` }} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black">Volume por canal</h2>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Clique em um canal para filtrar o relatorio inteiro.</p>
              </div>
              <button
                onClick={() => setActiveSource("all")}
                className={`rounded-lg px-3 py-2 text-xs font-black ${
                  activeSource === "all" ? "bg-blue-500 text-white" : "border border-[var(--border)] text-[var(--text-secondary)]"
                }`}
              >
                Todos
              </button>
            </div>

            {channelChartData.length > 0 && (
              <div className="mb-4 flex items-center gap-4">
                <div className="h-32 w-32 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={channelChartData} dataKey="value" nameKey="name" innerRadius={38} outerRadius={58} paddingAngle={2}>
                        {channelChartData.map((entry) => (
                          <Cell key={entry.source} fill={sourceChartColor(entry.source)} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(((value: number, name: string) => [`${value} eventos`, name]) as any)}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1.5">
                  {channelChartData.map((entry) => (
                    <span key={entry.source} className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--text-secondary)]">
                      <span className="h-2 w-2 rounded-full" style={{ background: sourceChartColor(entry.source) }} />
                      {entry.name} · {entry.value}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {sourceCounts.map((item) => {
                const meta = sourceMeta[item.source];
                const Icon = meta.icon;
                const width = `${Math.max(5, (item.count / maxCount) * 100)}%`;
                return (
                  <button
                    key={item.source}
                    onClick={() => setActiveSource(item.source)}
                    className={`w-full rounded-lg border p-3 text-left transition hover:bg-[var(--surface-hover)] ${
                      activeSource === item.source ? "border-blue-400" : "border-[var(--border)]"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`grid h-8 w-8 place-items-center rounded-lg ${meta.tabColor}`}>
                          <Icon size={16} />
                        </span>
                        <span className="text-sm font-black">{meta.label}</span>
                      </span>
                      <span className="text-sm font-black text-[var(--text-secondary)]">{item.count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--background)]">
                      <div className={`h-full rounded-full ${meta.color}`} style={{ width }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="text-base font-black">Saude operacional</h2>
            <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Resumo rapido por tipo de alerta.</p>

            <div className="mt-5 grid gap-3">
              {(["error", "warning", "info", "success"] as const).map((severity) => {
                const count = notifications.filter((notification) => notification.severity === severity).length;
                return (
                  <div key={severity} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3">
                    <span className="flex items-center gap-2 text-sm font-bold capitalize">
                      <ShieldAlert size={15} className="text-[var(--text-secondary)]" />
                      {severity}
                    </span>
                    <span className="rounded-full bg-[var(--background)] px-3 py-1 text-xs font-black text-[var(--text-secondary)]">
                      {count}
                    </span>
                  </div>
                );
              })}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Alertas criticos</p>
                <strong className="mt-1 block text-2xl font-black">{systemWarnings}</strong>
              </div>
            </div>
          </section>
        </div>

        <section className="mt-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <h2 className="text-base font-black">Eventos recentes</h2>
              <p className="text-xs font-semibold text-[var(--text-secondary)]">Amostra dos eventos usados neste relatorio.</p>
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {latestEvents.length === 0 ? (
              <div className="p-6 text-sm font-semibold text-[var(--text-secondary)]">Nenhum evento no filtro atual.</div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {latestEvents.map((event) => {
                  const meta = sourceMeta[event.source];
                  const Icon = meta.icon;
                  const impact = classifyEvent(event);
                  return (
                    <article key={event.id} className="grid grid-cols-[40px_1fr_auto] gap-3 px-5 py-3">
                      <span className={`grid h-10 w-10 place-items-center rounded-lg ${meta.tabColor}`}>
                        <Icon size={17} />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-black">{event.title}</h3>
                        <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">
                          {event.description || "Evento sem descricao"}
                        </p>
                        <p className="mt-1 text-[11px] font-bold text-cyan-300">
                          {impact.reason} · +{impact.savedMinutes} min
                        </p>
                      </div>
                      <time className="shrink-0 text-xs font-bold text-[var(--text-secondary)]">{formatDate(event.timestamp)}</time>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
      </section>
    </>
  );
}
