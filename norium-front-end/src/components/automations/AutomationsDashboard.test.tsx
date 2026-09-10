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
it("previews the draft and separates block and automation settings", async () => {
  render(<AutomationsDashboard userId="u1" onOpenNora={vi.fn()} />);
  await screen.findByRole("button", { name: "Explorar modelos" });
  fireEvent.click(screen.getByRole("button", { name: "Nova automação" }));
  expect(screen.getByLabelText("Nome da automação")).toBeInTheDocument();
  expect(screen.getByLabelText("Buscar componentes")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Automação" }));
  expect(screen.getByRole("button", { name: "Automação" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Pré-visualizar" }));
  expect(screen.getByRole("button", { name: "Ajustar à tela" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Voltar ao editor" }));
  expect(screen.queryByRole("button", { name: "Ajustar à tela" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Ordem de execução" })).toBeInTheDocument();
});
it("saves reordered actions and their matching connections", async () => {
  render(<AutomationsDashboard userId="u1" onOpenNora={vi.fn()} />);
  await screen.findByRole("button", { name: "Explorar modelos" });
  fireEvent.click(screen.getByRole("button", { name: "Nova automação" }));
  fireEvent.click(screen.getByRole("button", { name: /Mover Mostrar notifica.*para cima/ }));
  fireEvent.click(screen.getByRole("button", { name: "Salvar fluxo" }));
  const call = request.mock.calls.find(([, init]) => init?.method === "POST");
  expect(call).toBeDefined();
  const saved = JSON.parse(String(call![1]!.body));
  expect(saved.flow.nodes.map((node: { title: string }) => node.title)).toEqual(["Manual", "Mostrar notificacao", "Executar IA"]);
  expect(saved.flow.connections.map((edge: { source: string; target: string }) => [edge.source, edge.target])).toEqual([[saved.flow.nodes[0].id, saved.flow.nodes[1].id], [saved.flow.nodes[1].id, saved.flow.nodes[2].id]]);
});
it("saves the automatic event and its text filter through the real builder", async () => {
  render(<AutomationsDashboard userId="u1" onOpenNora={vi.fn()} />);
  await screen.findByRole("button", { name: "Explorar modelos" });
  fireEvent.click(screen.getByRole("button", { name: "Nova automação" }));
  fireEvent.change(screen.getByLabelText("Buscar componentes"), { target: { value: "Compromisso criado" } });
  fireEvent.click(screen.getByRole("button", { name: /Compromisso criado.*Ao criar/ }));
  fireEvent.click(screen.getByRole("button", { name: "Bloco", exact: true }));
  fireEvent.click(screen.getByLabelText("Executar automaticamente ao receber este evento"));
  fireEvent.change(screen.getByLabelText("Texto deve conter (opcional)"), { target: { value: "Reunião comercial" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar fluxo" }));
  const call = request.mock.calls.find(([, init]) => init?.method === "POST");
  expect(call).toBeDefined();
  const saved = JSON.parse(String(call![1]!.body));
  const trigger = saved.flow.nodes.find((node: { kind: string }) => node.kind === "trigger");
  expect(trigger.config).toMatchObject({ automatic: "true", eventType: "calendar.created", contains: "Reunião comercial" });
  expect(trigger.config.enabledAt).toBeTruthy();
});
