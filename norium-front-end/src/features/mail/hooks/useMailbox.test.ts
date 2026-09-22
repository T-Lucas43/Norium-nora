import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMailbox } from "./useMailbox";
import { mailboxSessionCache } from "../mailboxCache";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ mailApiRequest: apiJson }));

const baseOptions = {
  userId: "u1",
  folder: "inbox",
  filter: "all" as const,
  searchQuery: "",
  connected: true,
  autoRefresh: false,
  onError: () => {},
  onStatusPayload: () => {},
  onRefreshLabels: () => {},
};

const msg = (id: string) => ({ id, threadId: `t${id}`, subject: id, snippet: "", fromName: "", fromEmail: "", labels: [] });

beforeEach(() => {
  apiJson.mockReset();
  mailboxSessionCache.clear();
  apiJson.mockResolvedValue({ messages: [], nextPageToken: null, resultSizeEstimate: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMailbox", () => {
  it("sincroniza todas as paginas ate acabar o token, com dedup", async () => {
    apiJson.mockImplementation(async (path: string) => {
      const url = String(path);
      if (!url.includes("folder=inbox")) return { messages: [], nextPageToken: null, resultSizeEstimate: 0 };
      if (url.includes("page_token=p3")) return { messages: [msg("d")], nextPageToken: null, resultSizeEstimate: 4 };
      if (url.includes("page_token=p2")) return { messages: [msg("b"), msg("c")], nextPageToken: "p3", resultSizeEstimate: 4 };
      return { messages: [msg("a"), msg("b")], nextPageToken: "p2", resultSizeEstimate: 4 };
    });
    const { result } = renderHook(() => useMailbox(baseOptions));

    await waitFor(() => expect(result.current.syncState.done).toBe(true));
    expect(result.current.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.current.nextPageToken).toBeNull();
    expect(result.current.syncState.loaded).toBe(4);
    expect(apiJson.mock.calls.filter(([p]) => String(p).includes("folder=inbox"))).toHaveLength(3);
  });

  it("nao busca nada quando desconectado", async () => {
    renderHook(() => useMailbox({ ...baseOptions, connected: false }));
    await new Promise((r) => setTimeout(r, 30));
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("acumula sem duplicar ao paginar (append)", async () => {
    apiJson.mockResolvedValueOnce({ messages: [msg("a"), msg("b")], nextPageToken: "p2", resultSizeEstimate: 4 });
    const { result } = renderHook(() => useMailbox(baseOptions));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // a mensagem "b" volta repetida na segunda pagina
    apiJson.mockResolvedValueOnce({ messages: [msg("b"), msg("c")], nextPageToken: null, resultSizeEstimate: 4 });
    await act(async () => { await result.current.fetchMessages(true, "p2"); });

    expect(result.current.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("descarta requisicao concorrente identica", async () => {
    let resolve: (v: unknown) => void = () => {};
    apiJson.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useMailbox(baseOptions));

    await act(async () => {
      const a = result.current.fetchMessages();
      const b = result.current.fetchMessages();
      resolve({ messages: [], nextPageToken: null, resultSizeEstimate: 0 });
      await Promise.all([a, b]);
    });

    // a montagem ja disparou uma; a segunda chamada concorrente nao vira request novo
    expect(apiJson).toHaveBeenCalledTimes(1);
  });

  it("reporta erro de carregamento da caixa ativa", async () => {
    const onError = vi.fn();
    apiJson.mockRejectedValue(new Error("quota exceeded"));
    renderHook(() => useMailbox({ ...baseOptions, onError }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("quota exceeded"));
  });

  it("falha parcial preserva o carregado e registra erro so no sync", async () => {
    const onError = vi.fn();
    apiJson.mockImplementation(async (path: string) => {
      const url = String(path);
      if (!url.includes("folder=inbox")) return { messages: [], nextPageToken: null, resultSizeEstimate: 0 };
      if (url.includes("page_token=p2")) throw new Error("quota exceeded");
      return { messages: [msg("a")], nextPageToken: "p2", resultSizeEstimate: 9 };
    });
    const { result } = renderHook(() => useMailbox({ ...baseOptions, onError }));

    await waitFor(() => expect(result.current.syncState.error).toBe("quota exceeded"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["a"]);
    expect(result.current.syncState.loaded).toBe(1);
    expect(result.current.syncState.done).toBe(false);
    expect(onError.mock.calls.flat()).not.toContain("quota exceeded");
  });

  it("tenta uma vez apos falha transitoria antes de desistir", async () => {
    let inboxCalls = 0;
    apiJson.mockImplementation(async (path: string) => {
      const url = String(path);
      if (!url.includes("folder=inbox")) return { messages: [], nextPageToken: null, resultSizeEstimate: 0 };
      inboxCalls += 1;
      if (inboxCalls === 1) throw new Error("500 no servidor");
      return { messages: [msg("a")], nextPageToken: null, resultSizeEstimate: 1 };
    });
    const { result } = renderHook(() => useMailbox(baseOptions));

    await waitFor(() => expect(result.current.syncState.done).toBe(true), { timeout: 4000 });
    expect(result.current.messages.map((m) => m.id)).toEqual(["a"]);
    expect(inboxCalls).toBe(2);
  });

  it("cancela o sync ao trocar de caixa sem misturar mensagens", async () => {
    let resolveInboxP2!: (v: unknown) => void;
    const inboxP2 = new Promise((r) => { resolveInboxP2 = r; });
    apiJson.mockResolvedValueOnce({ messages: [msg("a")], nextPageToken: "p2", resultSizeEstimate: 9 });
    apiJson.mockReturnValueOnce(inboxP2);
    const { result, rerender } = renderHook((props: { folder: string }) => useMailbox({ ...baseOptions, ...props }), {
      initialProps: { folder: "inbox" },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    apiJson.mockResolvedValueOnce({ messages: [msg("sent-1")], nextPageToken: null, resultSizeEstimate: 1 });
    rerender({ folder: "sent" });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["sent-1"]));

    // a pagina atrasada da caixa antiga nao pode sobrescrever a nova
    await act(async () => {
      resolveInboxP2({ messages: [msg("stale")], nextPageToken: null, resultSizeEstimate: 9 });
      await inboxP2;
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["sent-1"]);
  });

  it("repassa o payload da listagem para atualizar o status da conta", async () => {
    const onStatusPayload = vi.fn();
    const payload = { messages: [], nextPageToken: null, resultSizeEstimate: 0, connected: true };
    apiJson.mockResolvedValue(payload);
    renderHook(() => useMailbox({ ...baseOptions, onStatusPayload }));

    await waitFor(() => expect(onStatusPayload).toHaveBeenCalledWith(payload));
  });

  it("avisa a troca de caixa para o dashboard limpar selecoes", async () => {
    const onMailboxChanged = vi.fn();
    renderHook(() => useMailbox({ ...baseOptions, onMailboxChanged }));
    await waitFor(() => expect(onMailboxChanged).toHaveBeenCalled());
  });

  it("reaproveita o cache completo sem refazer I/O ao voltar", async () => {
    apiJson.mockResolvedValue({ messages: [msg("a")], nextPageToken: null, resultSizeEstimate: 1 });
    const { result, rerender } = renderHook((props: { folder: string }) => useMailbox({ ...baseOptions, ...props }), {
      initialProps: { folder: "inbox" },
    });
    await waitFor(() => expect(result.current.syncState.done).toBe(true));

    rerender({ folder: "sent" });
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));

    // ao voltar, a lista aparece na hora vinda do cache, sem request novo
    rerender({ folder: "inbox" });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(apiJson).toHaveBeenCalledTimes(2);
  });

  it("atualizacao manual ressincroniza tudo", async () => {
    apiJson.mockResolvedValue({ messages: [msg("a")], nextPageToken: null, resultSizeEstimate: 1 });
    const { result } = renderHook(() => useMailbox(baseOptions));
    await waitFor(() => expect(result.current.syncState.done).toBe(true));
    expect(apiJson).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.syncMailbox(); });
    expect(apiJson).toHaveBeenCalledTimes(2);
  });

  it("prefetch nao repete pasta ja carregada", async () => {
    const { result } = renderHook(() => useMailbox(baseOptions));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    const antes = apiJson.mock.calls.length;

    await act(async () => { await result.current.prefetchMailbox("sent"); });
    const depois = apiJson.mock.calls.length;
    await act(async () => { await result.current.prefetchMailbox("sent"); });

    expect(apiJson.mock.calls.length).toBe(depois);
    expect(depois).toBeGreaterThan(antes);
  });

  it("prefetch engole erro sem propagar", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useMailbox({ ...baseOptions, onError }));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    onError.mockClear();

    apiJson.mockRejectedValueOnce(new Error("falha silenciosa"));
    await act(async () => { await expect(result.current.prefetchMailbox("spam")).resolves.toBeUndefined(); });

    expect(onError).not.toHaveBeenCalled();
  });

  it("recarrega a primeira pagina ao receber o evento emails:changed", async () => {
    const onRefreshLabels = vi.fn();
    renderHook(() => useMailbox({ ...baseOptions, onRefreshLabels }));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    const antes = apiJson.mock.calls.length;

    await act(async () => { window.dispatchEvent(new Event("emails:changed")); });

    await waitFor(() => expect(apiJson.mock.calls.length).toBeGreaterThan(antes));
    expect(onRefreshLabels).toHaveBeenCalled();
  });
});
