import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DashboardRail from "./DashboardRail";

function baseProps(onNavigate: () => void) {
  return {
    weather: null,
    calendarEvents: [],
    financePending: [
      { id: "bill-1", title: "Hospedagem", amount: 149.9, dueDate: "2026-09-16", scheduled: false },
      { id: "bill-2", title: "Internet", amount: 120, dueDate: "2026-09-18", scheduled: true },
    ],
    financePendingTotal: 149.9,
    financeOverdueCount: 1,
    focusTask: null,
    taskOverdueCount: 0,
    todayEventCount: 0,
    onNavigate,
  };
}

describe("DashboardRail", () => {
  it("preenche a lateral com pendências financeiras reais e abre o Financeiro", () => {
    const onNavigate = vi.fn();
    render(<DashboardRail {...baseProps(onNavigate)} />);

    expect(screen.getByRole("heading", { name: "Contas a pagar" })).toBeInTheDocument();
    expect(screen.getByText("Hospedagem")).toBeInTheDocument();
    expect(screen.getByText("Internet")).toBeInTheDocument();
    expect(screen.getByText("1 vencida")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Abrir/ }));
    expect(onNavigate).toHaveBeenCalledWith("Financeiro");
  });

  it("orienta a próxima decisão para as tarefas vencidas antes da agenda", () => {
    const onNavigate = vi.fn();
    render(<DashboardRail
      {...baseProps(onNavigate)}
      focusTask={{ title: "Revisar proposta", meta: "Urgente · vence hoje" }}
      taskOverdueCount={2}
    />);

    expect(screen.getByText("Próxima decisão")).toBeInTheDocument();
    expect(screen.getByText("Resolver pendências")).toBeInTheDocument();
    expect(screen.getByText("2 tarefas vencidas precisam de você")).toBeInTheDocument();
    expect(screen.getByText("Revisar proposta")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resolver pendências"));
    expect(onNavigate).toHaveBeenCalledWith("Tarefas");
  });
});
