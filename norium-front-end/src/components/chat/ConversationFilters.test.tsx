import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import ConversationFilters from "./ConversationFilters";

const state = vi.hoisted(() => ({ inboxId: undefined as string | undefined, viewId: "",
  filter: { responsavel: "all", estado: "" }, setFilter: vi.fn(), setViewId: vi.fn() }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => "synthetic:primary" }));
vi.mock("./WhatsAppScope", () => ({ useWhatsAppScope: () => state }));
const request = vi.mocked(apiRequest);
const view = { id: "saved", name: "Minhas pendências", scope: "personal", version: 2, canEdit: true, filters: { responsavel: "all", estado: "", unread: true } };
function fixture() { request.mockImplementation(async path => path.startsWith("/api/business/whatsapp-views") ? { items: [view], canShare: Boolean(state.inboxId) }
  : { items: [{ id: "vip", name: "VIP", color: "#123456", scope: "contact" }, { id: "wrong", name: "Only client", scope: "client" }] }); }
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { vi.resetAllMocks(); state.inboxId = undefined; state.viewId = ""; });
describe("filtros e visões", () => {
  it("uma resposta incompleta de visões não derruba a tela de conversas", async () => {
    request.mockResolvedValue({}); render(<ConversationFilters />);
    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível carregar as visões salvas.");
    expect(screen.getByRole("button", { name: "Filtros" })).toBeInTheDocument();
  });
  it("aplica período, etiquetas e tipo em conjunto, sem oferecer estado pessoal inexistente", async () => {
    fixture(); const user = userEvent.setup(); render(<ConversationFilters />);
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Tipo" }), "group");
    await user.click(screen.getByRole("checkbox", { name: "Somente não lidas" }));
    await user.click(await screen.findByRole("checkbox", { name: "VIP" }));
    expect(screen.queryByRole("checkbox", { name: "Only client" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Responsável" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    expect(state.setFilter).toHaveBeenCalledWith(expect.objectContaining({ kind: "group", unread: true, tagIds: ["vip"] }));
  });
  it("aplica uma visão e preserva a referência no contexto da caixa", async () => {
    fixture(); const user = userEvent.setup(); render(<ConversationFilters />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Visões salvas" }), "saved");
    expect(state.setViewId).toHaveBeenCalledWith("saved"); expect(state.setFilter).toHaveBeenCalledWith(view.filters);
  });
  it("salva combinação na caixa explícita e permite visão compartilhada apenas quando autorizada", async () => {
    fixture(); state.inboxId = "a".repeat(64); const user = userEvent.setup(); render(<ConversationFilters />);
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    await user.type(screen.getByRole("textbox", { name: "Nome da visão" }), "Fila da equipe");
    await user.click(await screen.findByRole("checkbox", { name: "Compartilhar nova visão com a equipe" }));
    await user.click(screen.getByRole("button", { name: "Salvar nova visão" }));
    const call = request.mock.calls.find(call => call[1]?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(expect.objectContaining({ name: "Fila da equipe", scope: "team", inboxId: state.inboxId }));
  });
  it("atualiza uma visão com versão e mantém o restante das funções", async () => {
    fixture(); state.viewId = "saved"; const user = userEvent.setup(); render(<ConversationFilters />);
    await screen.findByRole("combobox", { name: "Visões salvas" });
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    await user.type(screen.getByRole("textbox", { name: "Nome da visão" }), "Atualizada");
    await user.click(screen.getByRole("button", { name: "Atualizar visão selecionada" }));
    const call = request.mock.calls.find(call => call[1]?.method === "PUT");
    expect(call?.[0]).toBe("/api/business/whatsapp-views/personal/saved");
    expect(JSON.parse(String(call?.[1]?.body)).expectedVersion).toBe(2);
    expect(screen.getByRole("button", { name: "Gerenciar etiquetas" })).toBeInTheDocument();
  });
});
