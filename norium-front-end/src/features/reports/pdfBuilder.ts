import type { ReportDocument, ReportTable, NoraReportAnalysis } from "./reportDocument";
export type PdfThemeName = "dark" | "light";
export type ReportExportOptions = { title: string; theme: PdfThemeName; logoUrl: string; comments: string; includeAnalysis: boolean; includeDetails: boolean };
export function csvEscape(value: string) { const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replace(/"/g, '""')}"`; }
export function downloadBlob(blob: Blob, fileName: string) { const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = fileName; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
export function sanitizePdfText(value: string) { return value.replace(/[\u2010-\u2015]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7e\xa0-\xff\n]/g, " ").replace(/ +/g, " ").trim(); }
export const insightLabels = { positive: "Ponto positivo", attention: "Ponto de atenção", opportunity: "Oportunidade", neutral: "Observação" };
export function analysisTable(analysis: NoraReportAnalysis): ReportTable {
  return { id: "nora", title: "Comentários e recomendações da Nora", columns: [{ label: "Leitura", width: 18 }, { label: "Análise e contexto", width: 48 }, { label: "Próxima ação", width: 34 }], rows: analysis.insights.map((item, index) => ({ id: String(index), cells: [insightLabels[item.kind], `${item.title}\n${item.explanation}`, item.recommendation], tone: item.kind === "positive" ? "positive" : item.kind === "attention" ? "negative" : item.kind === "opportunity" ? "warning" : "info" })) };
}
export function exportReportCsv(report: ReportDocument) { const rows = [["Relatório", report.title], ["Período", report.period], ["Filtros", report.filters.join(" · ")], [], ["Indicador", "Valor", "Critério"], ...report.metrics.map(item => [item.label, item.value, item.detail]), ...report.tables.flatMap(table => [[], [table.title], table.columns.map(column => column.label), ...table.rows.map(row => row.cells)]), [], ["Notas de leitura"], ...report.notes.map(note => [note])]; return new Blob(["\ufeff", rows.map(row => row.map(csvEscape).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }); }
export async function buildStructuredReportPdf(report: ReportDocument, options: ReportExportOptions, analysis?: NoraReportAnalysis | null) {
  const { apiBlobRequest } = await import("../../core/api/client");
  return apiBlobRequest("/api/relatorios/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ report, options: { title: options.title, theme: options.theme, comments: options.comments, includeAnalysis: options.includeAnalysis, includeDetails: options.includeDetails }, analysis }), timeoutMs: 145_000 });
}
