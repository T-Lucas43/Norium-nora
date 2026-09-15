import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Statistics from "./Statistics";

describe("Statistics", () => {
  it("abre a Nora com uma consulta operacional real", () => {
    const onOpenNora = vi.fn();
    render(<Statistics metrics={{ emails: 2, whatsapp: 1, calendar: 3, tasks: 4, total: 10 }} onOpenNora={onOpenNora} />);
    fireEvent.click(screen.getByRole("button", { name: "Consultar insights" }));
    expect(onOpenNora).toHaveBeenCalledWith(expect.stringContaining("dados reais da Central"));
    expect(onOpenNora).toHaveBeenCalledWith(expect.stringContaining("prioridades de hoje"));
  });
});
