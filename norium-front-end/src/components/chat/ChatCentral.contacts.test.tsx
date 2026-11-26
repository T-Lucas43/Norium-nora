import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  conversations: vi.fn(),
  contacts: vi.fn(),
  history: vi.fn(),
  details: vi.fn(),
  markConversation: vi.fn(),
}));

vi.mock("./whatsappApi", () => ({ whatsappApi: api }));
vi.mock("./SidebarEsquerda", () => ({
  default: ({ onAbrirModalContatos }: { onAbrirModalContatos: () => void }) => (
    <button type="button" onClick={onAbrirModalContatos}>Novo chat</button>
  ),
}));
vi.mock("./AreaCentralChat", () => ({
  default: ({ conversaAtiva, onAbrirDadosPerfil }: { conversaAtiva?: { contato: string }; onAbrirDadosPerfil: () => void }) => (
    <div><div data-testid="active-chat">{conversaAtiva?.contato || "Nenhuma conversa"}</div><button type="button" onClick={onAbrirDadosPerfil} aria-label="Dados">Dados</button></div>
  ),
}));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("novo chat pela lista de contatos", () => {
  beforeEach(() => {
    api.status.mockResolvedValue({ conectado: true, status: "conectado" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([{
      id: "5511999999999@c.us",
      phone: "5511999999999",
      pushname: "Joao da Silva",
    }]);
    api.history.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    api.details.mockResolvedValue({
      id: "5511999999999@c.us",
      contato: "5511999999999@c.us",
      canal: "whatsapp",
      ultimoTexto: "",
      horario: "",
      timestampUltimaMsg: 0,
      lida: true,
      mensagens: [],
      metadados: { numeroCompleto: "5511999999999@c.us", statusOnline: false },
    });
    api.markConversation.mockResolvedValue({ status: "not_found" });
  });

  it("busca pelo telefone e abre um contato sem conversa anterior", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Novo chat" }));
    const search = await screen.findByRole("searchbox", { name: "Buscar contatos" });
    await user.type(search, "9999-9999");
    await user.click(screen.getByRole("button", { name: /Joao da Silva/ }));

    expect(await screen.findByTestId("active-chat")).toHaveTextContent("Joao da Silva");
    expect(api.history).toHaveBeenCalledWith("5511999999999@c.us", undefined);
    expect(api.details).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Dados" }));
    expect(api.details).toHaveBeenCalledWith("5511999999999@c.us");
  });
});
