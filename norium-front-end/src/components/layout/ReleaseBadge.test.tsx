import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReleaseBadge from "./ReleaseBadge";

const revision = "abcdef0123456789abcdef0123456789abcdef01";
const payload = { environment: "homologacao", version: "2026.10.05", revision };
const response = (value: unknown) => ({ ok: true, json: async () => value });

describe("ReleaseBadge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(response(payload));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mostra ambiente, versão e commit retornados pelo servidor", async () => {
    render(<ReleaseBadge />);
    expect(screen.getByRole("status", { name: "Versão em execução" })).toHaveTextContent("Consultando versão");
    await screen.findByText("Homologação · 2026.10.05 · abcdef0");
    expect(screen.getByRole("status")).toHaveAttribute("title", expect.stringContaining(revision));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/system/release"), expect.objectContaining({
      cache: "no-store", credentials: "omit", headers: { Accept: "application/json" },
    }));
  });

  it.each([
    ["producao", "Produção"],
    ["local", "Local"],
  ])("identifica o ambiente %s sem inferir pelo endereço", async (environment, label) => {
    fetchMock.mockResolvedValue(response({ ...payload, environment }));
    render(<ReleaseBadge />);
    await screen.findByText(`${label} · 2026.10.05 · abcdef0`);
  });

  it.each([
    { environment: "unknown", version: null, revision: null },
    { ...payload, version: "2026.02.30" },
    { ...payload, revision: "secret-or-invalid-value" },
    { ...payload, environment: "<script>private</script>" },
  ])("não inventa uma versão para metadados inválidos", async (value) => {
    fetchMock.mockResolvedValue(response(value));
    render(<ReleaseBadge />);
    await screen.findByText("Versão não informada");
    expect(screen.queryByText(/abcdef0|private|secret-or-invalid/)).not.toBeInTheDocument();
  });

  it("mostra indisponibilidade se o endpoint antigo não existir", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    render(<ReleaseBadge />);
    await screen.findByText("Versão indisponível");
  });

  it("atualiza o identificador ao voltar à aba após outro deploy", async () => {
    render(<ReleaseBadge />);
    await screen.findByText("Homologação · 2026.10.05 · abcdef0");
    fetchMock.mockResolvedValue(response({ ...payload, revision: "b".repeat(40) }));
    fireEvent(window, new Event("focus"));
    await screen.findByText("Homologação · 2026.10.05 · bbbbbbb");
  });

  it("uma resposta antiga não substitui a versão mais recente", async () => {
    let resolveOld!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    render(<ReleaseBadge />);
    fireEvent(window, new Event("focus"));
    await screen.findByText("Homologação · 2026.10.05 · abcdef0");
    await act(async () => { resolveOld(response({ ...payload, revision: "0".repeat(40) })); });
    expect(screen.getByRole("status")).toHaveTextContent("abcdef0");
  });

  it("consulta a cada minuto e pausa quando a aba está oculta", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<ReleaseBadge />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    visibility.mockRestore();
  });

  it("não mantém a versão antiga como atual quando a consulta falha", async () => {
    render(<ReleaseBadge />);
    await screen.findByText("Homologação · 2026.10.05 · abcdef0");
    fetchMock.mockRejectedValue(new Error("offline"));
    fireEvent(window, new Event("focus"));
    await screen.findByText("Versão indisponível");
  });

  it("aborta a consulta e remove os listeners ao desmontar", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ReleaseBadge />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    fireEvent(window, new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marca indisponível quando a consulta excede cinco segundos", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    render(<ReleaseBadge />);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByRole("status")).toHaveTextContent("Versão indisponível");
  });
});
