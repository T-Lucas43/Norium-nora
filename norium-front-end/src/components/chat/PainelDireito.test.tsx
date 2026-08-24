import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
