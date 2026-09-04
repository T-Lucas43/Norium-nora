import { describe, expect, it } from "vitest";
import { buildNoraResponseView, legacyFinanceView, legacyTaskView, validDateKey } from "./responseView";

describe("Nora display snapshots", () => {
  it("keeps distinct records with the same title and only whitelisted display fields", () => {
    const view = buildNoraResponseView("tarefas", { tasks: [{ id: "1", title: "2026: Revisão", priority: "alta", comments: ["private"], secret: "not-a-display-field" }, { id: "2", title: "2026: Revisão" }], total: 20 });
    expect(view?.kind).toBe("tasks");
    expect(view).toMatchObject({ total: 20, items: [{ id: "1", title: "2026: Revisão", priority: "alta" }, { id: "2", title: "2026: Revisão" }] });
    expect(JSON.stringify(view)).not.toContain("private");
    expect(JSON.stringify(view)).not.toContain("secret");
  });
  it("distinguishes empty results from a question that has no result yet", () => {
    expect(buildNoraResponseView("tarefas", { tasks: [], total: 0 })).toMatchObject({ kind: "tasks", items: [], total: 0 });
    expect(buildNoraResponseView("tarefas", { status: "precisa_titulo", response: "Qual título?" })).toBeUndefined();
    expect(buildNoraResponseView("agenda", { events: [], date: "2026-10-20" })).toMatchObject({ kind: "agenda", date: "2026-10-20" });
  });
  it("keeps a zero balance, negative balances, separate categories and unknown amounts", () => {
    const view = buildNoraResponseView("financeiro", { financeiro: { resumo: { entradas: 0, saldo: -1234.56 }, lancamentos: [{ title: "Sem valor" }], programados: [{ title: "Internet", amount: 120, nextDueDate: "2026-10-10", active: true }], boletos: [] } });
    expect(view).toMatchObject({ kind: "finance", metrics: [{ value: 0 }, { value: -1234.56 }], groups: [{ rows: [{ title: "Sem valor", amount: undefined }] }, { rows: [{ dueDate: "2026-10-10", status: "ativo" }] }, { rows: [] }] });
  });
  it("renders known old task lists without stripping numeric titles or inventing status", () => {
    const view = legacyTaskView("Aqui estão suas tarefas:\n- 2026: Revisar proposta (alta, 2026-09-30)\n- Novo texto (media, sem vencimento)");
    expect(view).toMatchObject({ items: [{ title: "2026: Revisar proposta", dueDate: "2026-09-30" }, { title: "Novo texto", dueDate: undefined }] });
    if (view?.kind === "tasks") expect(view.items[0].status).toBeUndefined();
    expect(legacyTaskView("Sugestão:\n- Crie uma tarefa importante")).toBeUndefined();
    expect(legacyTaskView("Aqui estão suas tarefas:\n- Texto sem campos\nAviso: verificar depois")).toBeUndefined();
  });
  it("converts old pipe-separated finance results and preserves unrelated Markdown", () => {
    const view = legacyFinanceView("Resumo financeiro do Norium:\n- Saldo: R$ -1.234,56\n- Vencidos: 2\nUltimos lancamentos:\n- Internet | saida | R$ 120,00 | pendente | vencimento: 2026-10-10 | categoria: fixo | anexos: 0\nGastos programados:\n- Nenhum gasto programado ativo.\nBoletos importados:\n- Nenhum boleto importado.");
    expect(view).toMatchObject({ metrics: [{ value: -1234.56 }, { value: 2 }], groups: [{ rows: [{ title: "Internet", amount: 120, dueDate: "2026-10-10" }] }, { rows: [] }, { rows: [] }] });
    expect(legacyFinanceView("| Receita | Valor |\n| --- | --- |\n| Venda | R$ 20 | ")).toBeUndefined();
  });
  it("rejects impossible calendar dates", () => {
    expect(validDateKey("2026-02-31")).toBeUndefined();
    expect(validDateKey("2026-09-04T09:00:00-03:00")).toBe("2026-09-04");
  });
});
