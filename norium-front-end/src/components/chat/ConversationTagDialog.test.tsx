import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import ConversationTagDialog from "./ConversationTagDialog";

const state = vi.hoisted(() => ({ scope: "owner:primary", inboxId: undefined as string | undefined }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => state.scope }));
vi.mock("./WhatsAppScope", () => ({ useWhatsAppScope: () => ({ inboxId: state.inboxId }) }));
const request = vi.mocked(apiRequest);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
const projection = { totalContacts: 2, items: [
  { id: "vip", name: "VIP", color: "#123456", selectedCount: 1 },
  { id: "new", name: "Novo", color: "#654321", selectedCount: 0 },
  { id: "all", name: "Todos", color: "#abcdef", selectedCount: 2 },
] };
function prepare() { request.mockImplementation(async path => path.endsWith("/etiquetas") ? projection : { ok: true }); }
afterEach(() => { vi.resetAllMocks(); state.scope = "owner:primary"; state.inboxId = undefined; });

describe("etiquetas da seleção", () => {
  it("recusa uma resposta incompleta sem quebrar o restante da página", async () => {
    request.mockResolvedValue({}); render(<ConversationTagDialog ids={["a"]} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as etiquetas desta seleção.");
    expect(screen.getByRole("button", { name: "Salvar etiquetas" })).toBeDisabled();
  });
  it("exibe estado misto, contagem por contato e não altera sem escolha", async () => {
    prepare(); render(<ConversationTagDialog ids={["a", "b"]} onClose={vi.fn()} />);
    const mixed = await screen.findByRole("checkbox", { name: /VIP/ });
    expect(mixed).toHaveAttribute("aria-checked", "mixed");
    expect((mixed as HTMLInputElement).indeterminate).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Todos/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Salvar etiquetas" })).toBeDisabled();
    expect(screen.getByText(/Etiquetas valem para o contato/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
  });
  it("salva somente escolhas explícitas em uma chamada e conserva etiquetas não editadas", async () => {
    prepare(); const close = vi.fn(), user = userEvent.setup();
    render(<ConversationTagDialog ids={["a", "b"]} onClose={close} />);
    await user.click(await screen.findByRole("checkbox", { name: /VIP/ }));
    await user.click(screen.getByRole("checkbox", { name: /Todos/ }));
    await user.click(screen.getByRole("button", { name: "Salvar etiquetas" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ ids: ["a", "b"], acao: "etiquetar",
      parametros: { changes: [{ tagId: "vip", apply: true }, { tagId: "all", apply: false }] } });
    expect(close).toHaveBeenCalledOnce();
  });
  it("usa caixa explícita sem caminho pessoal na projeção ou gravação", async () => {
    prepare(); state.inboxId = "a".repeat(64); const user = userEvent.setup();
    render(<ConversationTagDialog ids={["a"]} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: /Novo/ }));
    await user.click(screen.getByRole("button", { name: "Salvar etiquetas" }));
    for (const call of request.mock.calls) expect(JSON.parse(String(call[1]?.body)).inboxId).toBe(state.inboxId);
  });
  it("busca etiquetas e cria no cadastro comum sem enviar mensagens", async () => {
    let created = false;
    request.mockImplementation(async path => {
      if (path === "/api/business/tags") { created = true; return { item: { id: "created" } }; }
      return { ...projection, items: created ? [...projection.items, { id: "created", name: "Cliente novo", color: "#3b82f6", selectedCount: 0 }] : projection.items };
    });
    const user = userEvent.setup(); render(<ConversationTagDialog ids={["a", "b"]} onClose={vi.fn()} />);
    await screen.findByText("VIP"); await user.type(screen.getByRole("textbox", { name: "Buscar etiqueta" }), "Cliente novo");
    expect(screen.queryByText("VIP")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Criar etiqueta" }));
    await user.click(screen.getByRole("button", { name: /^Criar$/ }));
    expect(await screen.findByRole("checkbox", { name: /Cliente novo/ })).toBeChecked();
    const creation = request.mock.calls.find(call => call[0] === "/api/business/tags");
    expect(JSON.parse(String(creation?.[1]?.body))).toEqual({ name: "Cliente novo", color: "#3b82f6", scope: "contact" });
    expect(request.mock.calls.every(call => !call[0].includes("enviar"))).toBe(true);
  });
  it("mantém a prévia e o erro quando o lote é recusado", async () => {
    request.mockImplementation(async path => { if (path.endsWith("/etiquetas")) return projection; throw new Error("A seleção mudou."); });
    const close = vi.fn(), user = userEvent.setup(); render(<ConversationTagDialog ids={["a"]} onClose={close} />);
    await user.click(await screen.findByRole("checkbox", { name: /Novo/ }));
    await user.click(screen.getByRole("button", { name: "Salvar etiquetas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A seleção mudou."); expect(close).not.toHaveBeenCalled();
  });
  it("não aplica resposta atrasada depois de trocar de workspace", async () => {
    let done!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    render(<ConversationTagDialog ids={["a"]} onClose={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce()); state.scope = "owner:another";
    await act(async () => done(projection)); expect(screen.queryByText("VIP")).not.toBeInTheDocument();
  });
});
