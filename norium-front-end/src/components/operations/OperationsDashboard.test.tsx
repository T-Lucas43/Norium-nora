import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import OperationsDashboard from "./OperationsDashboard";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../shared/AppDialogProvider", () => ({ showConfirm: vi.fn() }));
const request = vi.mocked(apiRequest);
const summary = { summary: { activeTasks: 5, overdueTasks: 2, todayEvents: 1 }, briefing: { greeting: "Olá", title: "Dados carregados", description: "5 tarefas ativas", generatedAt: "2026-09-04T12:00:00Z" }, alerts: [] };
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); request.mockReset(); });

it("shows the usable panel and approvals while integration health is still waiting", async () => {
  request.mockImplementation((path) => {
    if (path.endsWith("/summary")) return Promise.resolve(summary);
    if (path.endsWith("/approvals")) return Promise.resolve({ approvals: [{ id: "a", title: "Revisar proposta", status: "pending" }], summary: { pendingApprovals: 1 } });
    if (path.endsWith("/integrations")) return new Promise(() => {});
    return Promise.resolve({});
  });
  render(<OperationsDashboard userId="a" />);
  expect(screen.getByRole("heading", { name: "Controle operacional" })).toBeInTheDocument();
  await screen.findByText("5 tarefas ativas");
  await screen.findByText("Revisar proposta");
  expect(screen.getByText("Carregando integrações...")).toBeInTheDocument();
  expect(screen.queryByText("Tudo aprovado por aqui")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([path]) => path.startsWith("/api/operacao/painel/"))).toBe(true);
});

it("does not present a failed load as zero approvals or an updated briefing and retries the affected section", async () => {
  request.mockRejectedValue(new Error("Tempo esgotado"));
  render(<OperationsDashboard userId="a" />);
  await screen.findByText("Aprovações indisponíveis no momento.");
  expect(screen.queryByText("Tudo aprovado por aqui")).not.toBeInTheDocument();
  expect(screen.queryByText(/Seu painel esta atualizado/)).not.toBeInTheDocument();
  expect(screen.queryByText("Nenhum alerta operacional neste momento.")).not.toBeInTheDocument();
  request.mockResolvedValue({ approvals: [], summary: { pendingApprovals: 0 } });
  const status = screen.getByText("Aprovações indisponíveis no momento.").parentElement!;
  fireEvent.click(status.querySelector("button")!);
  await screen.findByText("Tudo aprovado por aqui");
  expect(screen.getByText("Indicadores indisponíveis no momento.")).toBeInTheDocument();
});

it("aborts requests when leaving the screen so late results cannot refill its cache", async () => {
  request.mockImplementation(() => new Promise(() => {}));
  const view = render(<OperationsDashboard userId="a" />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(5));
  const signals = request.mock.calls.map(([, options]) => options?.signal);
  view.unmount();
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});
