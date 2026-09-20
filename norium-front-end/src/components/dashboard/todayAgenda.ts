// Seletor puro do card "Agenda de hoje": filtra pelo dia civil do usuario,
// usando o horario real do compromisso (metadata.inicio/fim ou inicio/fim
// da agenda). O timestamp do feed e instante de sincronizacao e nunca e
// usado como data do evento.
import type { OmnichannelEvent } from "../../types/omnichannel";

export const DEFAULT_AGENDA_TIME_ZONE = "America/Sao_Paulo";
export const TODAY_AGENDA_LIMIT = 4;

export type TodayAgendaItem = {
  key: string;
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
};

type RawInterval = {
  inicio?: unknown;
  fim?: unknown;
  start?: unknown;
  end?: unknown;
  allDay?: unknown;
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveAgendaTimeZone(value: unknown): string {
  if (typeof value === "string" && value.trim() && isValidTimeZone(value.trim())) {
    return value.trim();
  }
  return DEFAULT_AGENDA_TIME_ZONE;
}

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayKeyFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dayKeyFormatters.set(timeZone, formatter);
  return formatter;
}

export function getDayKeyInTimeZone(momentMs: number, timeZone: string): string {
  return dayKeyFormatter(timeZone).format(new Date(momentMs));
}

function getTimeZoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const asUtcMs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second")),
  );
  return asUtcMs - utcMs;
}

function zonedMidnightMs(year: number, month: number, day: number, timeZone: string): number | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  let midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0) - getTimeZoneOffsetMs(timeZone, midnightUtc);
  }
  return midnightUtc;
}

export function zonedDayBoundsMs(dayKey: string, timeZone: string): { startMs: number; endMs: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startMs = zonedMidnightMs(year, month, day, timeZone);
  if (startMs === null) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const endMs = zonedMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  if (endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

export function agendaDayRange(dayKey: string, timeZone: string): { timeMin: string; timeMax: string } {
  // Intervalo exato do dia: a API ja devolve por interseccao (Google por
  // natureza; eventos locais apos a correcao de sobreposicao no backend).
  const bounds = zonedDayBoundsMs(dayKey, timeZone);
  const end = bounds?.endMs ?? Date.now();
  const start = bounds?.startMs ?? end;
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

function resolveInterval(raw: RawInterval, timeZone: string): { startMs: number; endMs: number; allDay: boolean } | null {
  const inicio = firstString(raw.inicio, raw.start);
  const fim = firstString(raw.fim, raw.end);
  const allDay = raw.allDay === true;

  if (inicio && isDateOnly(inicio)) {
    const bounds = zonedDayBoundsMs(inicio, timeZone);
    if (!bounds) return null;
    if (fim && isDateOnly(fim)) {
      const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fim);
      if (!endMatch) return null;
      const endMs = zonedMidnightMs(Number(endMatch[1]), Number(endMatch[2]), Number(endMatch[3]), timeZone);
      if (endMs === null) return null;
      return { startMs: bounds.startMs, endMs: Math.max(endMs, bounds.startMs), allDay: true };
    }
    if (fim) {
      const fimMs = Date.parse(fim);
      if (Number.isNaN(fimMs)) return null;
      return { startMs: bounds.startMs, endMs: Math.max(fimMs, bounds.startMs), allDay: true };
    }
    return { startMs: bounds.startMs, endMs: bounds.endMs, allDay: true };
  }

  if (!inicio) return null;
  const startMs = Date.parse(inicio);
  if (Number.isNaN(startMs)) return null;
  let endMs = startMs;
  if (fim) {
    if (isDateOnly(fim)) {
      const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fim);
      if (!endMatch) return null;
      const midnight = zonedMidnightMs(Number(endMatch[1]), Number(endMatch[2]), Number(endMatch[3]), timeZone);
      endMs = midnight === null ? startMs : midnight;
    } else {
      const fimMs = Date.parse(fim);
      if (Number.isNaN(fimMs)) return null;
      endMs = fimMs;
    }
  }
  if (endMs < startMs) endMs = startMs;
  return { startMs, endMs, allDay };
}

function intersectsDay(startMs: number, endMs: number, dayStartMs: number, dayEndMs: number): boolean {
  if (startMs < dayEndMs && endMs > dayStartMs) return true;
  return endMs === startMs && startMs >= dayStartMs && startMs < dayEndMs;
}

function normalizeItem(input: {
  crossKey: string | null;
  title: unknown;
  description: unknown;
  interval: RawInterval;
  timeZone: string;
}): TodayAgendaItem | null {
  if (!input.crossKey) return null;
  const interval = resolveInterval(input.interval, input.timeZone);
  if (!interval) return null;
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Compromisso sem título";
  const description = typeof input.description === "string" ? input.description : "";
  return {
    key: input.crossKey,
    title,
    description,
    startMs: interval.startMs,
    endMs: interval.endMs,
    allDay: interval.allDay,
  };
}

function metadataRecord(event: OmnichannelEvent): Record<string, unknown> {
  return event.metadata && typeof event.metadata === "object" ? event.metadata : {};
}

export function normalizeFeedCalendarEvent(event: OmnichannelEvent, timeZone: string): TodayAgendaItem | null {
  const metadata = metadataRecord(event);
  // Sem inicio real nao ha como posicionar o compromisso no dia: o timestamp
  // do feed pode ser apenas o instante da sincronizacao.
  const crossKey = firstString(metadata.eventId, event.id);
  return normalizeItem({
    crossKey,
    title: event.title,
    description: event.description,
    interval: { inicio: metadata.inicio, fim: metadata.fim, allDay: metadata.allDay },
    timeZone,
  });
}

export function normalizeAgendaEvent(raw: unknown, timeZone: string): TodayAgendaItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return normalizeItem({
    crossKey: firstString(record.id),
    title: firstString(record.titulo, record.summary, record.title),
    description: firstString(record.descricao, record.description),
    interval: {
      inicio: firstString(record.inicio, record.start),
      fim: firstString(record.fim, record.end),
      allDay: record.allDay,
    },
    timeZone,
  });
}

export function selectTodayAgenda(input: {
  feedEvents: OmnichannelEvent[];
  agendaEvents: unknown[];
  timeZone: string;
  nowMs: number;
  agendaFailed?: boolean;
}): { items: TodayAgendaItem[]; dayKey: string; timeZone: string } {
  const timeZone = resolveAgendaTimeZone(input.timeZone);
  const dayKey = getDayKeyInTimeZone(input.nowMs, timeZone);
  const bounds = zonedDayBoundsMs(dayKey, timeZone);
  if (!bounds) return { items: [], dayKey, timeZone };

  // A agenda (/api/agenda/eventos, local + Google) e autoritativa. O feed
  // so entra como fallback explicito quando a busca falhou: caso contrario,
  // uma atividade historica poderia recolocar no card um compromisso que ja
  // foi removido da agenda.
  const byKey = new Map<string, TodayAgendaItem>();
  if (input.agendaFailed !== true) {
    for (const raw of input.agendaEvents) {
      const item = normalizeAgendaEvent(raw, timeZone);
      if (item && !byKey.has(item.key)) byKey.set(item.key, item);
    }
  } else {
    for (const event of input.feedEvents) {
      const item = normalizeFeedCalendarEvent(event, timeZone);
      if (item && !byKey.has(item.key)) byKey.set(item.key, item);
    }
  }

  const items = [...byKey.values()]
    .filter((item) => intersectsDay(item.startMs, item.endMs, bounds.startMs, bounds.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title, "pt-BR"))
    .slice(0, TODAY_AGENDA_LIMIT);
  return { items, dayKey, timeZone };
}

function formatClock(momentMs: number, timeZone: string): string {
  return new Date(momentMs).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: resolveAgendaTimeZone(timeZone),
  });
}

export function formatTodayAgendaTime(item: TodayAgendaItem, timeZone: string, dayStartMs: number, dayKey?: string): string {
  if (item.allDay) return "Dia todo";
  // Evento iniciado antes de hoje e ainda em curso: mostra o termino para
  // nao apresentar o horario de ontem como se fosse o inicio de hoje.
  if (item.startMs < dayStartMs) {
    const resolvedTimeZone = resolveAgendaTimeZone(timeZone);
    const todayKey = dayKey ?? getDayKeyInTimeZone(dayStartMs, resolvedTimeZone);
    const endKey = getDayKeyInTimeZone(item.endMs, resolvedTimeZone);
    if (endKey !== todayKey) {
      const endDate = new Date(item.endMs).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: resolvedTimeZone,
      });
      return `até ${endDate} ${formatClock(item.endMs, resolvedTimeZone)}`;
    }
    return `até ${formatClock(item.endMs, resolvedTimeZone)}`;
  }
  return formatClock(item.startMs, timeZone);
}
