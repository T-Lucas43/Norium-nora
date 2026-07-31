import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageDetail } from "./useMessageDetail";
import type { GmailMessage, MailboxSnapshot } from "../types";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ mailApiRequest: apiJson }));

const msg = (id: string, extra: Partial<GmailMessage> = {}) =>
  ({ id, threadId: `t${id}`, subject: id, snippet: "", fromName: "", fromEmail: "", labels: [], ...extra }) as GmailMessage;

function setup(overrides: Partial<Parameters<typeof useMessageDetail>[0]> = {}) {
  const state = { messages: [msg("a"), msg("b")] as GmailMessage[] };
  const cache = new Map<string, MailboxSnapshot>();
  const options = {
    userId: "u1",
    messages: state.messages,
    setMessages: (updater: (prev: GmailMessage[]) => GmailMessage[]) => { state.messages = updater(state.messages); },
    currentMailboxKey: "u1::inbox::all::",
    cacheRef: { current: cache },
    onError: vi.fn(),
    onRefreshMessages: vi.fn(),
    onRefreshLabels: vi.fn(),
    onActionStart: vi.fn(),
    ...overrides,
  };
  const hook = renderHook(() => useMessageDetail(options as Parameters<typeof useMessageDetail>[0]));
  return { hook, options, state, cache };
}

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockResolvedValue({ message: msg("a") });
});

describe("openMessage", () => {
  it("mostra a mensagem da lista antes da resposta e troca pela completa", async () => {
    apiJson.mockResolvedValue({ message: msg("a", { subject: "completo" }) });
    const { hook } = setup();

    await act(async () => { await hook.result.current.openMessage(msg("a")); });

    expect(hook.result.current.selectedMessage?.subject).toBe("completo");
    expect(hook.result.current.detailLoading).toBe(false);
  });

  it("marca como lida na lista, no cache e no servidor quando estava nao lida", async () => {
    const { hook, state, cache } = setup();
    cache.set("u1::inbox::all::", { messages: [msg("a", { unread: true })], nextPageToken: null, resultSize: 1, cachedAt: 0 });

    await act(async () => { await hook.result.current.openMessage(msg("a", { unread: true })); });

    expect(state.messages.find((m) => m.id === "a")?.unread).toBe(false);
    expect(cache.get("u1::inbox::all::")?.messages[0].unread).toBe(false);
    expect(apiJson).toHaveBeenCalledWith(
      "/api/emails/gmail/messages/a",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("nao marca como lida quando a mensagem ja estava lida", async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.openMessage(msg("a", { unread: false })); });
    expect(apiJson).toHaveBeenCalledTimes(1); // so o GET do detalhe
  });

  it("reporta erro ao falhar a abertura", async () => {
    apiJson.mockRejectedValue(new Error("403"));
    const { hook, options } = setup();

    await act(async () => { await hook.result.current.openMessage(msg("a")); });

    expect(options.onError).toHaveBeenCalledWith("403");
    expect(hook.result.current.detailLoading).toBe(false);
  });
});

describe("openMessageById", () => {
  it("reaproveita a mensagem ja carregada na lista", async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.openMessageById("b"); });
    expect(hook.result.current.selectedMessage?.id).toBe("a"); // veio do GET de detalhe
    expect(apiJson).toHaveBeenCalledWith("/api/emails/gmail/messages/b?user_id=u1");
  });

  it("busca no servidor quando a mensagem nao esta na lista", async () => {
    apiJson.mockResolvedValue({ message: msg("z") });
    const { hook } = setup();

    await act(async () => { await hook.result.current.openMessageById("z"); });

    expect(hook.result.current.selectedMessage?.id).toBe("z");
  });
});

describe("runMessageAction", () => {
  it("remove da lista e fecha o detalhe em acoes de arquivar/lixo/spam", async () => {
    apiJson.mockResolvedValue({});
    const { hook, state } = setup();
    await act(async () => { await hook.result.current.runMessageAction("a", "archive"); });

    expect(state.messages.map((m) => m.id)).toEqual(["b"]);
  });

  it("alterna estrela sem recarregar a lista", async () => {
    apiJson.mockResolvedValue({});
    const { hook, state, options } = setup();

    await act(async () => { await hook.result.current.runMessageAction("a", "star"); });

    expect(state.messages.find((m) => m.id === "a")?.starred).toBe(true);
    expect(options.onRefreshMessages).not.toHaveBeenCalled();
  });

  it("alterna importante", async () => {
    apiJson.mockResolvedValue({});
    const { hook, state } = setup();
    await act(async () => { await hook.result.current.runMessageAction("a", "important"); });
    expect(state.messages.find((m) => m.id === "a")?.important).toBe(true);
  });

  it("recarrega a lista em acoes que nao sao tratadas localmente", async () => {
    apiJson.mockResolvedValue({});
    const { hook, options } = setup();
    await act(async () => { await hook.result.current.runMessageAction("a", "unread"); });
    expect(options.onRefreshMessages).toHaveBeenCalled();
  });

  it("reporta erro sem alterar a lista", async () => {
    apiJson.mockRejectedValue(new Error("sem permissao"));
    const { hook, state, options } = setup();

    await act(async () => { await hook.result.current.runMessageAction("a", "archive"); });

    expect(options.onError).toHaveBeenCalledWith("sem permissao");
    expect(state.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("runBulkAction", () => {
  it("nao faz nada sem selecao", async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.runBulkAction("archive"); });
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("aplica a acao a cada selecionado e limpa a selecao", async () => {
    apiJson.mockResolvedValue({});
    const { hook, state } = setup();
    act(() => { hook.result.current.setSelectedIds(new Set(["a", "b"])); });

    await act(async () => { await hook.result.current.runBulkAction("archive"); });

    await waitFor(() => expect(hook.result.current.selectedIds.size).toBe(0));
    expect(state.messages).toHaveLength(0);
  });
});
