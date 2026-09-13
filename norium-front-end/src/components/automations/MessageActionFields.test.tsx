import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import MessageActionFields, { messageIssues } from "./MessageActionFields";
import type { AutomationNode } from "../../features/automations/types";
vi.mock("../chat/whatsappApi", () => ({ whatsappApi: { contacts: vi.fn().mockResolvedValue([{ id: "contact-1", phone: "5511999999999", name: "Ana" }]) } }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn().mockImplementation((path: string) => Promise.resolve(path.endsWith("members") ? { members: [{ id: "ana", nome: "Ana" }] } : { subteams: [{ id: "sales", name: "Comercial" }] })) }));
function Editor({ title }: { title: string }) {
  const [node, setNode] = useState<AutomationNode>({ id: "a", title, kind: "action", icon: "users", description: "", x: 0, y: 0 });
  return <><MessageActionFields node={node} onChange={config => setNode({ ...node, config })}/><output data-testid="config">{JSON.stringify(node.config)}</output></>;
}
it("stores a selected WhatsApp contact and clears it when switching to a typed number", async () => {
  render(<Editor title="Enviar WhatsApp"/>);
  await screen.findByRole("option", { name: "Ana · 5511999999999" });
  fireEvent.change(screen.getByLabelText("Contato"), { target: { value: "5511999999999" } });
  expect(screen.getByTestId("config")).toHaveTextContent('"recipient":"5511999999999"');
  fireEvent.change(screen.getByLabelText("Tipo de destinatário"), { target: { value: "number" } });
  expect(screen.getByLabelText("Número com DDI e DDD")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Número com DDI e DDD"), { target: { value: "+55 21 98888-7777" } });
  fireEvent.change(screen.getByLabelText("Mensagem a enviar"), { target: { value: "Olá!" } });
  expect(screen.getByTestId("config")).toHaveTextContent('"actionType":"send_whatsapp"');
});
it("selects a member or a subteam and never reuses the previous recipient", async () => {
  render(<Editor title="Enviar mensagem no Chat"/>);
  fireEvent.change(screen.getByLabelText("Tipo de destinatário"), { target: { value: "direct" } });
  await screen.findByRole("option", { name: "Ana" });
  fireEvent.change(screen.getByLabelText("Destino no chat"), { target: { value: "ana" } });
  expect(screen.getByTestId("config")).toHaveTextContent('"recipientId":"ana"');
  fireEvent.change(screen.getByLabelText("Tipo de destinatário"), { target: { value: "subteam" } });
  await screen.findByRole("option", { name: "Comercial" });
  await waitFor(() => expect(screen.getByLabelText("Destino no chat")).toHaveValue(""));
  fireEvent.change(screen.getByLabelText("Destino no chat"), { target: { value: "sales" } });
  expect(screen.getByTestId("config")).toHaveTextContent('"scope":"subteam"');
  expect(screen.getByTestId("config")).toHaveTextContent('"recipientId":"sales"');
});
it("rejects missing message and malformed phone before saving", () => {
  const node: AutomationNode = { id: "a", title: "Enviar WhatsApp", kind: "action", icon: "", description: "", x: 0, y: 0, config: { recipientMode: "number", recipient: "abc" } };
  expect(messageIssues([node])).toHaveLength(2);
  expect(messageIssues([{ ...node, config: { recipientMode: "number", recipient: "+55 11 99999-9999", message: "Olá" } }])).toEqual([]);
});
