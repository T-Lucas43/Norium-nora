import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinanceDashboard from "./FinanceDashboard";

const financeData = {
  lancamentos: [
    { id: "in", title: "Receita setembro", description: "", type: "entrada", amount: 1000, category: "vendas", method: "pix", status: "pago", dueDate: "2026-09-03", paidAt: "2026-09-03", attachments: [], source: "manual", createdAt: "2026-09-03T12:00:00Z", updatedAt: "2026-09-03T12:00:00Z" },
    { id: "out", title: "Despesa setembro", description: "", type: "saida", amount: 300, category: "serviços", method: "pix", status: "pago", dueDate: "2026-09-05", paidAt: "2026-09-05", attachments: [], source: "manual", createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:00:00Z" },
    { id: "old", title: "Receita agosto", description: "", type: "entrada", amount: 9000, category: "vendas", method: "pix", status: "pago", dueDate: "2026-08-03", paidAt: "2026-08-03", attachments: [], source: "manual", createdAt: "2026-08-03T12:00:00Z", updatedAt: "2026-08-03T12:00:00Z" },
  ],
  programados: [],
  boletos: [
    { id: "open", title: "Boleto aberto", beneficiary: "Fornecedor", amount: 80, dueDate: "2026-09-20", status: "pendente", barcode: "1", source: "importado" },
    { id: "paid", title: "Boleto quitado", beneficiary: "Fornecedor", amount: 50, dueDate: "2026-09-10", status: "pago", barcode: "2", source: "importado" },
  ],
  lembretes: [],
  resumo: { entradas: 10000, saidas: 300, saldo: 9700, pendente: 0, vencidos: 0, programadosAtivos: 0, boletosEncontrados: 2 },
};

beforeEach(() => {
  // Keep the current-month fixture stable while retaining real async timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 15, 12));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FinanceDashboard", () => {
  it("filtra os dados atuais por mês e separa boletos abertos dos pagos sem consulta de CPF", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => financeData }));
    render(<FinanceDashboard userId="owner" />);

    await waitFor(() => expect(screen.getByText("Receita setembro")).toBeInTheDocument());
    expect(screen.getByLabelText("Período financeiro")).toHaveValue("this-month");
    expect(screen.getByText("R$ 1.000,00")).toBeInTheDocument();
    expect(screen.getByText("R$ 700,00")).toBeInTheDocument();
    expect(screen.queryByText("Receita agosto")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/CPF/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Boletos/ }));
    expect(screen.getByText("Boleto aberto")).toBeInTheDocument();
    expect(screen.queryByText("Boleto quitado")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pagos" }));
    expect(screen.getByText("Boleto quitado")).toBeInTheDocument();
    expect(screen.queryByText("Boleto aberto")).not.toBeInTheDocument();
  });
});

describe("validação do financeiro", () => {
  it.each(["0", "-1", "inválido", "Infinity"])("explica valor inválido %s sem enviar", async (amount) => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lancamentos: [], programados: [], boletos: [], lembretes: [], stats: {} }) });
    vi.stubGlobal("fetch", fetch);
    render(<FinanceDashboard userId="synthetic" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Novo lançamento" }));
    fireEvent.change(screen.getByPlaceholderText("Título"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByPlaceholderText("Valor"), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar lançamento" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("valor maior que zero");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
