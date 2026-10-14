import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FinanceRecordDialog from "./FinanceRecordDialog";

describe("Nora plan allowances", () => {
  it("edits total and personal tokens while preserving other plan limits", async () => {
    const submit = vi.fn();
    render(<FinanceRecordDialog kind="plan" plans={[]} categories={[]} providers={[]} onClose={vi.fn()} onSubmit={submit} record={{ id: "p1", code: "equipe", name: "Equipe", limits: { users: 10, noraCalls: 5000, noraTokens: 5000000, noraTokensPerPerson: 1000000, storageMb: 20000, documents: 50 } }} />);
    expect(screen.getByLabelText("Franquia de tokens do plano")).toHaveValue(5000000);
    expect(screen.getByLabelText("Limite de tokens por pessoa")).toHaveAttribute("min", "0");
    fireEvent.change(screen.getByLabelText("Franquia de tokens do plano"), { target: { value: "6000000" } });
    fireEvent.change(screen.getByLabelText("Limite de tokens por pessoa"), { target: { value: "800000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ limits: { users: 10, noraCalls: 5000, noraTokens: 6000000, noraTokensPerPerson: 800000, storageMb: 20000, documents: 50 } })));
  });
  it("preserves explicit zero and omits unset allowance overrides", async () => {
    const submit = vi.fn();
    render(<FinanceRecordDialog kind="plan" plans={[]} categories={[]} providers={[]} onClose={vi.fn()} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Plano de teste" } });
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "free" } });
    fireEvent.change(screen.getByLabelText("Franquia de tokens do plano"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ limits: expect.objectContaining({ noraTokens: 0 }) })));
    expect(submit.mock.calls[0][0].limits).not.toHaveProperty("noraTokensPerPerson");
  });
});
