import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import ConversationBulkBar from "./ConversationBulkBar";
import type { ChatConversa } from "./types";
const state = vi.hoisted(() => ({ inboxId: undefined as string | undefined }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../../core/api/sessionScope", () => ({ requestScope: () => "account:primary" }));
vi.mock("./WhatsAppScope", () => ({ useWhatsAppScope: () => ({ inboxId: state.inboxId, prefix: "/api/chat/caixas/synthetic" }) }));
const request = vi.mocked(apiRequest);
const conversations = [{ id: "a", assignee: { version: 4 } }, { id: "b", assignee: { version: 8 } }] as ChatConversa[];
function props() { return { ids: ["a", "b"], conversations, onTags: vi.fn(), onClear: vi.fn(), onExport: vi.fn(), onUpdated: vi.fn() }; }
afterEach(() => { vi.resetAllMocks(); state.inboxId = undefined; });
describe("ações de seleção", () => {
  it("preserva exportação e faz um único lote local para arquivar", async () => {
    request.mockResolvedValue({ ok: true }); const callbacks = props(), user = userEvent.setup(); render(<ConversationBulkBar {...callbacks} />);
    await user.click(screen.getByRole("button", { name: "Exportar contatos" })); expect(callbacks.onExport).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(request).toHaveBeenCalledOnce(); expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ ids: ["a", "b"], acao: "arquivar", parametros: { valor: true } });
    expect(callbacks.onClear).toHaveBeenCalledOnce(); expect(callbacks.onUpdated).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Resolver" })).not.toBeInTheDocument();
  });
  it("pede confirmação antes de resolver e inclui todas as versões", async () => {
    state.inboxId = "a".repeat(64); request.mockResolvedValue({ ok: true }); const user = userEvent.setup();
    render(<ConversationBulkBar {...props()} />); await user.click(screen.getByRole("button", { name: "Resolver" }));
    expect(request).not.toHaveBeenCalled(); expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resolver conversas" }));
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ ids: ["a", "b"], inboxId: state.inboxId, acao: "resolver", parametros: { versions: { a: 4, b: 8 } } });
  });
  it("não apaga a seleção quando o backend recusa o lote", async () => {
    request.mockRejectedValue(new Error("Acesso alterado.")); const callbacks = props(), user = userEvent.setup();
    render(<ConversationBulkBar {...callbacks} />); await user.click(screen.getByRole("button", { name: "Marcar como lida" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Acesso alterado."); expect(callbacks.onClear).not.toHaveBeenCalled();
  });
  it("não oferece envio em massa", () => {
    render(<ConversationBulkBar {...props()} />);
    expect(screen.queryByRole("button", { name: /enviar/i })).not.toBeInTheDocument();
  });
});
