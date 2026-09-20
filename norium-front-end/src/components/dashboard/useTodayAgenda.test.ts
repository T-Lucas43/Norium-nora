// Hook do card "Agenda de hoje": busca autoritativa, fallback em falha,
// virada do dia e atualizacao material do feed. (Codex, rodadas 1 e 2.)
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RenderHookResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmnichannelEvent } from "../../types/omnichannel";
import { getDayKeyInTimeZone } from "./todayAgenda";
import { useTodayAgenda } from "./useTodayAgenda";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../../core/api/client", () => ({ apiRequest: apiJson }));

const TIME_ZONE = "America/Sao_Paulo";

function at(dayKey: string, hour: string): string {
  return `${dayKey}T${hour}:00-03:00`;
}

function todayAt(hour: string): string {
  return at(getDayKeyInTimeZone(Date.now(), TIME_ZONE), hour);
}

function feedEvent(id: string, title: string, inicio: string, fim: string): OmnichannelEvent {
  return {
    id,
    source: "calendar",
    title,
    description: "",
    timestamp: new Date().toISOString(),
    metadata: { eventId: `feed-${id}`, inicio, fim },
  };
}

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockResolvedValue({ eventos: [], timezone: TIME_ZONE });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useTodayAgenda", () => {
  it("usa a agenda como fonte autoritativa e ignora o feed no sucesso", async () => {
    apiJson.mockResolvedValue({
      eventos: [{ id: "a1", titulo: "Agenda 10h", inicio: todayAt("10:00"), fim: todayAt("10:30") }],
      timezone: TIME_ZONE,
    });
    const feed = [
      feedEvent("dup", "Removido da agenda", todayAt("10:00"), todayAt("10:30")),
      feedEvent("extra", "So existe no feed", todayAt("11:00"), todayAt("11:30")),
    ];
    feed[0].metadata = { eventId: "a1", inicio: todayAt("10:00"), fim: todayAt("10:30") };

    const { result, unmount } = renderHook(() => useTodayAgenda(feed));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiJson).toHaveBeenCalledTimes(1);
    expect(String(apiJson.mock.calls[0][0])).toContain("/api/agenda/eventos?time_min=");
    expect(result.current.error).toBeNull();
    expect(result.current.items.map((item) => item.title)).toEqual(["Agenda 10h"]);
    unmount();
  });

  it("em falha usa o feed como fallback e recupera na nova tentativa", async () => {
    apiJson.mockRejectedValueOnce(new Error("backend fora do ar"));
    const feed = [feedEvent("f1", "Do feed", todayAt("11:00"), todayAt("11:30"))];

    const { result, unmount } = renderHook(() => useTodayAgenda(feed));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Não foi possível atualizar a agenda.");
    expect(result.current.items.map((item) => item.title)).toEqual(["Do feed"]);

    apiJson.mockResolvedValueOnce({
      eventos: [{ id: "a9", titulo: "Agenda recuperada", inicio: todayAt("09:00"), fim: todayAt("09:30") }],
      timezone: TIME_ZONE,
    });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.error).toBeNull());

    expect(apiJson).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((item) => item.title)).toEqual(["Agenda recuperada"]);
    unmount();
  });

  it("refaz a busca da virada do dia mesmo com outra busca em andamento", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, "now");
    let hook: RenderHookResult<ReturnType<typeof useTodayAgenda>, unknown> | null = null;
    try {
      const dayAMs = Date.now();
      const dayBMs = dayAMs + 24 * 60 * 60 * 1000;
      const dayA = getDayKeyInTimeZone(dayAMs, TIME_ZONE);
      const dayB = getDayKeyInTimeZone(dayBMs, TIME_ZONE);
      expect(dayB).not.toBe(dayA);

      let resolveA!: (value: unknown) => void;
      let resolveB!: (value: unknown) => void;
      nowSpy.mockReturnValue(dayAMs);
      apiJson.mockReturnValueOnce(new Promise((resolve) => {
        resolveA = resolve;
      }));

      hook = renderHook(() => useTodayAgenda([]));
      expect(apiJson).toHaveBeenCalledTimes(1);

      // Vira o dia com a primeira busca ainda em voo.
      nowSpy.mockReturnValue(dayBMs);
      apiJson.mockReturnValueOnce(new Promise((resolve) => {
        resolveB = resolve;
      }));
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });
      expect(apiJson).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveA({ eventos: [{ id: "a", titulo: "Evento A", inicio: at(dayA, "10:00"), fim: at(dayA, "10:30") }], timezone: TIME_ZONE });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiJson).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveB({ eventos: [{ id: "b", titulo: "Evento B", inicio: at(dayB, "10:00"), fim: at(dayB, "10:30") }], timezone: TIME_ZONE });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.dayKey).toBe(dayB);
      expect(hook.result.current.items.map((item) => item.title)).toEqual(["Evento B"]);
    } finally {
      hook?.unmount();
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("recarrega quando titulo ou horario mudam com o mesmo ID", async () => {
    apiJson.mockResolvedValue({
      eventos: [{ id: "a1", titulo: "Agenda 10h", inicio: todayAt("10:00"), fim: todayAt("10:30") }],
      timezone: TIME_ZONE,
    });
    const inicio = todayAt("10:00");
    const fim = todayAt("10:30");
    const { result, rerender, unmount } = renderHook(({ feed }) => useTodayAgenda(feed), {
      initialProps: { feed: [feedEvent("w1", "Titulo antigo", inicio, fim)] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiJson).toHaveBeenCalledTimes(1);

    apiJson.mockResolvedValue({
      eventos: [{ id: "a1", titulo: "Agenda 10h adiada", inicio: todayAt("11:00"), fim: todayAt("11:30") }],
      timezone: TIME_ZONE,
    });
    vi.useFakeTimers();
    rerender({ feed: [feedEvent("w1", "Titulo novo", todayAt("11:00"), todayAt("11:30"))] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(apiJson).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await waitFor(() => expect(result.current.items.map((item) => item.title)).toEqual(["Agenda 10h adiada"]));
    unmount();
  });

  it("agenda a busca adiada quando a mudanca ocorre dentro da janela", async () => {
    vi.useFakeTimers();
    let hook: RenderHookResult<ReturnType<typeof useTodayAgenda>, { feed: OmnichannelEvent[] }> | null = null;
    try {
      apiJson.mockResolvedValue({ eventos: [], timezone: TIME_ZONE });
      const inicio = todayAt("10:00");
      const fim = todayAt("10:30");
      hook = renderHook(({ feed }) => useTodayAgenda(feed), {
        initialProps: { feed: [feedEvent("w1", "Titulo antigo", inicio, fim)] as OmnichannelEvent[] },
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiJson).toHaveBeenCalledTimes(1);

      hook.rerender({ feed: [feedEvent("w1", "Titulo novo", inicio, fim)] as OmnichannelEvent[] });
      await act(async () => {
        await Promise.resolve();
      });
      // Dentro de 60 s nao busca de imediato: agenda para o fim da janela.
      expect(apiJson).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiJson).toHaveBeenCalledTimes(2);
    } finally {
      hook?.unmount();
      vi.useRealTimers();
    }
  });

  it("cancela a busca adiada depois de uma mutacao explicita", async () => {
    vi.useFakeTimers();
    apiJson.mockResolvedValue({ eventos: [], timezone: TIME_ZONE });
    const inicio = todayAt("10:00");
    const fim = todayAt("10:30");
    const hook = renderHook(({ feed }) => useTodayAgenda(feed), {
      initialProps: { feed: [feedEvent("w1", "Antigo", inicio, fim)] },
    });
    try {
      await act(async () => { await Promise.resolve(); });
      expect(apiJson).toHaveBeenCalledTimes(1);

      hook.rerender({ feed: [feedEvent("w1", "Novo", inicio, fim)] });
      await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
      expect(apiJson).toHaveBeenCalledTimes(1);

      await act(async () => {
        window.dispatchEvent(new CustomEvent("norium:agenda-mutated"));
        await Promise.resolve();
      });
      expect(apiJson).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
      expect(apiJson).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

  it("recarrega ao receber mutacao explicita da Agenda", async () => {
    apiJson.mockResolvedValue({ eventos: [], timezone: TIME_ZONE });
    const { result, unmount } = renderHook(() => useTodayAgenda([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent("norium:agenda-mutated"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
    unmount();
  });

  it("indica carregamento ate a primeira resposta", async () => {
    let resolveRequest!: (value: unknown) => void;
    apiJson.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    const { result, unmount } = renderHook(() => useTodayAgenda([]));
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveRequest({ eventos: [], timezone: TIME_ZONE });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
  });
});
