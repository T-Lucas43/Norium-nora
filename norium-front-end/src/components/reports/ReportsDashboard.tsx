import { useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, Download, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import type { EventSource, OmnichannelEvent, SystemNotification } from "../../types/omnichannel";
import type { FinanceData } from "../../features/reports/types";
import { emptyFinanceData, sourceLabels } from "../../features/reports/metrics";
import { buildReportDocument, emptyReportFilters, periodRange, reportCatalog, reportFingerprint, type ReportFilters, type ReportId } from "../../features/reports/reportDocument";
import { loadFinanceReportData, registerReportEvent } from "../../features/reports/api";
import { downloadBlob, exportReportCsv } from "../../features/reports/pdfBuilder";
import ReportsSidebar from "./ReportsSidebar";
import ReportView from "./ReportView";
import ReportNoraPanel, { type SavedReportAnalysis } from "./ReportNoraPanel";
import ReportExportDialog from "./ReportExportDialog";
import Button from "../shared/Button";
import "./reports.css";

type Props = { eventsBySource: Record<EventSource, OmnichannelEvent[]>; notifications: SystemNotification[]; connected: boolean; userId?: string; onOpenNora?: (prompt?: string) => void };
export default function ReportsDashboard({ eventsBySource, notifications, connected, userId = "primary", onOpenNora }: Props) {
  const [active, setActive] = useState<ReportId>("overview"), [range, setRange] = useState("30"), [filters, setFilters] = useState<ReportFilters>(() => ({ ...emptyReportFilters, ...periodRange(30) }));
  const [advanced, setAdvanced] = useState(false), [refresh, setRefresh] = useState(0), [finance, setFinance] = useState<{ user: string; data: FinanceData } | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [saved, setSaved] = useState<SavedReportAnalysis | null>(null), [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    let activeRequest = true; setLoading(true); setError("");
    void loadFinanceReportData(userId).then(data => { if (activeRequest) setFinance({ user: userId, data }); }).catch(reason => { if (activeRequest) { setError(reason instanceof Error ? reason.message : "Não foi possível atualizar os dados financeiros."); setFinance(null); } }).finally(() => { if (activeRequest) setLoading(false); });
    return () => { activeRequest = false; };
  }, [userId, refresh]);
  const data = finance?.user === userId ? finance.data : emptyFinanceData;
  const meta = reportCatalog.find(item => item.id === active)!, financeView = meta.group === "Financeiro", entryView = ["cash", "entries", "categories", "pending"].includes(active);
  const allEvents = useMemo(() => Object.values(eventsBySource).flat(), [eventsBySource]);
  const report = useMemo(() => buildReportDocument({ id: active, filters, events: allEvents, notifications, financeData: data, financeAvailable: finance?.user === userId, connected }), [active, filters, allEvents, notifications, data, finance, userId, connected]);
  const invalidDates = !!filters.from && !!filters.to && filters.from > filters.to;
  const unavailable = invalidDates || (financeView && (loading || !!error));
  const analysis = saved?.fingerprint === reportFingerprint(report) ? saved.analysis : null;
  const categories = [...new Set(data.lancamentos.map(entry => entry.category).filter(Boolean))].sort();
  function update<K extends keyof ReportFilters>(key: K, value: ReportFilters[K]) { setFilters(current => ({ ...current, [key]: value })); }
  function select(id: ReportId) { setActive(id); setFilters(current => ({ ...emptyReportFilters, from: current.from, to: current.to })); }
  function selectRange(value: string) { setRange(value); if (value !== "custom") setFilters(current => ({ ...current, ...(value === "all" ? { from: "", to: "" } : periodRange(Number(value))) })); }
  function csv() { downloadBlob(exportReportCsv(report), `norium-${active}.csv`); registerReportEvent("Relatório CSV exportado", `${report.title}: ${report.recordCount} registros.`, { action: "report_csv_exported", report: active, period: report.period }); }
  return <section className="reports-workspace">
    <header className="reports-header"><div className="reports-title"><span><BarChart3 size={21}/></span><div><h1>Relatórios</h1><p>Dados organizados. Decisões com contexto.</p></div></div><div className="reports-header-actions"><span className={`reports-connection ${connected ? "is-connected" : ""}`}><i/>{connected ? "Ao vivo" : "Último histórico"}</span><Button size="sm" loading={loading} onClick={() => setRefresh(value => value + 1)} aria-label="Atualizar dados financeiros"><RefreshCw size={14}/>Atualizar</Button><Button size="sm" disabled={unavailable} onClick={csv}><Download size={14}/>CSV</Button><Button size="sm" disabled={unavailable} onClick={() => setExportOpen(true)}><Download size={14}/>Preparar PDF</Button></div></header>
    <div className="reports-layout"><ReportsSidebar activeReport={active} onSelect={select}/><main className="reports-main">
      <div className="report-heading"><div><div className="report-breadcrumb">{meta.group}<span>/</span>{meta.label}</div><h2>{meta.label}</h2><p>{meta.description}</p></div><span className="report-count">{report.recordCount.toLocaleString("pt-BR")} registros</span></div>
      <section className="reports-filters" aria-label="Filtros do relatório"><div className="reports-filter-row"><label className="report-search"><Search size={15}/><input aria-label="Pesquisar registros" placeholder="Pesquisar neste relatório…" value={filters.search} onChange={event => update("search", event.target.value)}/></label><label className="report-period"><CalendarDays size={15}/><select aria-label="Período do relatório" value={range} onChange={event => selectRange(event.target.value)}><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="all">Todo o histórico</option><option value="custom">Personalizado</option></select></label>{active !== "alerts" && !["scheduled", "boletos"].includes(active) && <Button size="sm" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><SlidersHorizontal size={14}/>Filtros</Button>}</div>
        {range === "custom" && <div className="reports-filter-extra"><label>De<input type="date" aria-label="Data inicial" value={filters.from} max={filters.to || undefined} onChange={event => update("from", event.target.value)}/></label><label>Até<input type="date" aria-label="Data final" value={filters.to} min={filters.from || undefined} onChange={event => update("to", event.target.value)}/></label></div>}
        {advanced && entryView && <div className="reports-filter-extra"><label>Situação<select value={filters.status} onChange={event => update("status", event.target.value)}><option value="all">Todas</option><option value="pago">Pago</option><option value="pendente">Pendente</option><option value="vencido">Vencido</option><option value="cancelado">Cancelado</option></select></label><label>Tipo<select value={filters.direction} onChange={event => update("direction", event.target.value)}><option value="all">Entradas e saídas</option><option value="entrada">Entradas</option><option value="saida">Saídas</option></select></label><label>Categoria<select value={filters.category} onChange={event => update("category", event.target.value)}><option value="all">Todas as categorias</option>{categories.map(category => <option key={category}>{category}</option>)}</select></label><Button size="sm" variant="ghost" onClick={() => setFilters(current => ({ ...current, status: "all", direction: "all", category: "all", search: "" }))}>Limpar filtros</Button></div>}
        {advanced && !financeView && active !== "alerts" && <div className="reports-filter-extra"><label>Canal<select value={filters.source} onChange={event => update("source", event.target.value)}><option value="all">Todos os canais</option>{Object.entries(sourceLabels).map(([source, label]) => <option key={source} value={source}>{label}</option>)}</select></label><Button size="sm" variant="ghost" onClick={() => { update("source", "all"); update("search", ""); }}>Limpar filtros</Button></div>}
      </section>
      {invalidDates && <p className="report-feedback is-error" role="alert">A data inicial deve ser anterior ou igual à data final.</p>}{(financeView || active === "overview") && error && <p className="report-feedback is-error" role="alert">{error} Use Atualizar para tentar novamente.</p>}
      {financeView && loading ? <div className="report-loading" role="status"><RefreshCw size={18}/>Carregando dados financeiros…</div> : !invalidDates && <ReportView report={report}/>}
      <ReportNoraPanel report={report} saved={saved} onAnalyzed={setSaved} onOpenNora={onOpenNora} disabled={unavailable}/>
      <footer className="reports-footer"><span>{report.period}</span><span>Dados do histórico e do financeiro do seu espaço.</span></footer>
    </main></div>{exportOpen && <ReportExportDialog report={report} analysis={analysis} onClose={() => setExportOpen(false)}/>}</section>;
}
