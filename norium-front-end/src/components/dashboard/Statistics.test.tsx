import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Statistics from "./Statistics";

describe("Statistics", () => {
  it("mostra indicadores compactos sem card-in-card nem atalho duplicado da Nora", () => {
    const { container } = render(<Statistics metrics={{ emails: 2, whatsapp: 1, calendar: 3, tasks: 4, total: 10 }} />);
    expect(screen.getByText("Eventos monitorados")).toBeInTheDocument();
    expect(screen.getByText("Tarefas movimentadas")).toBeInTheDocument();
    expect(screen.getByText("Canais ativos")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Consultar insights" })).not.toBeInTheDocument();
    expect(container.querySelector(".norium-dashboard-stat-flat")).not.toBeNull();
  });
});
