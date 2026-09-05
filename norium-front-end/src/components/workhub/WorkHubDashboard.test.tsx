import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { apiRequest } from "../../core/api/client";
import WorkHubDashboard from "./WorkHubDashboard";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../shared/AppDialogProvider", () => ({ showConfirm: vi.fn(), showPrompt: vi.fn() }));
const request = vi.mocked(apiRequest);
const pending = { items: [{ id: "t1", kind: "task", title: "Revisar contrato", description: "Vence hoje", severity: "warning", timestamp: "2026-09-04", deepLink: { tab: "Tarefas", entityType: "task", entityId: "t1" } }], total: 1, counts: { task: 1 }, inboxOpen: 3 };
const payloads: Record<string, unknown> = {
  activity: { items: [], total: 0, counts: {} },
  tasks: pending,
  finance: { items: [], total: 0, counts: {} },
  messages: { items: [], total: 0, counts: {}, inboxOpen: 3 },
  integrations: { items: [], total: 0, counts: {} },
  foco: { item: { enabled: false } },
  "resumo-semanal": { actionsExecuted: 5, estimatedHoursSaved: 2 },
  metas: { items: [] },
  "produtividade-equipe": { members: [] },
  "inbox-compartilhada": { items: [], total: 0, statusCounts: {} },
  members: { members: [] },
  "uso-plano": { item: {} },
  backups: { items: [] },
};
function respond(path: string) { return Promise.resolve(payloads[path.split("/").at(-1)!.split("?")[0]]); }
function mount() { return render(<WorkHubDashboard onNavigate={vi.fn()} onOpenDeepLink={vi.fn()} onOpenNora={vi.fn()} />); }
function requestedPaths() { return request.mock.calls.map(([path]) => path); }

beforeEach(() => { request.mockReset(); request.mockImplementation(respond); });

describe("Central progressive loading", () => {
  it("shows priorities while the weekly summary is still waiting and skips hidden tabs", async () => {
    request.mockImplementation((path) => path.includes("resumo-semanal") ? new Promise(() => {}) : respond(path));
    mount();
    expect(await screen.findByRole("heading", { name: "Pendências consolidadas" })).toBeInTheDocument();
    expect(screen.getByText("1 item(ns)")).toBeInTheDocument();
    expect(requestedPaths()).toHaveLength(7);
    expect(requestedPaths()).not.toContain("/api/operacao/pendencias");
    expect(requestedPaths()).toContain("/api/operacao/resumo-semanal?include_team=false");
    expect(requestedPaths()).not.toContain("/api/operacao/uso-plano");
    expect(requestedPaths()).not.toContain("/api/operacao/backups");
    expect(requestedPaths()).not.toContain("/api/operacao/produtividade-equipe");
  });

  it("loads secondary tabs on demand and reuses them when switching back", async () => {
    mount();
    await screen.findByRole("heading", { name: "Pendências consolidadas" });
    fireEvent.click(screen.getByRole("button", { name: "Metas e equipe" }));
    await waitFor(() => expect(requestedPaths()).toContain("/api/operacao/metas"));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Pendências\s*1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Metas e equipe" }));
    expect(requestedPaths().filter((path) => path.endsWith("/metas"))).toHaveLength(1);
    expect(requestedPaths()).not.toContain("/api/operacao/uso-plano");
  });

  it("isolates a secondary failure and retries only that resource", async () => {
    request.mockImplementation((path) => path.includes("resumo-semanal") ? Promise.reject(new Error("Serviço ocupado")) : respond(path));
    mount();
    await screen.findByRole("heading", { name: "Pendências consolidadas" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Resumo semanal: Serviço ocupado");
    request.mockImplementation(respond);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(requestedPaths().filter((path) => path.endsWith("/tasks"))).toHaveLength(1);
  });

  it("allows retry after the initial priorities request fails", async () => {
    request.mockImplementation((path) => path.endsWith("/tasks") ? Promise.reject(new Error("Falha temporária")) : respond(path));
    mount();
    expect(screen.getByRole("heading", { name: "Central de trabalho" })).toBeInTheDocument();
    await screen.findByRole("alert");
    request.mockImplementation(respond);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByText("Revisar contrato");
  });

  it("refreshes visited sections without loading backups and survives StrictMode cancellation", async () => {
    render(<StrictMode><WorkHubDashboard onNavigate={vi.fn()} onOpenDeepLink={vi.fn()} onOpenNora={vi.fn()} /></StrictMode>);
    await screen.findByRole("heading", { name: "Pendências consolidadas" });
    const before = request.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(request.mock.calls.length).toBe(before + 7));
    expect(requestedPaths()).not.toContain("/api/operacao/backups");
  });

  it("aborts outstanding requests when navigating away", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    const view = mount();
    const signals = request.mock.calls.map(([, options]) => options?.signal);
    act(() => view.unmount());
    expect(signals).toHaveLength(7);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("ignores an older response after a manual refresh", async () => {
    let finishOld!: (value: unknown) => void;
    request.mockImplementation((path) => path.endsWith("/tasks") ? new Promise((resolve) => { finishOld = resolve; }) : respond(path));
    mount();
    const oldSignal = request.mock.calls.find(([path]) => path.endsWith("/tasks"))?.[1]?.signal;
    request.mockImplementation(respond);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByRole("heading", { name: "Pendências consolidadas" });
    await act(async () => finishOld({ ...pending, items: [], total: 0 }));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByText("1 item(ns)")).toBeInTheDocument();
  });

  it("keeps real priorities and inbox counts visible while an integration is locked", async () => {
    request.mockImplementation((path) => path.endsWith("/integrations") ? new Promise(() => {}) : respond(path));
    mount();
    expect(await screen.findByText("Revisar contrato")).toBeInTheDocument();
    expect(screen.getByText("1 item(ns) · parcial")).toBeInTheDocument();
    expect(screen.getByText("1+")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma pendência.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains successful sources and retries only the failed priority source", async () => {
    request.mockImplementation((path) => path.endsWith("/finance") ? Promise.reject(new Error("Fonte ocupada")) : respond(path));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Financeiro: Fonte ocupada");
    expect(screen.getByText("Revisar contrato")).toBeInTheDocument();
    request.mockImplementation(respond);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByText("1 item(ns)");
    expect(requestedPaths().filter((path) => path.endsWith("/finance"))).toHaveLength(2);
    expect(requestedPaths().filter((path) => path.endsWith("/tasks"))).toHaveLength(1);
  });

  it("never claims there are no pending items when an empty response is incomplete", async () => {
    request.mockImplementation((path) => path.endsWith("/tasks") ? new Promise(() => {}) : respond(path));
    mount();
    await screen.findByText("Nenhum item nas fontes carregadas.");
    expect(screen.queryByText("Nenhuma pendência.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Follow-ups" }));
    expect(await screen.findByText("Nenhum follow-up aberto.")).toBeInTheDocument();
  });
});
