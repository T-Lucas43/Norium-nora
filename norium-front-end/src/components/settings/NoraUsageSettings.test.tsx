import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import NoraUsageSettings, { type NoraUsageOverview } from "./NoraUsageSettings";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
function fixture(): NoraUsageOverview {
  return {
    updatedAt: "2026-10-11T20:30:00Z", trackingStartedAt: "2026-09-01T00:00:00Z",
    plan: { code: "equipe", name: "Equipe", tokenAllowance: 100000, noraCallAllowance: 1000 },
    personal: { id: "u1", name: "Pessoa de teste", totalTokens: 82000, requests: 120, pendingRequests: 0,
      unpricedRequests: 0, estimatedRequests: 0, remainingTokens: 18000, remainingCalls: 880,
      limits: { monthlyTokenLimit: 100000, monthlyBudgetUsd: null, callsLimit: 1000 },
      cycle: { startAt: "2026-10-01T03:00:00Z", endAt: "2026-11-01T03:00:00Z", nextResetAt: "2026-11-01T03:00:00Z", status: "active", active: true }, alerts: [80] },
    canViewPeople: false,
  };
}
beforeEach(() => { request.mockReset(); request.mockResolvedValue(fixture()); });

describe("Nora usage settings", () => {
  it("loads only the authenticated endpoint and shows tokens, calls and renewal", async () => {
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByText("82.000")).toBeInTheDocument();
    expect(screen.getByText("18.000 disponíveis")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("01/11/2026")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Tokens utilizados" })).toHaveAttribute("aria-valuenow", "82");
    expect(screen.getByRole("status")).toHaveTextContent("80%");
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/auth/nora-usage", { signal: expect.any(AbortSignal) });
  });

  it("uses effective personal limits and distinguishes zero from unlimited", async () => {
    const data = fixture(); data.personal.limits.monthlyTokenLimit = 0; data.personal.remainingTokens = 0;
    data.personal.limits.callsLimit = null; data.personal.remainingCalls = null;
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByText("Novas solicitações bloqueadas")).toBeInTheDocument();
    expect(screen.getByText("Sem limite definido")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("atingiu o limite");
    expect(screen.queryByRole("progressbar", { name: "Chamadas de IA" })).not.toBeInTheDocument();
  });

  it("shows the 95% warning and explains unpriced and estimated requests", async () => {
    const data = fixture(); data.personal.totalTokens = 96000; data.personal.remainingTokens = 4000;
    data.personal.unpricedRequests = 2; data.personal.estimatedRequests = 3; data.personal.pendingRequests = 1;
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    await screen.findByText("Seu consumo chegou a 95% do limite.");
    expect(screen.getByRole("status")).toHaveTextContent("95%");
    expect(screen.getByText(/2 chamada\(s\) com custo ainda sem tarifa/)).toBeInTheDocument();
    expect(screen.getByText(/1 solicitação\(ões\) em andamento/)).toBeInTheDocument();
  });

  it("does not show a threshold alert prematurely by rounding up", async () => {
    const data = fixture(); data.personal.totalTokens = 79999; data.personal.alerts = [];
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    await screen.findByText("79.999");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Tokens utilizados" })).toHaveAttribute("aria-valuenow", "79");
  });

  it("explains an exhausted shared allowance even with low personal usage", async () => {
    const data = fixture(); data.personal.totalTokens = 100; data.personal.alerts = [];
    data.personal.remainingTokens = 0; data.plan.remainingTokens = 0; data.plan.remainingCalls = 20;
    data.plan.currentCycle = { totalTokens: 100000, requests: 980 };
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByText("A franquia compartilhada do plano foi esgotada.")).toBeInTheDocument();
    expect(screen.getByText("Saldo do plano em tokens")).toBeInTheDocument();
    expect(screen.getByText("0 disponíveis")).toBeInTheDocument();
    expect(screen.getByText(/saldo disponível para você considera também/)).toBeInTheDocument();
  });

  it("attributes an 80% alert to shared usage when personal usage is lower", async () => {
    const data = fixture(); data.personal.totalTokens = 100; data.personal.alerts = [];
    data.plan.currentCycle = { totalTokens: 81000, requests: 5 };
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByText("A franquia compartilhada chegou a 80% do limite.")).toBeInTheDocument();
    expect(screen.queryByText("Seu consumo chegou a 80% do limite.")).not.toBeInTheDocument();
  });

  it("includes shared reservations in the threshold warning", async () => {
    const data = fixture(); data.personal.totalTokens = 100; data.personal.alerts = [];
    data.plan.currentCycle = { totalTokens: 100, requests: 5 }; data.plan.remainingTokens = 19000;
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByText("A franquia compartilhada chegou a 80% do limite.")).toBeInTheDocument();
  });

  it("hides people data when the server disallows consultation", async () => {
    const data = fixture(); data.people = [{ ...data.personal, id: "other", name: "Pessoa restrita" }];
    request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    await screen.findByText("82.000");
    expect(screen.queryByText("Pessoa restrita")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Consumo por pessoa" })).not.toBeInTheDocument();
  });

  it("shows authorized people and opens the existing administrative panel explicitly", async () => {
    const data = fixture(); data.canViewPeople = true; data.people = [data.personal];
    request.mockResolvedValue(data);
    const open = vi.fn(); render(<NoraUsageSettings userId="u1" onOpenAdmin={open} />);
    expect(await screen.findByRole("region", { name: "Consumo por pessoa" })).toHaveTextContent("Pessoa de teste");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Gerenciar limites no Admin/ }));
    expect(open).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports errors and retries without presenting invented consumption", async () => {
    request.mockRejectedValueOnce(new Error("Consulta indisponível"));
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Consulta indisponível");
    expect(screen.queryByText("0 disponíveis")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar consumo" }));
    expect(await screen.findByText("82.000")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the previous result visibly stale after a refresh failure", async () => {
    render(<NoraUsageSettings userId="u1" />);
    await screen.findByText("82.000");
    request.mockRejectedValueOnce(new Error("Falha de conexão"));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar consumo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("última consulta concluída");
    expect(screen.getByText("82.000")).toBeInTheDocument();
  });

  it("rejects a result belonging to a different signed-in person", async () => {
    const data = fixture(); data.personal.id = "other"; request.mockResolvedValue(data);
    render(<NoraUsageSettings userId="u1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sua sessão mudou");
    expect(screen.queryByText("82.000")).not.toBeInTheDocument();
  });

  it("ignores a late request after a user change", async () => {
    let finish: (data: NoraUsageOverview) => void = () => undefined;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const view = render(<NoraUsageSettings userId="u1" />);
    const next = fixture(); next.personal.id = "u2"; next.personal.totalTokens = 123;
    request.mockResolvedValueOnce(next);
    view.rerender(<NoraUsageSettings userId="u2" />);
    await screen.findByText("123");
    await act(async () => finish(fixture()));
    expect(screen.getByText("123")).toBeInTheDocument();
    expect(screen.queryByText("82.000")).not.toBeInTheDocument();
  });

  it("does not poll or keep an in-flight request alive after closing", async () => {
    let signal: AbortSignal | undefined;
    request.mockImplementationOnce((_path, options) => { signal = options?.signal as AbortSignal; return new Promise(() => undefined); });
    const view = render(<NoraUsageSettings userId="u1" />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
