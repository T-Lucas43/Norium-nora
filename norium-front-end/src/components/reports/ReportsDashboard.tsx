import { useEffect, useMemo, useState } from "react";
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
  Sparkles,
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
import type { FinanceData, Period, ReportCustomizerState, ReportSection, ReportSource } from "../../features/reports/types";
import {
  buildTimeSeries,
  calculateFinanceMetrics,
  calculateProductivity,
  classifyEvent,
  emptyFinanceData,
  formatDate,
  formatSavedTime,
  money,
  periodLabels,
  timestampValue,
  withinPeriod,
} from "../../features/reports/metrics";
import { buildFinancePdfReport, buildPdfReport, csvEscape, downloadBlob, sanitizePdfText, sourceChartColor } from "../../features/reports/pdfBuilder";
import type { PdfThemeName } from "../../features/reports/pdfBuilder";
import { printReportDocument } from "../../features/reports/printBuilder";
import noriumLogo from "../../assets/logo-text-white.png";

type ReportsDashboardProps = {
  eventsBySource: Record<EventSource, OmnichannelEvent[]>;
  notifications: SystemNotification[];
  connected: boolean;
  userId?: string;
  onOpenNora?: (prompt?: string) => void;
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


export default function ReportsDashboard({ eventsBySource, notifications, connected, userId = "lucas123", onOpenNora }: ReportsDashboardProps) {
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

  function askNoraToExplain() {
    const prompt = [
      `Explique o relatorio operacional do Norium para o periodo "${periodLabels[period]}".`,
      `Dados atuais: ${totalEvents} eventos filtrados, produtividade em ${productivity.score}%,`,
      `${formatSavedTime(productivity.savedMinutes)} economizados, ${activeChannels} canais ativos e ${systemWarnings} alertas do sistema.`,
      `Financeiro do periodo: saldo de ${money(finance.saldo)}, ${finance.vencidos} lancamento(s) vencido(s).`,
      "Destaque o que merece atencao e sugira uma proxima acao concreta.",
    ].join(" ");
    onOpenNora?.(prompt);
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
      logoUrl: noriumLogo,
      defaultSettings: defaultReportCustomizer,
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
      logoUrl: noriumLogo,
      defaultSettings: defaultReportCustomizer,
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
    const blob = await buildFinancePdfReport({ finance, period, connected, theme: reportTheme, logoUrl: noriumLogo });
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
        logoUrl: noriumLogo,
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
        logoUrl: noriumLogo,
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
            onClick={askNoraToExplain}
            className="flex h-10 items-center gap-2 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-4 text-xs font-black text-[var(--primary)] transition hover:bg-[var(--primary)]/20"
          >
            <Sparkles size={15} />
            Pedir a Nora para explicar
          </button>
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
                  const metadataEntries = Object.entries(event.metadata || {}).filter(
                    ([, value]) => value !== null && value !== undefined && value !== "",
                  );
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
                        {metadataEntries.length > 0 && (
                          <details className="mt-1.5">
                            <summary className="cursor-pointer text-[11px] font-bold text-[var(--text-secondary)] hover:text-[var(--text)]">
                              Detalhes ({metadataEntries.length})
                            </summary>
                            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5">
                              {metadataEntries.slice(0, 8).map(([key, value]) => (
                                <div key={key} className="contents">
                                  <dt className="text-[10px] font-black uppercase text-[var(--text-secondary)]">{key}</dt>
                                  <dd className="min-w-0 truncate text-[11px] font-semibold text-[var(--text)]">
                                    {typeof value === "object" ? JSON.stringify(value) : String(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        )}
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
