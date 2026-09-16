import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DashboardRail from "./DashboardRail";

describe("DashboardRail", () => {
  it("preenche a lateral com pendências financeiras reais e abre o Financeiro", () => {
    const onNavigate = vi.fn();
    render(<DashboardRail
      weather={null}
      calendarEvents={[]}
      financePending={[
        { id: "bill-1", title: "Hospedagem", amount: 149.9, dueDate: "2026-09-16", scheduled: false },
        { id: "bill-2", title: "Internet", amount: 120, dueDate: "2026-09-18", scheduled: true },
      ]}
      financePendingTotal={149.9}
      financeOverdueCount={1}
      onNavigate={onNavigate}
      onOpenNora={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Contas a pagar" })).toBeInTheDocument();
    expect(screen.getByText("Hospedagem")).toBeInTheDocument();
    expect(screen.getByText("Internet")).toBeInTheDocument();
    expect(screen.getByText("1 vencida")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Abrir/ }));
    expect(onNavigate).toHaveBeenCalledWith("Financeiro");
  });
});
