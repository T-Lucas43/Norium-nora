import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatConversa } from "./types";
import PainelDireito from "./PainelDireito";

const conversation: ChatConversa = {
  id: "5511999999999@c.us",
  contato: "Contato teste",
  canal: "whatsapp",
  ultimoTexto: "Figurinha",
  horario: "10:30",
  timestampUltimaMsg: 1,
  lida: true,
  mensagens: [
    { id: "image", remetente: "contato", tipo: "midia", arquivoUrl: "https://example.test/image.jpg", horario: "10:29" },
    { id: "sticker", remetente: "contato", tipo: "sticker", arquivoUrl: "https://example.test/sticker.webp", horario: "10:30" },
  ],
  metadados: { numeroCompleto: "5511999999999", statusOnline: false },
};

describe("dados do contato", () => {
  it("mantem figurinhas fora da galeria de midia", () => {
    render(<PainelDireito modo="perfil" conversaAtiva={conversation} onFechar={() => undefined} />);

    expect(screen.getByText("Arquivos e midias (1)")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Visualizar midia" })).toHaveLength(1);
  });

  it("mostra telefone legível e não expõe JID nos dados do contato", () => {
    render(<PainelDireito modo="perfil" conversaAtiva={{ ...conversation, contato: conversation.id, metadados: { ...conversation.metadados, numeroCompleto: conversation.id } }} onFechar={() => undefined} />);

    expect(screen.getAllByText("+55 (11) 99999-9999")).toHaveLength(2);
    expect(screen.queryByText(/@c\.us/)).not.toBeInTheDocument();
    expect(screen.queryByText("Identificador JID")).not.toBeInTheDocument();
  });

  it("mostra nome e administração dos membros e inicia conversa direta", async () => {
    const user = userEvent.setup();
    const onStartMemberConversation = vi.fn();
    const member = { id: "5511888888888@s.whatsapp.net", phone: "5511888888888", name: "Marina Silva", isAdmin: true };
    const group: ChatConversa = {
      ...conversation,
      id: "120363000000@g.us",
      contato: "Equipe Norium",
      esGrupo: true,
      metadados: { numeroCompleto: "120363000000@g.us", statusOnline: false, participantes: [member] },
    };
    render(<PainelDireito modo="perfil" conversaAtiva={group} onFechar={() => undefined} onStartMemberConversation={onStartMemberConversation} />);

    expect(screen.getByText("Marina Silva")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Iniciar conversa com Marina Silva" }));
    expect(onStartMemberConversation).toHaveBeenCalledWith(member);
  });
});
