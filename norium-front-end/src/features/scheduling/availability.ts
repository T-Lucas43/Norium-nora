import type { AvailabilityPeriod } from "./api";

export type DaySlot = { start: string; end: string };
export type DayPeriod = { enabled: boolean; slots: DaySlot[] };
export type LunchBreak = { enabled: boolean; start: string; end: string };

export const WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_SLOT: DaySlot = { start: "08:00", end: "18:00" };

export function defaultPeriods(): Record<string, DayPeriod> {
  return Object.fromEntries(
    WEEKDAYS.map((_, index) => [String(index), { enabled: index < 5, slots: [{ ...DEFAULT_SLOT }] }]),
  );
}

function cleanSlot(raw: unknown): DaySlot | null {
  if (!raw || typeof raw !== "object") return null;
  const { start, end } = raw as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!TIME.test(start) || !TIME.test(end) || start >= end) return null;
  return { start, end };
}

/** Converte o mapa salvo no backend para o estado do editor, sem fabricar dados. */
export function periodsFromWeekly(weekly: Record<string, AvailabilityPeriod[]> | undefined): Record<string, DayPeriod> {
  const source = weekly && typeof weekly === "object" ? weekly : {};
  return Object.fromEntries(
    WEEKDAYS.map((_, index) => {
      const key = String(index);
      const stored = Array.isArray(source[key]) ? source[key].map(cleanSlot).filter((slot): slot is DaySlot => Boolean(slot)) : [];
      if (!stored.length) return [key, { enabled: false, slots: [{ ...DEFAULT_SLOT }] }];
      return [key, { enabled: true, slots: stored.slice(0, 8) }];
    }),
  );
}

/** Subtrai o intervalo de almoço de cada período (operação idempotente ao recarregar). */
export function subtractLunch(slots: DaySlot[], lunch: LunchBreak): DaySlot[] {
  if (!lunch.enabled || !TIME.test(lunch.start) || !TIME.test(lunch.end) || lunch.start >= lunch.end) return slots;
  const out: DaySlot[] = [];
  for (const slot of slots) {
    if (slot.end <= lunch.start || slot.start >= lunch.end) { out.push(slot); continue; }
    if (slot.start < lunch.start) out.push({ start: slot.start, end: lunch.start });
    if (slot.end > lunch.end) out.push({ start: lunch.end, end: slot.end });
  }
  return out;
}

/** Converte o estado do editor para o mapa semanal do backend (7 dias, sempre). */
export function weeklyFromPeriods(periods: Record<string, DayPeriod>, lunch: LunchBreak): Record<string, DaySlot[]> {
  return Object.fromEntries(
    WEEKDAYS.map((_, index) => {
      const key = String(index);
      const day = periods[key];
      if (!day?.enabled) return [key, []];
      const valid = day.slots.map(cleanSlot).filter((slot): slot is DaySlot => Boolean(slot)).slice(0, 8);
      return [key, subtractLunch(valid, lunch)];
    }),
  );
}
