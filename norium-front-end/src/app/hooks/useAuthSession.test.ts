import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_STORAGE } from "../../core/api/config";
import { useAuthSession } from "./useAuthSession";

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

    act(() => result.current.clearSession());

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE)).toBeNull();
    expect(result.current.authSession).toBeNull();
  });
});
