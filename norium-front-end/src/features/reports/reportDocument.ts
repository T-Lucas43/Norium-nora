import type { EventSource, OmnichannelEvent, SystemNotification } from "../../types/omnichannel";
import type { FinanceData, FinanceEntry } from "./types";
import { calculateFinanceMetrics, calculateProductivity, classifyEvent, formatDate, formatFinanceDate, formatSavedTime, money, sourceLabels } from "./metrics";

export type Tone = "positive" | "negative" | "warning" | "info" | "neutral";
export type ReportId = "overview" | "channels" | "activity" | "cash" | "entries" | "categories" | "pending" | "scheduled" | "boletos" | "tasks" | "automations" | "communication" | "team" | "alerts";
export const reportGroups: { label: string; items: { id: ReportId; label: string; description: string }[] }[] = [
  { label: "Geral", items: [
    { id: "overview", label: "Visão executiva", description: "Resultados e atividade do período em uma leitura objetiva." },
    { id: "channels", label: "Canais e volume", description: "Distribuição dos registros e ações por canal." },
    { id: "activity", label: "Registro de atividades", description: "Consulte os eventos que compõem os indicadores." },
  ] },
  { label: "Financeiro", items: [
    { id: "cash", label: "Resultado financeiro", description: "Entradas, saídas e saldo realizado no período." },
    { id: "entries", label: "Lançamentos", description: "Detalhamento dos movimentos financeiros e seus estados." },
    { id: "categories", label: "Despesas por categoria", description: "Saídas efetivamente pagas, agrupadas por categoria." },
    { id: "pending", label: "A pagar e a receber", description: "Obrigações e recebimentos pendentes, incluindo vencidos." },
    { id: "scheduled", label: "Programações", description: "Compromissos ativos pela data do próximo vencimento." },
    { id: "boletos", label: "Boletos", description: "Títulos identificados e seus vencimentos." },
  ] },
  { label: "Operação", items: [
    { id: "tasks", label: "Tarefas", description: "Conclusões e movimentações registradas nas tarefas." },
    { id: "automations", label: "Automações", description: "Atividade registrada pelos fluxos automatizados." },
    { id: "communication", label: "Comunicação", description: "Atividade do Gmail, WhatsApp e agenda." },
    { id: "team", label: "Equipe", description: "Eventos da equipe disponíveis no histórico." },
    { id: "alerts", label: "Alertas", description: "Ocorrências e notificações no período selecionado." },
  ] },
];
export const reportCatalog = reportGroups.flatMap(group => group.items.map(item => ({ ...item, group: group.label })));
export type ReportFilters = { from: string; to: string; source: string; search: string; status: string; direction: string; category: string };
export const emptyReportFilters: ReportFilters = { from: "", to: "", source: "all", search: "", status: "all", direction: "all", category: "all" };
export type ReportMetric = { id: string; label: string; value: string; detail: string; tone: Tone };
export type ReportColumn = { label: string; width: number; align?: "right" };
export type ReportTable = { id: string; title: string; description?: string; columns: ReportColumn[]; rows: { id: string; cells: string[]; tone?: Tone }[] };
export type ReportDocument = { id: ReportId; title: string; subtitle: string; period: string; filters: string[]; generatedAt: string; metrics: ReportMetric[]; tables: ReportTable[]; notes: string[]; recordCount: number };
export type NoraInsight = { kind: "positive" | "attention" | "opportunity" | "neutral"; title: string; explanation: string; evidenceIds: string[]; recommendation: string };
export type NoraReportAnalysis = { summary: string; insights: NoraInsight[]; limitations: string[]; generatedAt: string };

export function matchesDates(value: string | null | undefined, filters: Pick<ReportFilters, "from" | "to">) {
  if (!filters.from && !filters.to) return true;
  if (!value) return false;
  const time = new Date(value.length <= 10 ? `${value}T12:00:00` : value).getTime();
  return Number.isFinite(time) && (!filters.from || time >= new Date(`${filters.from}T00:00:00`).getTime()) && (!filters.to || time <= new Date(`${filters.to}T23:59:59.999`).getTime());
}
const normalized = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
const sum = (entries: FinanceEntry[]) => entries.reduce((total, entry) => total + Number(entry.amount || 0), 0);
export function isOverdue(entry: FinanceEntry) { return entry.status === "pendente" && !!entry.dueDate && entry.dueDate.slice(0, 10) < localDate(new Date()); }
export function localDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function periodRange(days: number) { const end = new Date(), start = new Date(end); start.setDate(start.getDate() - days + 1); return { from: localDate(start), to: localDate(end) }; }
export function reportFingerprint(document: ReportDocument) { return JSON.stringify({ ...document, generatedAt: "" }); }
const metric = (id: string, label: string, value: string | number, detail: string, tone: Tone = "info"): ReportMetric => ({ id, label, value: String(value), detail, tone });
const col = (label: string, width: number, align?: "right"): ReportColumn => ({ label, width, align });
const entryStatus = (entry: FinanceEntry) => isOverdue(entry) ? "Vencido" : ({ pago: "Pago", pendente: "Pendente", cancelado: "Cancelado" }[entry.status]);
function entryTable(entries: FinanceEntry[], title = "Lançamentos do período"): ReportTable {
  return { id: "entries", title, columns: [col("Lançamento / categoria", 32), col("Tipo", 13), col("Situação", 14), col("Data de referência", 21), col("Valor", 20, "right")], rows: entries.map(entry => ({ id: entry.id, cells: [`${entry.title}\n${entry.category || "Geral"}`, entry.type === "entrada" ? "Entrada" : "Saída", entryStatus(entry), formatFinanceDate(entry.paidAt || entry.dueDate || entry.createdAt), money(entry.amount)], tone: entry.status === "cancelado" ? "neutral" : isOverdue(entry) ? "negative" : entry.status === "pendente" ? "warning" : entry.type === "entrada" ? "positive" : "negative" })) };
}
function activityTable(events: OmnichannelEvent[]): ReportTable {
  return { id: "activity", title: "Atividades registradas", columns: [col("Data", 18), col("Canal", 14), col("Atividade", 43), col("Classificação", 25)], rows: events.map(event => ({ id: event.id, cells: [formatDate(event.timestamp), sourceLabels[event.source], `${event.title}${event.description ? `\n${event.description}` : ""}`, classifyEvent(event).reason] })) };
}

export function buildReportDocument({ id, filters, events, notifications, financeData, financeAvailable, connected }: { id: ReportId; filters: ReportFilters; events: OmnichannelEvent[]; notifications: SystemNotification[]; financeData: FinanceData; financeAvailable: boolean; connected: boolean }): ReportDocument {
  const meta = reportCatalog.find(item => item.id === id)!;
  const financeReport = meta.group === "Financeiro";
  const match = (value: string) => normalized(value).includes(normalized(filters.search.trim()));
  const operationSources: Partial<Record<ReportId, EventSource[]>> = { tasks: ["kanban"], automations: ["automacoes"], communication: ["gmail", "whatsapp", "calendar"], team: ["equipe"] };
  const selectedEvents = events.filter(event => matchesDates(event.timestamp, filters) && (filters.source === "all" || event.source === filters.source) && (!operationSources[id] || operationSources[id]!.includes(event.source)) && match(`${event.title} ${event.description} ${sourceLabels[event.source]}`)).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const entries = financeData.lancamentos.filter(entry => matchesDates(entry.paidAt || entry.dueDate || entry.createdAt, filters) && (!financeReport || (filters.status === "all" || (filters.status === "vencido" ? isOverdue(entry) : entry.status === filters.status)) && (filters.direction === "all" || entry.type === filters.direction) && (filters.category === "all" || entry.category === filters.category) && match(`${entry.title} ${entry.description} ${entry.category}`))).sort((a, b) => Date.parse(b.paidAt || b.dueDate || b.createdAt) - Date.parse(a.paidAt || a.dueDate || a.createdAt));
  const finance = calculateFinanceMetrics({ ...financeData, lancamentos: entries }, "all");
  const pending = entries.filter(entry => entry.status === "pendente"), paid = entries.filter(entry => entry.status === "pago");
  const receivable = sum(pending.filter(entry => entry.type === "entrada")), payable = sum(pending.filter(entry => entry.type === "saida"));
  const productivity = calculateProductivity(selectedEvents);
  const alerts = notifications.filter(item => matchesDates(item.timestamp, filters) && match(`${item.title} ${item.description || ""}`));
  const channels = (Object.keys(sourceLabels) as EventSource[]).map(source => { const items = selectedEvents.filter(event => event.source === source); return { source, count: items.length, productive: calculateProductivity(items).productiveEvents }; }).filter(item => item.count > 0);
  const financeMetrics = [metric("income", "Entradas pagas", money(finance.entradas), "Recebimentos realizados", "positive"), metric("expenses", "Saídas pagas", money(finance.saidas), "Pagamentos realizados", "negative"), metric("balance", "Saldo do período", money(finance.saldo), "Entradas menos saídas pagas", finance.saldo < 0 ? "negative" : "info"), metric("payable", "A pagar", money(payable), `${pending.filter(entry => entry.type === "saida").length} lançamento(s) pendente(s)`, "warning")];
  const notes = [financeReport ? "Regime de caixa: pagos pela data de pagamento; demais registros pelo vencimento ou criação. Cancelados não compõem os totais. O saldo do período não representa o saldo bancário." : "Os indicadores operacionais usam os eventos disponíveis no histórico, não o estoque completo de tarefas ou mensagens. Tempo poupado e índice de ações são estimativas por tipo de evento."];
  if (!connected && !financeReport) notes.push("A conexão ao vivo está indisponível. Os dados correspondem ao último histórico recebido.");
  if (!financeAvailable && (financeReport || id === "overview")) notes.push("Dados financeiros indisponíveis. Não interprete sua ausência como saldo zero.");
  const document: ReportDocument = { id, title: meta.label, subtitle: meta.description, period: filters.from || filters.to ? `${filters.from ? formatFinanceDate(filters.from) : "Início do histórico"} a ${filters.to ? formatFinanceDate(filters.to) : "hoje"}` : "Todo o histórico disponível", filters: [], generatedAt: new Date().toISOString(), metrics: [], tables: [], notes, recordCount: financeReport ? entries.length : selectedEvents.length };
  if (filters.search) document.filters.push(`Busca: ${filters.search}`);
  if (!financeReport && filters.source !== "all") document.filters.push(`Canal: ${sourceLabels[filters.source as EventSource]}`);
  if (financeReport && ["cash", "entries", "categories", "pending"].includes(id)) {
    if (filters.status !== "all") document.filters.push(`Situação: ${filters.status}`);
    if (filters.direction !== "all") document.filters.push(`Tipo: ${filters.direction}`);
    if (filters.category !== "all") document.filters.push(`Categoria: ${filters.category}`);
  }
  const channelTable: ReportTable = { id: "channels", title: "Distribuição por canal", columns: [col("Canal", 35), col("Eventos", 20, "right"), col("Participação", 20, "right"), col("Ações identificadas", 25, "right")], rows: channels.map(item => ({ id: item.source, cells: [sourceLabels[item.source], String(item.count), `${(item.count / Math.max(1, selectedEvents.length) * 100).toFixed(1)}%`, String(item.productive)] })) };
  if (!financeReport) {
    document.metrics = [metric("events", "Eventos no período", selectedEvents.length, "Histórico filtrado"), metric("actions", "Ações identificadas", productivity.productiveEvents, "Eventos classificados como ações", "positive"), metric("time", "Tempo estimado", formatSavedTime(productivity.savedMinutes), "Estimativa de tempo poupado", "info"), metric("channels", "Canais com atividade", channels.length, "Com eventos no filtro", "warning")];
    document.tables = id === "channels" ? [channelTable] : id === "overview" ? [channelTable, activityTable(selectedEvents)] : [activityTable(selectedEvents)];
    if (id === "overview" && financeAvailable) { document.metrics = [document.metrics[0], document.metrics[1], financeMetrics[2], metric("overdue", "Pendências vencidas", finance.vencidos, "Lançamentos do período", finance.vencidos ? "negative" : "positive")]; document.tables.splice(1, 0, { id: "finance-summary", title: "Resumo financeiro", columns: [col("Indicador", 35), col("Critério", 40), col("Valor", 25, "right")], rows: financeMetrics.map(item => ({ id: item.id, cells: [item.label, item.detail, item.value], tone: item.tone })) }); document.notes.push("O resumo financeiro considera o período. A busca e o filtro de canal restringem apenas os eventos."); }
    if (id === "tasks") document.metrics[1] = metric("completed", "Conclusões registradas", productivity.completedTasks, "Eventos de conclusão; pode haver repetições", "positive");
    if (id === "alerts") { document.recordCount = alerts.length; document.metrics = (["error", "warning", "info", "success"] as const).map((severity, index) => metric(severity, ["Erros", "Atenção", "Informações", "Sucessos"][index], alerts.filter(item => item.severity === severity).length, "Notificações do período", (["negative", "warning", "info", "positive"] as Tone[])[index])); document.tables = [{ id: "alerts", title: "Notificações do período", columns: [col("Data", 22), col("Nível", 16), col("Notificação", 62)], rows: alerts.map(item => ({ id: item.id, cells: [formatDate(item.timestamp), ({ error: "Erro", warning: "Atenção", info: "Informação", success: "Sucesso" })[item.severity], `${item.title}\n${item.description || ""}`], tone: item.severity === "error" ? "negative" : item.severity === "warning" ? "warning" : "info" })) }]; }
  } else {
    document.metrics = financeMetrics;
    if (id === "cash" || id === "entries") document.tables = [entryTable(entries)];
    if (id === "categories" || id === "cash") {
      const groups = new Map<string, { count: number; amount: number }>();
      paid.filter(entry => entry.type === "saida").forEach(entry => { const key = entry.category || "Geral", value = groups.get(key) || { count: 0, amount: 0 }; groups.set(key, { count: value.count + 1, amount: value.amount + entry.amount }); });
      document.tables.unshift({ id: "categories", title: "Despesas pagas por categoria", columns: [col("Categoria", 40), col("Pagamentos", 18, "right"), col("Participação", 20, "right"), col("Total pago", 22, "right")], rows: [...groups].sort((a, b) => b[1].amount - a[1].amount).map(([category, value], index) => ({ id: `category-${index}`, cells: [category, String(value.count), `${(value.amount / Math.max(1, finance.saidas) * 100).toFixed(1)}%`, money(value.amount)], tone: "negative" })) });
      if (id === "categories") document.recordCount = paid.filter(entry => entry.type === "saida").length;
    }
    if (id === "pending") { document.recordCount = pending.length; document.metrics = [metric("payable", "A pagar", money(payable), "Saídas pendentes", "warning"), metric("receivable", "A receber", money(receivable), "Entradas pendentes", "positive"), metric("overdue", "Vencidos", finance.vencidos, "Entradas e saídas pendentes", "negative"), metric("pending-total", "Em aberto", pending.length, "Lançamentos pendentes")]; document.tables = [entryTable(pending, "Pendências do período")]; }
    if (id === "scheduled") { const items = financeData.programados.filter(item => item.active && matchesDates(item.nextDueDate, filters) && match(`${item.title} ${item.category}`)); document.recordCount = items.length; document.metrics = [metric("scheduled", "Programações ativas", items.length, "Próximo vencimento no período"), metric("scheduled-out", "Saídas previstas", money(items.filter(item => item.type === "saida").reduce((total, item) => total + item.amount, 0)), "Uma ocorrência por programação", "warning"), metric("scheduled-in", "Entradas previstas", money(items.filter(item => item.type === "entrada").reduce((total, item) => total + item.amount, 0)), "Uma ocorrência por programação", "positive")]; document.tables = [{ id: "scheduled", title: "Próximas ocorrências", columns: [col("Programação", 33), col("Tipo", 12), col("Recorrência", 16), col("Próximo vencimento", 21), col("Valor", 18, "right")], rows: items.map(item => ({ id: item.id, cells: [item.title, item.type === "entrada" ? "Entrada" : "Saída", { unico: "Única", semanal: "Semanal", mensal: "Mensal", anual: "Anual" }[item.frequency], formatFinanceDate(item.nextDueDate), money(item.amount)] })) }]; document.notes = ["Programações são previsões. Cada item mostra a próxima ocorrência, sem multiplicar recorrências ou compor o saldo realizado."]; }
    if (id === "boletos") { const items = financeData.boletos.filter(item => matchesDates(item.dueDate, filters) && match(`${item.title} ${item.beneficiary}`)); document.recordCount = items.length; document.metrics = [metric("boletos", "Boletos identificados", items.length, "Títulos no período"), metric("boleto-value", "Valor nominal", money(items.reduce((total, item) => total + item.amount, 0)), "Pode incluir títulos já pagos", "warning")]; document.tables = [{ id: "boletos", title: "Boletos identificados", columns: [col("Título / beneficiário", 42), col("Situação", 16), col("Vencimento", 22), col("Valor", 20, "right")], rows: items.map(item => ({ id: item.id, cells: [`${item.title}\n${item.beneficiary}`, item.status, formatFinanceDate(item.dueDate), money(item.amount)] })) }]; document.notes = ["Boletos são apresentados separadamente dos lançamentos para evitar contagem duplicada. A identificação de um título não confirma seu pagamento."]; }
    if (!financeAvailable) { document.metrics = []; document.tables = []; document.recordCount = 0; document.notes = ["Os dados financeiros não puderam ser carregados. Atualize para tentar novamente."]; }
  }
  return document;
}

export function analysisEvidence(document: ReportDocument) {
  return { title: document.title, period: document.period, filters: document.filters, recordCount: document.recordCount, notes: document.notes, metrics: document.metrics, tables: document.tables.map(table => ({ id: table.id, title: table.title, columns: table.columns.map(column => column.label), totalRows: table.rows.length, rows: table.rows.slice(0, 25).map((row, index) => ({ id: `${table.id}:${index}`, cells: row.cells.map(cell => cell.slice(0, 600)) })) })) };
}
