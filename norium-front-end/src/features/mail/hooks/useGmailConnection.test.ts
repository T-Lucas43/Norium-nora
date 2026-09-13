import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeGoogleOAuth, useGmailConnection } from "./useGmailConnection";
import { mailboxCacheKey, mailboxSessionCache } from "../mailboxCache";
import type { MailboxSnapshot } from "../types";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ mailApiRequest: apiJson }));

const snapshot: MailboxSnapshot = { messages: [], nextPageToken: null, resultSize: 0, cachedAt: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  apiJson.mockReset();
  mailboxSessionCache.clear();
});

describe("useGmailConnection", () => {
  it("carrega o status da conta", async () => {
    apiJson.mockResolvedValue({ connected: true, email: "a@x.com" });
    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError: vi.fn() }));

    await act(async () => { await result.current.fetchStatus(); });

    expect(apiJson).toHaveBeenCalledWith("/api/emails/gmail/status?user_id=u1");
    expect(result.current.status).toEqual({ connected: true, email: "a@x.com" });
  });

  it("carrega rotulos e mescla no status existente", async () => {
    apiJson.mockResolvedValue({ connected: true, labels: [{ id: "INBOX", name: "INBOX" }] });
    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError: vi.fn() }));

    await act(async () => { await result.current.fetchLabels(); });

    expect(result.current.labels).toHaveLength(1);
    expect(result.current.status?.connected).toBe(true);
  });

  it("usa lista vazia quando a resposta nao traz rotulos", async () => {
    apiJson.mockResolvedValue({ connected: true });
    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError: vi.fn() }));

    await act(async () => { await result.current.fetchLabels(); });

    expect(result.current.labels).toEqual([]);
  });

  it("reserva o popup durante o clique e o direciona quando a API responde", async () => {
    const popup = {
      closed: false,
      location: { replace: vi.fn() },
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    let resolveAuth!: (value: { auth_url: string }) => void;
    apiJson.mockReturnValue(new Promise((resolve) => { resolveAuth = resolve; }));
    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError: vi.fn() }));

    let connection = Promise.resolve();
    act(() => { connection = result.current.connect(); });

    expect(open).toHaveBeenCalledWith("about:blank", "gmail_oauth", expect.any(String));
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(result.current.connecting).toBe(true);

    act(() => { void result.current.connect(); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(apiJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAuth({ auth_url: "https://accounts.google.com/x" });
      await connection;
    });

    expect(popup.location.replace).toHaveBeenCalledWith("https://accounts.google.com/x");
    expect(popup.focus).toHaveBeenCalled();
    expect(result.current.connecting).toBe(false);
  });

  it("navega na aba atual quando o navegador bloqueia o popup", () => {
    const navigate = vi.fn();

    expect(routeGoogleOAuth(null, "https://accounts.google.com/x", navigate)).toBe("current-window");
    expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/x");
  });

  it("rejeita destinos OAuth fora do Google", () => {
    expect(() => routeGoogleOAuth(null, "https://example.com/phishing", vi.fn())).toThrow(
      "destino OAuth nao autorizado",
    );
  });

  it("reporta erro quando o OAuth falha, sem lancar excecao", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onError = vi.fn();
    apiJson.mockRejectedValue(new Error("sem rede"));
    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError }));

    await act(async () => { await result.current.connect(); });

    expect(onError).toHaveBeenLastCalledWith("sem rede");
    expect(popup.close).toHaveBeenCalled();
  });

  it("ao desconectar limpa rotulos, cache do usuario e avisa o dashboard", async () => {
    const onDisconnected = vi.fn();
    mailboxSessionCache.set(mailboxCacheKey("u1", "inbox", "all", ""), snapshot);
    mailboxSessionCache.set(mailboxCacheKey("u2", "inbox", "all", ""), snapshot);
    apiJson.mockResolvedValue({ connected: false });

    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError: vi.fn(), onDisconnected }));
    await act(async () => { await result.current.fetchLabels(); });
    await act(async () => { await result.current.disconnect(); });

    expect(result.current.labels).toEqual([]);
    expect(onDisconnected).toHaveBeenCalled();
    // o cache do outro usuario permanece intacto
    expect(mailboxSessionCache.has(mailboxCacheKey("u2", "inbox", "all", ""))).toBe(true);
    expect(mailboxSessionCache.has(mailboxCacheKey("u1", "inbox", "all", ""))).toBe(false);
    await waitFor(() => expect(result.current.status?.connected).toBe(false));
  });

  it("nao limpa nada quando a desconexao falha", async () => {
    const onDisconnected = vi.fn();
    mailboxSessionCache.set(mailboxCacheKey("u1", "inbox", "all", ""), snapshot);
    apiJson.mockRejectedValue(new Error("falhou"));
    const onError = vi.fn();

    const { result } = renderHook(() => useGmailConnection({ userId: "u1", onError, onDisconnected }));
    await act(async () => { await result.current.disconnect(); });

    expect(onError).toHaveBeenLastCalledWith("falhou");
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(mailboxSessionCache.has(mailboxCacheKey("u1", "inbox", "all", ""))).toBe(true);
  });
});
