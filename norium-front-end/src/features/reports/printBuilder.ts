// Geracao da janela de impressao HTML do relatorio - extraido de ReportsDashboard.tsx
// para separar a logica de exportacao da renderizacao.
import type { EventSource, OmnichannelEvent } from "../../types/omnichannel";
import type { FinanceMetrics, Period, ProductivityMetrics, ReportSource } from "./types";
import { formatDate, formatGeneratedAt, formatSavedTime, money, periodLabels, sourceLabels } from "./metrics";
import type { PdfThemeName } from "./pdfBuilder";

function escapePrintHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function printReportDocument(params: {
  title: string;
  theme: PdfThemeName;
  period: Period;
  activeSource: ReportSource;
  productivity: ProductivityMetrics;
  sourceCounts: Array<{ source: EventSource; count: number }>;
  events: OmnichannelEvent[];
  finance: FinanceMetrics;
  logoUrl: string;
}) {
  const printWindow = window.open("", "_blank", "width=1100,height=800");
  if (!printWindow) throw new Error("O navegador bloqueou a janela de impressao.");
  printWindow.opener = null;
  const isDark = params.theme === "dark";
  const colors = isDark
    ? { background: "#071220", surface: "#111f35", soft: "#182a45", border: "#2d4266", text: "#f7fbff", muted: "#a3b8d6" }
    : { background: "#eef5ff", surface: "#ffffff", soft: "#eaf2ff", border: "#b8cce8", text: "#0a1a33", muted: "#4d647f" };
  const sourceLabel = params.activeSource === "all" ? "Todos os canais" : sourceLabels[params.activeSource];
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
<header><div class="brand"><img src="${escapePrintHtml(params.logoUrl)}" alt="Norium"><div class="eyebrow">RELATORIO INTELIGENTE</div></div><h1>${escapePrintHtml(params.title)}</h1><div>Gerado em ${escapePrintHtml(formatGeneratedAt())} | ${escapePrintHtml(periodLabels[params.period])} | ${escapePrintHtml(sourceLabel)}</div></header>
<section class="grid">${cards.map(([label, value]) => `<article class="card"><span>${escapePrintHtml(label)}</span><strong>${escapePrintHtml(value)}</strong></article>`).join("")}</section>
<h2>Volume por canal</h2><section class="channels">${params.sourceCounts.map((item) => `<article class="channel"><strong>${escapePrintHtml(sourceLabels[item.source])}: ${item.count}</strong><div class="bar"><i style="width:${Math.max(2, Math.round((item.count / maxSource) * 100))}%"></i></div></article>`).join("")}</section>
<h2>Resumo financeiro</h2><section class="channels"><article class="card"><span>Entradas pagas</span><strong>${escapePrintHtml(money(params.finance.entradas))}</strong></article><article class="card"><span>Saidas pagas</span><strong>${escapePrintHtml(money(params.finance.saidas))}</strong></article><article class="card"><span>Pendente</span><strong>${escapePrintHtml(money(params.finance.pendente))}</strong></article><article class="card"><span>Vencidos</span><strong>${params.finance.vencidos}</strong></article></section>
<h2>Eventos recentes</h2>${params.events.slice(0, 30).map((event) => `<article class="event"><strong>${escapePrintHtml(formatDate(event.timestamp))} | ${escapePrintHtml(sourceLabels[event.source])} | ${escapePrintHtml(event.title)}</strong><div class="muted">${escapePrintHtml(event.description || "Evento sem descricao")}</div></article>`).join("") || '<article class="event">Nenhum evento no periodo.</article>'}
<footer>Norium | Relatorio operacional | Desenvolvido pela Equipe Norium</footer>
</main><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
