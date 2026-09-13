import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MoreDashboard from "./MoreDashboard";
import { TAB_ROUTES } from "../../app/navigation/tabs";
it("links every resource card to a registered destination", () => {
  const navigate = vi.fn();
  render(<MoreDashboard onNavigate={navigate} onOpenNora={vi.fn()} onLogout={vi.fn()} />);
  for (const button of screen.getAllByRole("button", { name: /Abrir recurso/ })) {
    fireEvent.click(button);
    expect(TAB_ROUTES[navigate.mock.lastCall![0]]).toBeTruthy();
  }
  expect(navigate).toHaveBeenCalledWith("Chat da Equipe");
  expect(navigate).toHaveBeenCalledWith("E-mails");
  fireEvent.change(screen.getByLabelText("Buscar recursos"), { target: { value: "configuracoes" } });
  expect(screen.getAllByRole("button", { name: /Abrir recurso/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Configurações.*Abrir recurso/ }));
  expect(navigate).toHaveBeenLastCalledWith("Configurações");
});
