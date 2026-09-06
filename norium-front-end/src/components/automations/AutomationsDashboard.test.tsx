import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AutomationsDashboard from "./AutomationsDashboard";
import { automationsApiRequest } from "../../features/automations/api";

vi.mock("../../features/automations/api", () => ({ automationsApiRequest: vi.fn(), fetchActiveTaskProjects: vi.fn().mockResolvedValue([]) }));
const request = vi.mocked(automationsApiRequest);
beforeEach(() => { localStorage.clear(); request.mockReset(); request.mockResolvedValue({ automations: [], history: [], integrations: [] }); });

it("offers templates from the empty workspace and opens the real flow builder", async () => {
  render(<AutomationsDashboard userId="u1" onOpenNora={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Explorar modelos" }));
  expect(screen.getByRole("heading", { name: "Comece com um modelo" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Pesquisar automações")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Nova automação" }));
  expect(document.querySelector(".automation-builder")).toBeInTheDocument();
});

it("does not show an empty integration response as connected services", async () => {
  render(<AutomationsDashboard userId="u1" onOpenNora={vi.fn()} />);
  await screen.findByRole("button", { name: "Explorar modelos" });
  const navigation = screen.getByRole("navigation", { name: "Áreas de automações" });
  fireEvent.click(within(navigation).getByRole("button", { name: "Histórico e dados" }));
  expect(screen.getByText("Nenhuma integração informada para os fluxos.")).toBeInTheDocument();
  expect(screen.queryByText("Conectado")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Logs" })).toBeDisabled();
  fireEvent.click(within(navigation).getByRole("button", { name: "Visão do fluxo" }));
  expect(screen.getByText("Selecione um fluxo para visualizar")).toBeInTheDocument();
});
