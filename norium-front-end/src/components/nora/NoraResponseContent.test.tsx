import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoraAutomationCards, NoraCalendar, NoraFinanceTable, NoraMarkdown, NoraTaskCards } from "./NoraResponseContent";
import { eventOnDay } from "./responseView";

describe("Nora structured responses", () => {
  it("reveals every returned task instead of silently discarding items after six", () => {
    render(<NoraTaskCards text="Aqui estão suas tarefas:" view={{ kind: "tasks", total: 8, items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: `Tarefa ${i + 1}`, priority: "alta" })) }} />);
    expect(screen.getAllByRole("article")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar mais tarefas" }));
    expect(screen.getByRole("heading", { name: "Tarefa 8" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(8);
  });
  it("separates financial categories and never treats an unknown amount as zero", () => {
    render(<NoraFinanceTable text="Resumo financeiro do Norium:" view={{ kind: "finance", metrics: [{ label: "Saldo realizado", value: -120, money: true }], groups: [{ label: "Lançamentos", total: 1, rows: [{ title: "Serviço", amount: 120, status: "pago" }] }, { label: "Boletos", total: 1, rows: [{ title: "Documento sem valor" }] }] }} />);
    expect(screen.getByRole("table")).toHaveAccessibleName("Lançamentos. Valores em reais.");
    fireEvent.click(screen.getByRole("button", { name: "Boletos 1" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Documento sem valor")).toBeInTheDocument();
    expect(within(table).queryByText(/R\$/)).not.toBeInTheDocument();
    expect(screen.getByText(/-R\$/)).toBeInTheDocument();
  });
  it("selects calendar dates, navigates months and retains undated events", () => {
    render(<NoraCalendar text="Sua agenda:" view={{ kind: "agenda", date: "2026-09-04", events: [{ id: "a", titulo: "Revisão", inicio: "2026-09-04T09:00:00-03:00", fim: "2026-09-04T10:00:00-03:00" }, { id: "b", titulo: "Planejamento", inicio: "2026-10-01" }, { id: "c", titulo: "Evento incompleto", inicio: "invalid" }] }} />);
    expect(screen.getByRole("heading", { name: "Revisão" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Evento incompleto" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(screen.getByRole("heading", { name: "Planejamento" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Revisão" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /, 2 de outubro de 2026, 0 compromissos/ }));
    expect(screen.getByText(/Nenhum compromisso nesta data/)).toBeInTheDocument();
  });
  it("respects exclusive all-day and midnight end dates", () => {
    const trip = { inicio: "2026-09-04", fim: "2026-09-07" };
    expect(eventOnDay(trip, "2026-09-06")).toBe(true);
    expect(eventOnDay(trip, "2026-09-07")).toBe(false);
    expect(eventOnDay({ inicio: "2026-09-04T22:00:00-03:00", fim: "2026-09-05T00:00:00-03:00" }, "2026-09-05")).toBe(false);
  });
  it("shows the requested month even when an agenda query is empty", () => {
    render(<NoraCalendar text="Nenhum compromisso." view={{ kind: "agenda", date: "2027-02-10", events: [] }} />);
    expect(screen.getByText("fevereiro de 2027")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /10 de fevereiro de 2027, 0 compromissos/ })).toHaveAttribute("aria-pressed", "true");
  });
  it("renders semantic Markdown tables and keeps raw HTML inert", () => {
    render(<NoraMarkdown text={'## Resultado\n\n| Item | Valor |\n| --- | --- |\n| Serviço | R$ 20 |\n\n<script>alert("x")</script>'} />);
    expect(screen.getByRole("heading", { name: "Resultado" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
  it("renders automation details as distinct professional cards", () => {
    render(<NoraAutomationCards text="Suas automações:" view={{ kind: "automations", total: 1, active: 1, runsToday: 2, items: [{ id: "a", name: "Novo e-mail", active: true, aiEnabled: true, trigger: "Gmail", actions: ["Resumir", "Criar tarefa"], executions: 4, savedMinutes: 40 }] }} />);
    expect(screen.getByRole("region", { name: "Automações da consulta" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Novo e-mail" })).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Criar tarefa")).toBeInTheDocument();
    expect(screen.getByText("4 execuções")).toBeInTheDocument();
  });
});
