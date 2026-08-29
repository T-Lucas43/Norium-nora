import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiBlobRequest, apiErrorMessage, apiRequest } from "./client";
import { apiBaseUrl, AUTH_TOKEN_STORAGE } from "./config";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSuccessfulBlobFetch(blob = new Blob(["media"], { type: "image/png" })) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    blob: vi.fn().mockResolvedValue(blob),
  } as unknown as Response);
}

describe("apiErrorMessage", () => {
  it("preserva a explicacao de validacao retornada pelo FastAPI", () => {
    expect(apiErrorMessage({
      detail: [{ loc: ["body", "password"], msg: "Value error, A senha deve ter pelo menos 10 caracteres." }],
    }, "Falha na API do Norium.")).toBe("A senha deve ter pelo menos 10 caracteres.");
  });

  it("mantem a mensagem generica somente quando a API nao forneceu detalhe", () => {
    expect(apiErrorMessage({ detail: [] }, "Falha na API do Norium.")).toBe("Falha na API do Norium.");
  });
});

describe("apiBlobRequest", () => {
  it("autentica uma URL relativa protegida no backend configurado", async () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE, "token-relativo");
    const fetchMock = mockSuccessfulBlobFetch();

    await apiBlobRequest("/api/chat/midia/message-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${apiBaseUrl()}/api/chat/midia/message-1`);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization"))
      .toBe("Bearer token-relativo");
  });

  it("autentica uma URL absoluta da mesma origem da aplicacao", async () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE, "token-same-origin");
    const fetchMock = mockSuccessfulBlobFetch();
    const url = new URL("/api/chat/midia/message-2", window.location.origin).href;

    await apiBlobRequest(url);

    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization"))
      .toBe("Bearer token-same-origin");
  });

  it("recusa uma URL externa que imita uma rota interna sem enviar o Bearer", async () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE, "token-secreto");
    const fetchMock = mockSuccessfulBlobFetch();

    await expect(apiBlobRequest("https://host-malicioso.example/api/chat/x", {
      credentials: "include",
      headers: { Authorization: "Basic manual", Cookie: "session=manual" },
    }))
      .rejects.toThrow(/origem/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://localhost.evil.example/api/chat/x",
    "https://sub.host-malicioso.example/api/chat/x",
    "//host-malicioso.example/api/chat/x",
    "\\\\host-malicioso.example\\api\\chat\\x",
  ])("recusa host parecido ou subdominio externo: %s", async (url) => {
    const fetchMock = mockSuccessfulBlobFetch();

    await expect(apiBlobRequest(url, { token: "token-secreto" })).rejects.toThrow(/origem/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa URL absoluta invalida antes do fetch", async () => {
    const fetchMock = mockSuccessfulBlobFetch();

    await expect(apiBlobRequest("https://[", { token: "token-secreto" })).rejects.toThrow(/origem/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mantem a requisicao relativa sem Authorization quando nao existe token", async () => {
    const fetchMock = mockSuccessfulBlobFetch();

    await apiBlobRequest("/api/chat/midia/publica");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("Authorization")).toBe(false);
  });
});

describe("apiRequest", () => {
  it("aplica a mesma barreira central a requisicoes JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);

    await expect(apiRequest("https://host-malicioso.example/api/chat/x", { token: "token-secreto" }))
      .rejects.toThrow(/origem/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
