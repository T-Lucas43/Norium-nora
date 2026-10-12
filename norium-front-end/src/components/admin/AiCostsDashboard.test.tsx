import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiCostsDashboard from "./AiCostsDashboard";
import { authJson } from "../../utils/authApi";
import type { NoriumUser } from "../../types/auth";
import { ownerPermissions } from "../../types/auth";

vi.mock("../../utils/authApi", () => ({ authJson: vi.fn() }));
const actor: NoriumUser = { id: "admin", nome: "Admin", email: "admin@example.test", role: "owner", plan: "enterprise", status: "ativo", systemAdmin: true, systemAdminRole: "owner", permissions: ownerPermissions };
const account = { ...actor, id: "a", nome: "Ana", email: "ana@example.test", systemAdmin: false, systemAdminRole: null };
const totals = { requests: 2, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedTokens: 200, reasoningTokens: 100, costUsd: 0.002, inputCostUsd: 0.001, outputCostUsd: 0.001, unpricedRequests: 0, estimatedRequests: 0 };
function overview() { return { month: "2026-09", currentMonth: "2026-09", trackingStartedAt: "2026-09-10T12:00:00Z", updatedAt: "2026-09-10T12:00:00Z", totals, models: [{ ...totals, id: "groq", model: "openai/gpt-oss-20b", provider: "groq", name: "Nora", baseUrl: "https://api.groq.com/openai/v1", unitTokens: 1000000, inputUsd: 0.075, outputUsd: 0.3, cachedInputUsd: 0.037, cacheWriteUsd: 0.075, source: "https://console.groq.com/docs/model/openai/gpt-oss-20b", validUntil: null, version: 1, updatedAt: "2026-09-10T12:00:00Z", connections: [{ configured: true, enabled: true, userId: null }] }], users: [{ ...totals, id: "a", name: "Ana", email: "ana@example.test", limits: { monthlyBudgetUsd: 5, monthlyTokenLimit: 100000 }, currentMonth: totals, remainingUsd: 4.998, remainingTokens: 98500, pendingRequests: 0, models: [{ ...totals, modelId: "groq", capacityMixed: 98500, capacityInputOnly: 98500, capacityOutputOnly: 98500 }] }], recentUsage: [], audit: [] }; }
function setup() { vi.mocked(authJson).mockImplementation(async (_path, _token, options) => options?.method ? {} : overview()); return render(<AiCostsDashboard token="test-token" actor={actor} users={[actor, account]} />); }

describe("AiCostsDashboard", () => {
  beforeEach(() => vi.clearAllMocks());
  it("exibe custo geral e detalhamento individual por modelo", async () => {
    setup(); const user = userEvent.setup();
    expect(await screen.findByText("Custo de todos os usuários")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ana/ }));
    expect(screen.getByRole("heading", { name: "Detalhamento por modelo" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("openai/gpt-oss-20b")).toBeInTheDocument();
    expect(screen.getByText(/75% de entrada/)).toBeInTheDocument();
  });
  it("salva zero como bloqueio e campo vazio como ilimitado", async () => {
    setup(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Ana/ }));
    await user.clear(screen.getByLabelText("Orçamento por ciclo (USD)"));
    await user.type(screen.getByLabelText("Orçamento por ciclo (USD)"), "0");
    await user.clear(screen.getByLabelText("Limite de tokens por ciclo"));
    await user.click(screen.getByRole("button", { name: "Salvar limites" }));
    await waitFor(() => expect(authJson).toHaveBeenCalledWith("/api/auth/admin/ai-costs/users/a/limits", "test-token", { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd: 0, monthlyTokenLimit: null, period: "monthly", startDate: null, autoRenew: true }) }));
  });
  it("salva ciclo semanal e data escolhida e permite reset explícito", async () => {
    setup(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Ana/ }));
    await user.selectOptions(screen.getByLabelText("Tipo de ciclo"), "weekly");
    fireEvent.change(screen.getByLabelText("Data de início"), { target: { value: "2026-09-14" } });
    await user.selectOptions(screen.getByLabelText("Renovação"), "manual");
    await user.click(screen.getByRole("button", { name: "Salvar limites" }));
    await waitFor(() => expect(authJson).toHaveBeenCalledWith("/api/auth/admin/ai-costs/users/a/limits", "test-token", expect.objectContaining({ body: JSON.stringify({ monthlyBudgetUsd: 5, monthlyTokenLimit: 100000, period: "weekly", startDate: "2026-09-14", autoRenew: false }) })));
    await user.click(screen.getByRole("button", { name: "Resetar saldo" }));
    expect(authJson).not.toHaveBeenCalledWith(expect.stringContaining("/reset"), expect.anything(), expect.anything());
    await user.selectOptions(screen.getByLabelText("Calendário após o reset"), "keep");
    await user.type(screen.getByLabelText("Motivo do reset (opcional)"), "Novo crédito");
    await user.click(screen.getByRole("button", { name: "Confirmar reset" }));
    await waitFor(() => expect(authJson).toHaveBeenCalledWith("/api/auth/admin/ai-costs/users/a/reset", "test-token", { method: "POST", body: JSON.stringify({ restartCycle: false, reason: "Novo crédito" }) }));
  });
  it("edita tarifa com base de tokens e preço de cache", async () => {
    setup(); const user = userEvent.setup();
    await screen.findByText("Ana");
    await user.click(screen.getByRole("button", { name: "Modelos e tarifas" }));
    await user.click(screen.getByRole("button", { name: "Editar tarifa" }));
    await user.clear(screen.getByLabelText("Quantidade de tokens por unidade"));
    await user.type(screen.getByLabelText("Quantidade de tokens por unidade"), "1000");
    await user.click(screen.getByRole("button", { name: "Salvar tarifa" }));
    await waitFor(() => expect(authJson).toHaveBeenCalledWith("/api/auth/admin/ai-costs/tariffs", "test-token", expect.objectContaining({ method: "POST", body: expect.stringContaining('"unitTokens":1000') })));
    expect(await screen.findByRole("status")).toHaveTextContent("Tarifa salva");
  });
  it("consulta histórico completo e explica ausência de registros", async () => {
    setup(); const user = userEvent.setup();
    await screen.findByText("Ana");
    await user.click(screen.getByRole("button", { name: "Todo o histórico" }));
    await waitFor(() => expect(authJson).toHaveBeenCalledWith("/api/auth/admin/ai-costs?month=all", "test-token"));
    await user.click(screen.getByRole("button", { name: "Últimas chamadas" }));
    expect(screen.getByText(/Nenhuma chamada registrada neste período/)).toBeInTheDocument();
  });
  it("mantém falha de carregamento visível", async () => {
    vi.mocked(authJson).mockRejectedValue(new Error("Acesso admin restrito."));
    render(<AiCostsDashboard token="bad-token" actor={actor} users={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Acesso admin restrito.");
    expect(screen.queryByText("Custo de todos os usuários")).not.toBeInTheDocument();
  });
});
