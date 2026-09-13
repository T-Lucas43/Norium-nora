import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import EventTriggerFields from "./EventTriggerFields";
import type { AutomationNode } from "../../features/automations/types";
vi.mock("../chat/whatsappApi", () => ({ whatsappApi: { contacts: vi.fn().mockResolvedValue([]) } }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn().mockResolvedValue({ members: [{ id: "ana", nome: "Ana" }], projects: [], subteams: [{ id: "sales", name: "Comercial" }] }) }));
function Editor() {
  const [node, setNode] = useState<AutomationNode>({ id: "t", title: "Compromisso criado", kind: "trigger", icon: "calendar-days", description: "", x: 0, y: 0 });
  return <><EventTriggerFields node={node} onChange={config => setNode({ ...node, config })}/><output data-testid="config">{JSON.stringify(node.config)}</output></>;
}
it("requires explicit opt-in and clears it when switching the event", () => {
  render(<Editor/>);
  const enabled = screen.getByRole("checkbox");
  expect(enabled).not.toBeChecked();
  fireEvent.click(enabled);
  expect(screen.getByTestId("config")).toHaveTextContent('"automatic":"true"');
  expect(screen.getByTestId("config")).toHaveTextContent('"enabledAt":');
  fireEvent.change(screen.getByLabelText("Evento do sistema"), { target: { value: "task.created" } });
  expect(enabled).not.toBeChecked();
  expect(screen.getByTestId("config")).toHaveTextContent('"eventType":"task.created"');
});
it("persists chat filters and clears stale sender when changing scope", async () => {
  render(<Editor/>);
  fireEvent.change(screen.getByLabelText("Evento do sistema"), { target: { value: "team.message" } });
  await screen.findByRole("option", { name: "Ana" });
  fireEvent.change(screen.getByLabelText("Remetente"), { target: { value: "ana" } });
  fireEvent.change(screen.getByLabelText("Origem no chat"), { target: { value: "subteam" } });
  await screen.findByRole("option", { name: "Comercial" });
  expect(screen.getByTestId("config")).toHaveTextContent('"senderId":""');
  fireEvent.change(screen.getByLabelText("Subequipe de origem"), { target: { value: "sales" } });
  fireEvent.change(screen.getByLabelText("Texto deve conter (opcional)"), { target: { value: "orçamento" } });
  expect(screen.getByTestId("config")).toHaveTextContent('"subteamId":"sales"');
  expect(screen.getByTestId("config")).toHaveTextContent('"contains":"orçamento"');
});
