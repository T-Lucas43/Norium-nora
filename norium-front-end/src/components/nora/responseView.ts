export type NoraTask = {
  id?: string; title: string; description?: string; priority?: string; status?: string;
  dueDate?: string; projectName?: string; assigneeName?: string;
};
export type NoraCalendarEvent = {
  id?: string; titulo?: string; title?: string; inicio?: string; fim?: string;
  descricao?: string; local?: string; status?: string;
};
export type NoraFinanceRow = {
  id?: string; title: string; amount?: number; type?: string; status?: string;
  dueDate?: string; category?: string; frequency?: string;
};
export type NoraMetric = { label: string; value: number; money?: boolean };
export type NoraFinanceGroup = { label: string; rows: NoraFinanceRow[]; total: number };
export type NoraResponseView =
  | { kind: "tasks"; items: NoraTask[]; total: number; metrics?: NoraMetric[]; project?: { name: string; description?: string; category?: string; dueDate?: string } }
  | { kind: "agenda"; events: NoraCalendarEvent[]; date?: string }
  | { kind: "finance"; metrics: NoraMetric[]; groups: NoraFinanceGroup[] };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const objects = (value: unknown) => Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length) : [];
const metricsFrom = (value: unknown, labels: Record<string, string>, money = false): NoraMetric[] => {
  const source = record(value);
  return Object.entries(labels).flatMap(([key, label]) => {
    const amount = number(source[key]);
    return amount === undefined ? [] : [{ label, value: amount, money }];
  });
};

/** Keep only display fields from real agent results; never persist full tool payloads. */
export function buildNoraResponseView(intent: string, value: unknown): NoraResponseView | undefined {
  const result = record(value);
  if (intent === "tarefas") {
    const source = Array.isArray(result.tasks) ? result.tasks : result.task ? [result.task] : undefined;
    const items = objects(source).filter((item) => string(item.title)).slice(0, 100).map((item): NoraTask => ({
      id: string(item.id), title: string(item.title)!, description: string(item.description),
      priority: string(item.priority), status: string(item.status), dueDate: string(item.dueDate),
      projectName: string(item.projectName), assigneeName: string(item.assigneeName) || string(item.responsibleName),
    }));
    const metrics = metricsFrom(result.stats, { ativas: "Ativas", andamento: "Em andamento", vencidas: "Vencidas", concluidas: "Concluídas" });
    const project = record(result.project);
    const name = string(project.name);
    if (!source && !metrics.length && !name) return undefined;
    return { kind: "tasks", items, total: Math.max(items.length, number(result.total) ?? objects(source).length), metrics,
      project: name ? { name, description: string(project.description), category: string(project.category), dueDate: string(project.dueDate) } : undefined };
  }
  if (intent === "agenda") {
    const source = Array.isArray(result.events) ? result.events : result.event ? [result.event] : undefined;
    if (!source) return undefined;
    const events = objects(source).slice(0, 100).map((item): NoraCalendarEvent => ({
      id: string(item.id), titulo: string(item.titulo) || string(item.title), inicio: string(item.inicio), fim: string(item.fim),
      descricao: string(item.descricao), local: string(item.local), status: string(item.status),
    }));
    return { kind: "agenda", events, date: string(result.date) };
  }
  if (intent === "financeiro") {
    const finance = record(result.financeiro);
    const metrics = [...metricsFrom(finance.resumo, { entradas: "Entradas pagas", saidas: "Saídas pagas", saldo: "Saldo realizado", pendente: "A pagar" }, true), ...metricsFrom(finance.resumo, { vencidos: "Vencidos" })];
    const groups: NoraFinanceGroup[] = [];
    const append = (label: string, source: unknown) => {
      if (!Array.isArray(source)) return;
      const entries = objects(source);
      groups.push({ label, total: entries.length, rows: entries.slice(0, 100).map((item) => ({
        id: string(item.id), title: string(item.title) || "Sem descrição", amount: number(item.amount),
        type: string(item.type), status: string(item.status) || (typeof item.active === "boolean" ? item.active ? "ativo" : "inativo" : undefined),
        dueDate: string(item.dueDate) || string(item.nextDueDate), category: string(item.category), frequency: string(item.frequency),
      })) });
    };
    append("Lançamentos", finance.lancamentos ?? (result.lancamento ? [result.lancamento] : undefined));
    append("Programados", finance.programados ?? (result.programado ? [result.programado] : undefined));
    append("Boletos", finance.boletos ?? result.boletos);
    if (!groups.length && !metrics.length) return undefined;
    return { kind: "finance", metrics, groups };
  }
  return undefined;
}

export const normalizeLabel = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function displayLabel(value?: string) {
  const labels: Record<string, string> = { baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente", pendente: "Pendente", andamento: "Em andamento", revisao: "Em revisão", concluida: "Concluída", pago: "Pago", vencido: "Vencido", cancelado: "Cancelado", ativo: "Ativo", inativo: "Inativo", entrada: "Entrada", saida: "Saída", mensal: "Mensal", semanal: "Semanal", anual: "Anual", diario: "Diário" };
  return value ? labels[normalizeLabel(value)] || value.replaceAll("_", " ") : "Não informado";
}
export function validDateKey(value?: string): string | undefined {
  const key = value?.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/)?.[0];
  if (!key) return undefined;
  const date = new Date(`${key}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDateKey(date) === key ? key : undefined;
}
export function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function displayDate(value?: string) {
  const key = validDateKey(value);
  return key ? new Date(`${key}T12:00:00`).toLocaleDateString("pt-BR") : value || "Sem data";
}

export function eventOnDay(event: NoraCalendarEvent, key: string) {
  const start = validDateKey(event.inicio);
  if (!start) return false;
  const end = validDateKey(event.fim) || start;
  // Date-only calendar end dates are exclusive; midnight ends before the next day's events.
  const exclusiveEnd = !event.fim?.includes("T") || /T00:00(?::00)?(?:[.+Z-]|$)/.test(event.fim);
  return key >= start && (key < end || key === end && (!exclusiveEnd || end === start));
}

/** Recognize only the exact older task-list format, preserving unknown prose as Markdown. */
export function legacyTaskView(text: string): NoraResponseView | undefined {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (!/^Aqui est[aã]o suas tarefas(?: filtradas)?:$/i.test(lines[0] || "")) return undefined;
  const items: NoraTask[] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\s*[-*]\s+(.+)\s+\((baixa|m[eé]dia|alta|urgente), (sem vencimento|\d{4}-\d{2}-\d{2})\)\s*$/i);
    if (!match) return undefined;
    items.push({ title: match[1], priority: match[2], dueDate: match[3] === "sem vencimento" ? undefined : match[3] });
  }
  return items.length ? { kind: "tasks", items, total: items.length } : undefined;
}

/** Legacy financial summaries used pipes as separators, not Markdown tables. */
export function legacyFinanceView(text: string): NoraResponseView | undefined {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.shift() !== "Resumo financeiro do Norium:") return undefined;
  const metrics: NoraMetric[] = [];
  const groups: NoraFinanceGroup[] = [];
  let group: NoraFinanceGroup | undefined;
  for (const line of lines) {
    const metric = line.match(/^- (Entradas pagas|Saidas pagas|Saldo|Pendente a pagar): R\$\s*([\d.,-]+)$/);
    if (metric) {
      const amount = Number(metric[2].replaceAll(".", "").replace(",", "."));
      if (!Number.isFinite(amount)) return undefined;
      metrics.push({ label: ({ "Saidas pagas": "Saídas pagas", Saldo: "Saldo realizado", "Pendente a pagar": "A pagar" } as Record<string, string>)[metric[1]] || metric[1], value: amount, money: true });
      continue;
    }
    const overdue = line.match(/^- Vencidos: (\d+)$/);
    if (overdue) { metrics.push({ label: "Vencidos", value: Number(overdue[1]) }); continue; }
    const label = ({ "Ultimos lancamentos:": "Lançamentos", "Gastos programados:": "Programados", "Boletos importados:": "Boletos" } as Record<string, string>)[line];
    if (label) { group = { label, rows: [], total: 0 }; groups.push(group); continue; }
    if (/^- Nenhum (lancamento cadastrado|gasto programado ativo|boleto importado)\.$/.test(line)) continue;
    if (!group || !line.startsWith("- ")) return undefined;
    const parts = line.slice(2).split(" | ");
    const moneyIndex = group.label === "Lançamentos" ? 2 : 1;
    const money = parts[moneyIndex]?.match(/^R\$\s*([\d.,-]+)$/);
    if (!money) return undefined;
    const amount = Number(money[1].replaceAll(".", "").replace(",", "."));
    if (!Number.isFinite(amount)) return undefined;
    const date = parts.find((part) => /^(vencimento|proximo): /.test(part))?.split(": ")[1];
    group.rows.push({ title: parts[0], amount, type: group.label === "Lançamentos" ? parts[1] : undefined,
      status: group.label === "Lançamentos" ? parts[3] : group.label === "Boletos" ? parts[3] : undefined,
      frequency: group.label === "Programados" ? parts[2] : undefined,
      dueDate: date === "sem data" ? undefined : date, category: parts.find((part) => part.startsWith("categoria: "))?.slice(11) });
    group.total = group.rows.length;
  }
  return metrics.length || groups.length ? { kind: "finance", metrics, groups } : undefined;
}
