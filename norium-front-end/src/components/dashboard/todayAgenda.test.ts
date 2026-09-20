// Riscos do card "Agenda de hoje": hoje/amanha, fuso, dia inteiro,
// virada de meia-noite, fonte autoritativa e datas invalidas.
// (Codex, rodada 1: itens 1 e 2.)
import { describe, expect, it } from "vitest";
import type { OmnichannelEvent } from "../../types/omnichannel";
import {
  formatTodayAgendaTime,
  getDayKeyInTimeZone,
  resolveAgendaTimeZone,
  selectTodayAgenda,
  zonedDayBoundsMs,
} from "./todayAgenda";

const TIME_ZONE = "America/Sao_Paulo";
// 2026-09-19T15:00:00Z = 12:00 em Sao Paulo.
const NOW_MS = Date.parse("2026-09-19T15:00:00Z");
const DAY_START_MS = zonedDayBoundsMs("2026-09-19", TIME_ZONE)?.startMs ?? 0;

function feedEvent(partial: Partial<OmnichannelEvent> & { id: string }): OmnichannelEvent {
  return {
    source: "calendar",
    title: "Evento do feed",
    description: "",
    timestamp: new Date(NOW_MS).toISOString(),
    metadata: {},
    ...partial,
  };
}

describe("selectTodayAgenda", () => {
  it("usa metadata.inicio e ignora o timestamp de sincronizacao", () => {
    const syncedTomorrow = feedEvent({
      id: "feed-sync-hoje",
      title: "Sincronizado hoje, ocorre amanha",
      timestamp: new Date(NOW_MS).toISOString(),
      metadata: { eventId: "ev-amanha", inicio: "2026-09-20T10:00:00-03:00", fim: "2026-09-20T11:00:00-03:00" },
    });
    const syncedDaysAgo = feedEvent({
      id: "feed-sync-antigo",
      title: "Sincronizado dias atras, ocorre hoje",
      timestamp: "2026-09-16T09:00:00Z",
      metadata: { eventId: "ev-hoje", inicio: "2026-09-19T14:00:00-03:00", fim: "2026-09-19T15:00:00-03:00" },
    });
    const withoutStart = feedEvent({
      id: "feed-sem-inicio",
      title: "Sem inicio real",
      timestamp: new Date(NOW_MS).toISOString(),
      metadata: {},
    });

    const { items } = selectTodayAgenda({
      feedEvents: [syncedTomorrow, syncedDaysAgo, withoutStart],
      agendaEvents: [],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
      agendaFailed: true,
    });

    expect(items.map((item) => item.title)).toEqual(["Sincronizado dias atras, ocorre hoje"]);
  });

  it("exclui amanha e eventos ja encerrados ontem", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [
        { id: "amanha", titulo: "Amanha", inicio: "2026-09-20T09:00:00-03:00", fim: "2026-09-20T10:00:00-03:00" },
        { id: "ontem", titulo: "Ontem", inicio: "2026-09-18T09:00:00-03:00", fim: "2026-09-18T10:00:00-03:00" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items).toEqual([]);
  });

  it("inclui evento de dia inteiro de hoje", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [{ id: "dia-todo", titulo: "Feriado", inicio: "2026-09-19", allDay: true }],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items).toHaveLength(1);
    expect(items[0].allDay).toBe(true);
    expect(formatTodayAgendaTime(items[0], TIME_ZONE, DAY_START_MS)).toBe("Dia todo");
  });

  it("inclui evento que atravessa a meia-noite nos dois dias", () => {
    const overnight = {
      id: "virada",
      titulo: "Plantao",
      inicio: "2026-09-18T22:00:00-03:00",
      fim: "2026-09-19T02:00:00-03:00",
    };

    const today = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [overnight],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });
    // 2026-09-19T01:00:00Z = 18/09 22:00 em Sao Paulo.
    const yesterday = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [overnight],
      timeZone: TIME_ZONE,
      nowMs: Date.parse("2026-09-19T01:00:00Z"),
    });

    expect(today.items.map((item) => item.title)).toEqual(["Plantao"]);
    expect(yesterday.items.map((item) => item.title)).toEqual(["Plantao"]);
  });

  it("rotula com o termino o evento iniciado ontem e ainda em curso hoje", () => {
    // 02:30Z-03:30Z = 23:30 do dia 18 ate 00:30 do dia 19 em Sao Paulo.
    const { items } = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [
        { id: "fuso", titulo: "Madrugada SP", inicio: "2026-09-19T02:30:00Z", fim: "2026-09-19T03:30:00Z" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items.map((item) => item.title)).toEqual(["Madrugada SP"]);
    // Mostra o termino de hoje, nunca 23:30 como se fosse inicio de hoje.
    expect(formatTodayAgendaTime(items[0], TIME_ZONE, DAY_START_MS)).toBe("até 00:30");
  });

  it("inclui a data quando o termino nao e hoje (varios dias)", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [],
      agendaEvents: [
        { id: "longo", titulo: "Congresso", inicio: "2026-09-18T10:00:00-03:00", fim: "2026-09-20T11:00:00-03:00" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items).toHaveLength(1);
    expect(formatTodayAgendaTime(items[0], TIME_ZONE, DAY_START_MS, "2026-09-19")).toBe("até 20/09 11:00");
  });

  it("ignora o feed quando a agenda respondeu (fonte autoritativa)", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [
        feedEvent({
          id: "calendar_google_user_g1",
          title: "Removido da agenda",
          metadata: { eventId: "g1", inicio: "2026-09-19T10:00:00-03:00", fim: "2026-09-19T11:00:00-03:00" },
        }),
        feedEvent({
          id: "feed-extra",
          title: "So existe no feed",
          metadata: { eventId: "extra", inicio: "2026-09-19T12:00:00-03:00", fim: "2026-09-19T13:00:00-03:00" },
        }),
      ],
      agendaEvents: [
        { id: "g2", titulo: "Na agenda", inicio: "2026-09-19T09:00:00-03:00", fim: "2026-09-19T09:30:00-03:00" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    // Atividade historica do feed nao recoloca compromisso removido no card.
    expect(items.map((item) => item.title)).toEqual(["Na agenda"]);
  });

  it("usa o feed somente como fallback quando a busca falhou", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [
        feedEvent({
          id: "feed-fallback",
          title: "Do feed",
          metadata: { eventId: "f1", inicio: "2026-09-19T12:00:00-03:00", fim: "2026-09-19T13:00:00-03:00" },
        }),
      ],
      agendaEvents: [
        { id: "obsoleto", titulo: "Dado obsoleto", inicio: "2026-09-19T09:00:00-03:00", fim: "2026-09-19T09:30:00-03:00" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
      agendaFailed: true,
    });

    expect(items.map((item) => item.title)).toEqual(["Do feed"]);
  });

  it("ordena pelo inicio real e limita a quatro depois de filtrar", () => {
    const agendaEvents = [16, 9, 12, 10, 8].map((hour) => ({
      id: `ev-${hour}`,
      titulo: `Evento ${hour}h`,
      inicio: `2026-09-19T${String(hour).padStart(2, "0")}:00:00-03:00`,
      fim: `2026-09-19T${String(hour).padStart(2, "0")}:30:00-03:00`,
    }));

    const { items } = selectTodayAgenda({
      feedEvents: [
        feedEvent({
          id: "feed-amanha",
          title: "Amanha cedo",
          metadata: { eventId: "ev-amanha", inicio: "2026-09-20T07:00:00-03:00", fim: "2026-09-20T07:30:00-03:00" },
        }),
      ],
      agendaEvents,
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items.map((item) => item.title)).toEqual(["Evento 8h", "Evento 9h", "Evento 10h", "Evento 12h"]);
  });

  it("descarta datas invalidas sem quebrar a selecao", () => {
    const { items } = selectTodayAgenda({
      feedEvents: [
        feedEvent({
          id: "feed-invalido",
          title: "Inicio invalido",
          metadata: { eventId: "x1", inicio: "nao-e-data", fim: "tambem-nao" },
        }),
      ],
      agendaEvents: [
        { id: "invalido", titulo: "Agenda invalida", inicio: "32/13/2026", fim: "" },
        { id: "valido", titulo: "Valido", inicio: "2026-09-19T18:00:00-03:00", fim: "2026-09-19T19:00:00-03:00" },
      ],
      timeZone: TIME_ZONE,
      nowMs: NOW_MS,
    });

    expect(items.map((item) => item.title)).toEqual(["Valido"]);
  });
});

describe("fuso da agenda", () => {
  it("usa America/Sao_Paulo quando o fuso informado e invalido", () => {
    expect(resolveAgendaTimeZone("Marte/Olimpo")).toBe("America/Sao_Paulo");
    expect(resolveAgendaTimeZone(undefined)).toBe("America/Sao_Paulo");
    expect(resolveAgendaTimeZone(TIME_ZONE)).toBe(TIME_ZONE);
  });

  it("calcula o dia civil no fuso da agenda", () => {
    // 02:00Z ainda e dia 18 em Sao Paulo.
    expect(getDayKeyInTimeZone(Date.parse("2026-09-19T02:00:00Z"), TIME_ZONE)).toBe("2026-09-18");
    expect(getDayKeyInTimeZone(NOW_MS, TIME_ZONE)).toBe("2026-09-19");
  });
});
