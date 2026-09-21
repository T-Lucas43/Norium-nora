// Busca a agenda real (/api/agenda/eventos, local + Google) para o dia civil
// atual. A agenda e autoritativa; o feed da Central so entra como fallback
// explicito quando a busca falha. Sem polling: recarrega na virada do dia,
// quando o feed sincroniza (limitado a 1 chamada/min) e ao voltar o foco
// (limitado a 1 chamada/2 min).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OmnichannelEvent } from "../../types/omnichannel";
import { apiRequest } from "../../core/api/client";
import {
  agendaDayRange,
  getDayKeyInTimeZone,
  resolveAgendaTimeZone,
  selectTodayAgenda,
  zonedDayBoundsMs,
  type TodayAgendaItem,
} from "./todayAgenda";

type AgendaEventsPayload = {
  eventos?: unknown[];
  timezone?: string;
};

const SYNC_REFETCH_MIN_INTERVAL_MS = 60_000;
const FOCUS_REFETCH_MIN_INTERVAL_MS = 120_000;

function feedSignature(events: OmnichannelEvent[]): string {
  return events
    .map((event) => {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      return [
        event.id,
        event.title ?? "",
        event.description ?? "",
        String(metadata.inicio ?? metadata.start ?? ""),
        String(metadata.fim ?? metadata.end ?? ""),
        String(metadata.updated ?? ""),
      ].join("#");
    })
    .join("|");
}

export function useTodayAgenda(feedEvents: OmnichannelEvent[]) {
  const [agendaEvents, setAgendaEvents] = useState<unknown[]>([]);
  const [agendaTimeZone, setAgendaTimeZone] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agendaFailed, setAgendaFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const lastFetchAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const retryAfterFlightRef = useRef(false);
  const delayedSyncTimerRef = useRef<number | null>(null);
  const stateRef = useRef({ feedEvents, agendaTimeZone, nowMs });
  stateRef.current = { feedEvents, agendaTimeZone, nowMs };

  const timeZone = resolveAgendaTimeZone(agendaTimeZone);
  const dayKey = getDayKeyInTimeZone(nowMs, timeZone);

  const fetchAgenda = useCallback(
    async (forceDayKey?: string) => {
      if (delayedSyncTimerRef.current !== null) {
        window.clearTimeout(delayedSyncTimerRef.current);
        delayedSyncTimerRef.current = null;
      }
      // Uma busca em andamento nao e duplicada: a nova tentativa roda ao
      // final da atual, sem perder o reagendamento (virada do dia/retry).
      if (inFlightRef.current) {
        retryAfterFlightRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const startedAt = Date.now();
      lastFetchAtRef.current = startedAt;
      const current = stateRef.current;
      const effectiveTimeZone = resolveAgendaTimeZone(current.agendaTimeZone);
      const effectiveDayKey = forceDayKey ?? getDayKeyInTimeZone(current.nowMs, effectiveTimeZone);
      const range = agendaDayRange(effectiveDayKey, effectiveTimeZone);
      const params = new URLSearchParams({ time_min: range.timeMin, time_max: range.timeMax });
      try {
        const data = await apiRequest<AgendaEventsPayload>(`/api/agenda/eventos?${params.toString()}`, {
          cache: "no-store",
          timeoutMs: 45_000,
        });
        setAgendaEvents(Array.isArray(data.eventos) ? data.eventos : []);
        if (typeof data.timezone === "string" && data.timezone.trim()) {
          setAgendaTimeZone(data.timezone);
        }
        setAgendaFailed(false);
        setError(null);
      } catch {
        // Falha previsivel: limpa a agenda (evita dado obsoleto) e o card
        // usa o fallback explicito do feed.
        setAgendaEvents([]);
        setAgendaFailed(true);
        setError("Não foi possível atualizar a agenda.");
      } finally {
        inFlightRef.current = false;
        setLoading(false);
        if (retryAfterFlightRef.current) {
          retryAfterFlightRef.current = false;
          void fetchAgenda();
        }
      }
    },
    [],
  );

  // Carga inicial e recarga na virada do dia civil do usuario.
  useEffect(() => {
    void fetchAgenda(dayKey);
    const bounds = zonedDayBoundsMs(dayKey, timeZone);
    const msUntilRollover = bounds ? Math.max(bounds.endMs - Date.now() + 1_000, 1_000) : 60_000;
    const timer = window.setTimeout(() => setNowMs(Date.now()), msUntilRollover);
    return () => window.clearTimeout(timer);
  }, [dayKey, timeZone, fetchAgenda]);

  // A sincronizacao da agenda alimenta o feed; quando ele muda (incluindo
  // titulo/horario com o mesmo ID), a agenda pode ter mudado tambem.
  // Limitado para nao gerar chamadas duplicadas; mudanca dentro da janela
  // agenda a busca para o fim do intervalo em vez de descartar.
  const signature = useMemo(() => feedSignature(feedEvents), [feedEvents]);
  const firstSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (firstSignatureRef.current === null) {
      firstSignatureRef.current = signature;
      return;
    }
    if (signature === firstSignatureRef.current) return;
    firstSignatureRef.current = signature;
    const elapsed = Date.now() - lastFetchAtRef.current;
    if (elapsed >= SYNC_REFETCH_MIN_INTERVAL_MS) {
      void fetchAgenda();
      return;
    }
    if (delayedSyncTimerRef.current !== null) return;
    const remaining = Math.max(SYNC_REFETCH_MIN_INTERVAL_MS - elapsed, 1_000);
    delayedSyncTimerRef.current = window.setTimeout(() => {
      delayedSyncTimerRef.current = null;
      void fetchAgenda();
    }, remaining);
  }, [signature, fetchAgenda]);
  useEffect(() => () => {
    if (delayedSyncTimerRef.current !== null) window.clearTimeout(delayedSyncTimerRef.current);
  }, []);

  // Volta de foco/aba e mutacao explicita da Agenda: cobre evento criado na
  // pagina Agenda sem passar pelo feed e navegacao SPA sem evento de foco.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetchAtRef.current >= FOCUS_REFETCH_MIN_INTERVAL_MS) {
        setNowMs(Date.now());
        void fetchAgenda();
      }
    };
    const onAgendaMutated = () => {
      setNowMs(Date.now());
      void fetchAgenda();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("norium:agenda-mutated", onAgendaMutated);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("norium:agenda-mutated", onAgendaMutated);
    };
  }, [fetchAgenda]);

  const selection = useMemo(
    () =>
      selectTodayAgenda({
        feedEvents,
        agendaEvents,
        timeZone,
        nowMs,
        agendaFailed,
      }),
    [feedEvents, agendaEvents, timeZone, nowMs, agendaFailed],
  );

  const dayStartMs = zonedDayBoundsMs(selection.dayKey, selection.timeZone)?.startMs ?? 0;

  const items: TodayAgendaItem[] = selection.items;
  const reload = useCallback(() => {
    setLoading(true);
    void fetchAgenda().finally(() => undefined);
  }, [fetchAgenda]);

  return { items, loading, error, timeZone: selection.timeZone, dayKey: selection.dayKey, dayStartMs, reload };
}
