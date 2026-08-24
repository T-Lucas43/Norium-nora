import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import AreaCentralChat from "./AreaCentralChat";
import type { ChatConversa } from "./types";

const conversation: ChatConversa = {
  id: "5591999999999@s.whatsapp.net",
  contato: "Alexandre",
  canal: "whatsapp",
  ultimoTexto: "Mensagem visível",
  horario: "10:13",
  timestampUltimaMsg: 2,
  lida: true,
  mensagens: [
    { id: "empty", remetente: "contato", tipo: "texto", texto: "", horario: "10:12" },
    { id: "visible", remetente: "contato", tipo: "texto", texto: "Mensagem visível", horario: "10:13" },
  ],
  metadados: { numeroCompleto: "5591999999999@s.whatsapp.net", statusOnline: false },
};

const baseProps = {
  onEnviar: vi.fn(),
  onAbrirDadosPerfil: vi.fn(),
  onAnexarArquivo: vi.fn(),
  onGravarAudio: vi.fn(),
  gravando: false,
  tempoGravacao: 0,
  formatarTempo: () => "0:00",
  anexosPendentes: [],
  enviandoAnexos: false,
  statusMicrofone: "idle" as const,
  onRemoverAnexo: vi.fn(),
  onLimparAnexos: vi.fn(),
  onApagarMensagensEmMassa: vi.fn(),
  onEncaminharMensagens: vi.fn(),
  onCarregarMensagensAntigas: vi.fn().mockResolvedValue(undefined),
  temMaisMensagens: false,
  carregandoMensagens: false,
  onReagirMensagem: vi.fn(),
  onEscolherFigurinha: vi.fn(),
  figurinhasRecentes: [],
  onEnviarFigurinhaExistente: vi.fn(),
};

describe("renderização das mensagens", () => {
  it("não cria balão vazio e mantém o menu da mensagem recebida dentro da área visível", async () => {
    const user = userEvent.setup();
    render(<AreaCentralChat {...baseProps} conversaAtiva={conversation} />);

    expect(screen.queryByText("10:12")).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem visível")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ações da mensagem" }));
    const reply = screen.getByRole("button", { name: /Responder/ });
    expect(reply.parentElement).toHaveClass("fixed");
    expect(reply.parentElement).toHaveAttribute("data-message-menu-root");
    expect(reply.parentElement).toHaveStyle({ left: "8px" });

    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("button", { name: /Responder/ })).not.toBeInTheDocument();
  });
});
