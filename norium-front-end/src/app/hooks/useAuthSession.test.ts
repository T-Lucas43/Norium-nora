import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_STORAGE } from "../../core/api/config";
import { useAuthSession } from "./useAuthSession";
import { mailboxSessionCache } from "../../features/mail/mailboxCache";

const authJson = vi.hoisted(() => vi.fn());
vi.mock("../../utils/authApi", () => ({ authJson }));

beforeEach(() => {
  authJson.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe("useAuthSession", () => {
  it("restaura a sessao persistente depois de reabrir o navegador", async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE, "token-persistente");
    authJson.mockResolvedValue({
      user: { id: "u1", nome: "Operador", email: "operador@norium.test" },
      availableModes: ["app"],
    });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => expect(result.current.authLoading).toBe(false));
    expect(authJson).toHaveBeenCalledWith("/api/auth/me", "token-persistente");
    expect(result.current.authSession?.token).toBe("token-persistente");
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBe("token-persistente");
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
  });

  it("migra uma sessao temporaria antiga para o armazenamento persistente", async () => {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, "token-legado");
    authJson.mockResolvedValue({
      user: { id: "u2", nome: "Operador", email: "legado@norium.test" },
      availableModes: ["app"],
    });

    const { result } = renderHook(() => useAuthSession());
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBe("token-legado");
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
  });

  it("remove o token dos dois armazenamentos ao sair", async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE, "token");
    authJson.mockResolvedValue({
      user: { id: "u3", nome: "Operador", email: "saida@norium.test" },
      availableModes: ["app"],
    });
    const { result } = renderHook(() => useAuthSession());
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    mailboxSessionCache.set("u3::private", { messages: [], nextPageToken: null, resultSize: 0, cachedAt: 0 });
    sessionStorage.setItem("norium-operations-overview:u3:primary", "private-data");
    localStorage.setItem("norium-workspace-id", "workspace-a");

    act(() => result.current.clearSession());

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    expect(result.current.authSession).toBeNull();
    expect(mailboxSessionCache.size).toBe(0);
    expect(sessionStorage.getItem("norium-operations-overview:u3:primary")).toBeNull();
    expect(localStorage.getItem("norium-workspace-id")).toBeNull();
  });

  it("does not restore an older session after logout during startup", async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE, "old-token");
    let finish!: (value: unknown) => void;
    authJson.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useAuthSession());
    act(() => result.current.clearSession());
    await act(async () => finish({ user: { id: "old-user" }, availableModes: ["app"] }));
    expect(result.current.authSession).toBeNull();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
  });
});
