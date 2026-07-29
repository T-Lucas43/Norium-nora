// Geracao de PDF (jsPDF) do relatorio operacional e financeiro - extraido de
// ReportsDashboard.tsx para separar a logica de exportacao da renderizacao.
import { jsPDF } from "jspdf";
import type { EventSource, OmnichannelEvent, SystemNotification } from "../../types/omnichannel";
import type { FinanceMetrics, PdfColor, PdfLine, Period, ProductivityMetrics, ReportCustomizerState, ReportSource } from "./types";
import { classifyEvent, formatDate, formatFinanceDate, formatGeneratedAt, formatSavedTime, money, periodLabels, sourceLabels } from "./metrics";

export type PdfThemeName = "dark" | "light";

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

export const sourcePdfColors: Record<EventSource, PdfColor> = {
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

export function pdfChannel(color: number) {
  return Math.max(0, Math.min(255, Math.round(color * 255)));
}

export function pdfColor(color: PdfColor): [number, number, number] {
  return [pdfChannel(color[0]), pdfChannel(color[1]), pdfChannel(color[2])];
}

export function sourceChartColor(source: EventSource) {
  const [r, g, b] = pdfColor(sourcePdfColors[source]);
  return `rgb(${r}, ${g}, ${b})`;
}

export function csvEscape(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function downloadBlob(blob: Blob, fileName: string) {
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

const COMBINING_DIACRITICS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");
const NON_PRINTABLE_ASCII = new RegExp(`[^${String.fromCharCode(0x20)}-${String.fromCharCode(0x7e)}]`, "g");

export function sanitizePdfText(value: string) {
  return value
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(NON_PRINTABLE_ASCII, "")
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

async function loadReportLogo(logoUrl: string) {
  try {
    const response = await fetch(logoUrl);
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

async function createPdfBlob(lines: PdfLine[], logoUrl: string, themeName: PdfThemeName = "dark") {
  const theme = themeName === "light" ? lightPdfTheme : pdfTheme;
  const document = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait", compress: true });
  const pageWidth = document.internal.pageSize.getWidth();
  const pageHeight = document.internal.pageSize.getHeight();
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;
  const headerHeight = 126;
  const contentTop = headerHeight + 46;
  const contentBottom = pageHeight - 54;
  const logoData = await loadReportLogo(logoUrl);
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

export async function buildPdfReport(params: {
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
  logoUrl: string;
  defaultSettings: ReportCustomizerState;
}) {
  const lines: PdfLine[] = [];
  const sourceLabel = params.activeSource === "all" ? "Todos os canais" : sourceLabels[params.activeSource];
  const warningCount = params.notifications.filter((item) => item.severity === "warning" || item.severity === "error").length;
  const settings = params.settings ?? {
    ...params.defaultSettings,
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
    (Object.keys(sourceLabels) as EventSource[]).forEach((source) => {
      const saved = params.productivity.savedBySource[source];
      pushPdfBar(lines, sourceLabels[source], formatSavedTime(saved), saved / maxSavedBySource, sourcePdfColors[source]);
    });
    pushPdfLine(lines, "", { gap: 14 });
  }

  if (sections.channels) {
    pushPdfSection(lines, "Volume por canal");
    params.sourceCounts.forEach((item) => {
      const saved = params.productivity.savedBySource[item.source];
      pushPdfBar(lines, sourceLabels[item.source], `${item.count} eventos | ${formatSavedTime(saved)}`, item.count / maxSourceCount, sourcePdfColors[item.source]);
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
        `${formatDate(event.timestamp)} - ${sourceLabels[event.source]} - ${event.title}`,
        `${event.description || "Evento sem descricao"} | ${impact.reason} | +${impact.savedMinutes} min`,
      );
    });
  }

  return createPdfBlob(lines, params.logoUrl, params.theme);
}

export async function buildFinancePdfReport(params: {
  finance: FinanceMetrics;
  period: Period;
  connected: boolean;
  theme?: PdfThemeName;
  logoUrl: string;
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

  return createPdfBlob(lines, params.logoUrl, params.theme);
}
