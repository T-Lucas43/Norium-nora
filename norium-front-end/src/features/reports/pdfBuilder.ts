import type { ReportDocument, ReportTable, NoraReportAnalysis, Tone } from "./reportDocument";
export type PdfThemeName = "dark" | "light";
export type ReportExportOptions = { title: string; theme: PdfThemeName; logoUrl: string; comments: string; includeAnalysis: boolean; includeDetails: boolean };
export function csvEscape(value: string) { const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replace(/"/g, '""')}"`; }
export function downloadBlob(blob: Blob, fileName: string) { const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = fileName; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
export function sanitizePdfText(value: string) { return value.replace(/[\u2010-\u2015]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7e\xa0-\xff\n]/g, " ").replace(/ +/g, " ").trim(); }
const palette = {
  light: { background: "#ffffff", surface: "#f4f4f5", border: "#dedee2", text: "#18181b", muted: "#61616b", positive: "#08734c", negative: "#b3263f", warning: "#966000", info: "#454750", neutral: "#61616b" },
  dark: { background: "#101113", surface: "#1b1d21", border: "#34363c", text: "#f4f4f5", muted: "#b6b6c0", positive: "#65d6aa", negative: "#fa929f", warning: "#f2cb70", info: "#d1d3d8", neutral: "#b6b6c0" },
};
export const insightLabels = { positive: "Ponto positivo", attention: "Ponto de atenção", opportunity: "Oportunidade", neutral: "Observação" };
export function analysisTable(analysis: NoraReportAnalysis): ReportTable {
  return { id: "nora", title: "Comentários e recomendações da Nora", columns: [{ label: "Leitura", width: 18 }, { label: "Análise e contexto", width: 48 }, { label: "Próxima ação", width: 34 }], rows: analysis.insights.map((item, index) => ({ id: String(index), cells: [insightLabels[item.kind], `${item.title}\n${item.explanation}`, item.recommendation], tone: item.kind === "positive" ? "positive" : item.kind === "attention" ? "negative" : item.kind === "opportunity" ? "warning" : "info" })) };
}
export function exportReportCsv(report: ReportDocument) { const rows = [["Relatório", report.title], ["Período", report.period], ["Filtros", report.filters.join(" · ")], [], ["Indicador", "Valor", "Critério"], ...report.metrics.map(item => [item.label, item.value, item.detail]), ...report.tables.flatMap(table => [[], [table.title], table.columns.map(column => column.label), ...table.rows.map(row => row.cells)]), [], ["Notas de leitura"], ...report.notes.map(note => [note])]; return new Blob(["\ufeff", rows.map(row => row.map(csvEscape).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }); }
async function logoData(url: string) {
  try { const response = await fetch(url); if (!response.ok) return null; const blob = await response.blob(); return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); }); } catch { return null; }
}
export async function buildStructuredReportPdf(report: ReportDocument, options: ReportExportOptions, analysis?: NoraReportAnalysis | null) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const theme = palette[options.theme], margin = 40, width = 515.28, bottom = 792, top = 94;
  const logo = await logoData(options.logoUrl);
  let y = top;
  const safe = sanitizePdfText;
  const text = (value: string | string[], x: number, at: number, size = 9, bold = false, color = theme.text, align: "left" | "right" = "left") => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(size); pdf.setTextColor(color); pdf.text(Array.isArray(value) ? value.map(safe) : safe(value), x, at, { lineHeightFactor: 1.4, align }); };
  function wrap(value: string, maxWidth: number, size = 9) { pdf.setFont("helvetica", "normal"); pdf.setFontSize(size); return pdf.splitTextToSize(safe(value), maxWidth) as string[]; }
  function frame() {
    pdf.setFillColor(theme.background); pdf.rect(0, 0, 595.28, 841.89, "F");
    pdf.setFillColor("#121315"); pdf.rect(0, 0, 595.28, 72, "F");
    if (logo) { const props = pdf.getImageProperties(logo), h = Math.min(24, 88 * props.height / props.width); pdf.addImage(logo, "PNG", margin, 23, h * props.width / props.height, h); } else text("NORIUM", margin, 43, 18, true, "#ffffff");
    text("CENTRAL DE RELATÓRIOS", 555.28, 31, 8, true, "#fafafa", "right");
    text(report.period, 555.28, 47, 8, false, "#c3c3cb", "right");
    y = top;
  }
  function next() { pdf.addPage(); frame(); }
  function ensure(height: number) { if (y + height > bottom) next(); }
  function paragraph(value: string, size = 9, muted = false) {
    const lines = wrap(value, width, size), lineHeight = size * 1.45;
    for (const line of lines) { ensure(lineHeight); text(line, margin, y + size, size, false, muted ? theme.muted : theme.text); y += lineHeight; }
    y += 8;
  }
  function heading(value: string) { ensure(90); y += 6; text(value, margin, y + 12, 12, true); y += 25; }
  function table(table: ReportTable) {
    heading(table.title);
    const columnWidths = table.columns.map(column => width * column.width / 100);
    function header() { pdf.setFillColor(theme.surface); pdf.rect(margin, y, width, 29, "F"); let x = margin; table.columns.forEach((column, index) => { const lines = wrap(column.label, columnWidths[index] - 14, 8); text(lines, column.align === "right" ? x + columnWidths[index] - 7 : x + 7, y + 11, 8, true, theme.muted, column.align || "left"); x += columnWidths[index]; }); y += 29; }
    header();
    if (!table.rows.length) { ensure(28); text("Nenhum registro neste recorte.", margin + 8, y + 17, 9, false, theme.muted); y += 31; return; }
    table.rows.forEach((row, rowIndex) => {
      const lines = row.cells.map((cell, index) => wrap(cell, columnWidths[index] - 16, 8.5));
      let offset = 0; const count = Math.max(1, ...lines.map(cell => cell.length));
      if (count * 12 + 14 <= bottom - top - 60 && y + count * 12 + 14 > bottom) { next(); heading(`${table.title} (continuação)`); header(); }
      while (offset < count) {
        if (bottom - y < 32) { next(); heading(`${table.title} (continuação)`); header(); }
        const fit = Math.max(1, Math.floor((bottom - y - 14) / 12)), take = Math.min(count - offset, fit), height = take * 12 + 14;
        pdf.setFillColor(rowIndex % 2 ? theme.surface : theme.background); pdf.rect(margin, y, width, height, "F");
        let x = margin;
        lines.forEach((cell, index) => { const color = index === lines.length - 1 && row.tone ? theme[row.tone as Tone] : theme.text; text(cell.slice(offset, offset + take), table.columns[index].align === "right" ? x + columnWidths[index] - 8 : x + 8, y + 14, 8.5, false, color, table.columns[index].align || "left"); x += columnWidths[index]; });
        pdf.setDrawColor(theme.border); pdf.setLineWidth(.35); pdf.line(margin, y + height, margin + width, y + height); y += height; offset += take;
      }
    });
    y += 13;
  }
  frame();
  const titleLines = wrap(options.title || report.title, width, 21);
  for (const line of titleLines) { ensure(29); text(line, margin, y + 21, 21, true); y += 29; }
  y += 4; paragraph(report.subtitle, 9, true);
  if (report.filters.length) paragraph(`Recorte: ${report.filters.join(" | ")}`, 8, true);
  paragraph(`${report.recordCount.toLocaleString("pt-BR")} registros no recorte · Emitido em ${new Date(report.generatedAt).toLocaleString("pt-BR")}`, 8, true);
  for (let start = 0; start < report.metrics.length; start += 2) {
    ensure(76); report.metrics.slice(start, start + 2).forEach((item, index) => { const x = margin + index * (width + 10) / 2, cardWidth = (width - 10) / 2; pdf.setFillColor(theme.surface); pdf.roundedRect(x, y, cardWidth, 66, 4, 4, "F"); pdf.setFillColor(theme[item.tone]); pdf.rect(x, y + 10, 2, 44, "F"); text(item.label, x + 12, y + 16, 8, true, theme.muted); text(item.value, x + 12, y + 38, 17, true, theme[item.tone]); text(wrap(item.detail, cardWidth - 24, 7.5).slice(0, 1), x + 12, y + 55, 7.5, false, theme.muted); }); y += 76;
  }
  if (analysis && options.includeAnalysis) { heading("Leitura executiva da Nora"); paragraph(analysis.summary); table(analysisTable(analysis)); }
  if (options.includeDetails) report.tables.forEach(table);
  if (options.comments.trim()) { heading("Comentários do responsável"); paragraph(options.comments); }
  heading("Critérios e notas de leitura");
  [...report.notes, ...(analysis && options.includeAnalysis ? analysis.limitations : [])].forEach(note => paragraph(`- ${note}`, 8, true));
  if (!options.includeDetails) paragraph("Documento sintético: tabelas detalhadas desmarcadas na exportação.", 8, true);
  const total = pdf.getNumberOfPages();
  for (let page = 1; page <= total; page++) { pdf.setPage(page); pdf.setDrawColor(theme.border); pdf.line(margin, 810, margin + width, 810); text("NORIUM / Relatório de gestão", margin, 826, 7, false, theme.muted); text(`${page} / ${total}`, margin + width, 826, 8, false, theme.muted, "right"); }
  pdf.setProperties({ title: options.title || report.title, author: "Norium", subject: report.period, creator: "Norium - Central de relatórios" });
  return pdf.output("blob");
}
