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
  onColarAnexos: vi.fn(),
  onGravarAudio: vi.fn(),
  gravando: false,
  tempoGravacao: 0,
  formatarTempo: () => "0:00",
  anexosPendentes: [],
  enviandoAnexos: false,
  statusMicrofone: "idle" as const,
  onRemoverAnexo: vi.fn(),
  onAlternarVisualizacaoUnica: vi.fn(),
  onLimparAnexos: vi.fn(),
  onApagarMensagensEmMassa: vi.fn(),
  onEncaminharMensagens: vi.fn(),
  onEditarMensagem: vi.fn(),
  onCarregarMensagensAntigas: vi.fn().mockResolvedValue(undefined),
  temMaisMensagens: false,
  carregandoMensagens: false,
  onReagirMensagem: vi.fn(),
  onEscolherFigurinha: vi.fn(),
  figurinhasRecentes: [],
  onEnviarFigurinhaExistente: vi.fn(),
};

describe("renderização das mensagens", () => {
  it("aplica a imagem personalizada somente ao painel rolável de mensagens", () => {
    const wallpaperUrl = "data:image/png;base64,AAAA";
    const { container } = render(<AreaCentralChat {...baseProps} conversaAtiva={conversation} wallpaperUrl={wallpaperUrl} />);

    const thread = container.querySelector(".norium-chat-thread") as HTMLElement;
    const messageArea = container.querySelector(".norium-chat-message-scroll") as HTMLElement;
    expect(messageArea).toHaveStyle({ backgroundSize: "cover", backgroundPosition: "center", backgroundAttachment: "scroll" });
    expect(messageArea.style.backgroundImage).toContain(wallpaperUrl);
    expect(thread.style.backgroundImage).toBe("");
  });

  it("não cria balão vazio e mantém o menu da mensagem recebida dentro da área visível", async () => {
    const user = userEvent.setup();
    render(<AreaCentralChat {...baseProps} conversaAtiva={conversation} />);

    expect(screen.queryByText("10:12")).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem visível")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ações da mensagem" }));
    const reply = screen.getByRole("button", { name: /^Responder$/ });
    expect(reply.parentElement).toHaveClass("fixed");
    expect(reply.parentElement).toHaveAttribute("data-message-menu-root");
    expect(reply.parentElement).toHaveStyle({ left: "8px" });

    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("button", { name: /^Responder$/ })).not.toBeInTheDocument();
  });

  it("encaminha arquivos colados com Ctrl+V para o fluxo de anexos", () => {
    const onColarAnexos = vi.fn();
    render(<AreaCentralChat {...baseProps} onColarAnexos={onColarAnexos} conversaAtiva={conversation} />);
    const image = new File(["imagem"], "captura.png", { type: "image/png" });

    fireEvent.paste(screen.getByPlaceholderText("Digite uma mensagem"), {
      clipboardData: { items: [], files: [image] },
    });

    expect(onColarAnexos).toHaveBeenCalledWith([image]);
  });

  it("exibe a menção ao participante do grupo pelo nome, preservando o restante da mensagem", () => {
    const groupConversation: ChatConversa = {
      ...conversation,
      id: "120363000000000000@g.us",
      contato: "Grupo de amigos",
      esGrupo: true,
      ultimoTexto: "@158127978729593 sem nuds aqui mn",
      mensagens: [
        {
          id: "mention",
          remetente: "contato",
          remetenteId: "5511999999999@s.whatsapp.net",
          remetenteNome: "Paulo C.",
          tipo: "texto",
          texto: "@158127978729593 sem nuds aqui mn",
          horario: "20:39",
        },
      ],
      metadados: {
        numeroCompleto: "120363000000000000@g.us",
        statusOnline: false,
        participantes: [
          {
            id: "158127978729593@lid",
            phone: "",
            name: "Vinícius",
            isAdmin: false,
          },
        ],
      },
    };

    const { container } = render(<AreaCentralChat {...baseProps} conversaAtiva={groupConversation} />);

    const mention = screen.getByText("@Vinícius");
    expect(mention).toHaveClass("text-[var(--primary)]");
    const bubble = container.querySelector(".norium-message-bubble");
    expect(bubble).toHaveTextContent("@Vinícius sem nuds aqui mn");
    expect(bubble).not.toHaveTextContent("@158127978729593");
  });

  it("abre as ações pelo botão direito, edita apenas mensagem própria e permite encaminhar ou apagar para todos", async () => {
    const user = userEvent.setup();
    const onEditarMensagem = vi.fn().mockResolvedValue(undefined);
    const onEncaminharMensagens = vi.fn();
    const onApagarMensagensEmMassa = vi.fn();
    const withOutgoing: ChatConversa = {
      ...conversation,
      mensagens: [
        ...conversation.mensagens,
        { id: "mine", remetente: "usuario", tipo: "texto", texto: "Texto enviado", horario: "10:14" },
      ],
    };
    render(<AreaCentralChat {...baseProps} conversaAtiva={withOutgoing} onEditarMensagem={onEditarMensagem} onEncaminharMensagens={onEncaminharMensagens} onApagarMensagensEmMassa={onApagarMensagensEmMassa} />);

    fireEvent.contextMenu(screen.getByText("Texto enviado").closest("[data-message-menu-root]") as HTMLElement, { clientX: 500, clientY: 300 });
    await user.click(screen.getByRole("button", { name: "Editar mensagem" }));
    const editor = screen.getByRole("dialog").querySelector("textarea") as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, "Texto corrigido");
    await user.click(screen.getByRole("button", { name: "Salvar edição" }));
    expect(onEditarMensagem).toHaveBeenCalledWith("mine", "Texto corrigido");

    fireEvent.contextMenu(screen.getByText("Texto enviado").closest("[data-message-menu-root]") as HTMLElement, { clientX: 500, clientY: 300 });
    await user.click(screen.getByRole("button", { name: "Encaminhar" }));
    expect(onEncaminharMensagens).toHaveBeenCalledWith(["mine"]);

    fireEvent.contextMenu(screen.getByText("Texto enviado").closest("[data-message-menu-root]") as HTMLElement, { clientX: 500, clientY: 300 });
    await user.click(screen.getByRole("button", { name: "Apagar para todos" }));
    expect(onApagarMensagensEmMassa).toHaveBeenCalledWith(["mine"], true);

    fireEvent.contextMenu(screen.getByText("Mensagem visível").closest("[data-message-menu-root]") as HTMLElement, { clientX: 500, clientY: 300 });
    expect(screen.queryByRole("button", { name: "Editar mensagem" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Responder com a Nora" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resumir com a Nora" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transformar em tarefa" })).toBeInTheDocument();
  });

  it("permite marcar foto, audio ou video para visualizacao unica", async () => {
    const user = userEvent.setup();
    const onAlternarVisualizacaoUnica = vi.fn();
    render(
      <AreaCentralChat
        {...baseProps}
        conversaAtiva={conversation}
        onAlternarVisualizacaoUnica={onAlternarVisualizacaoUnica}
        anexosPendentes={[
          {
            id: "attachment-image",
            arquivo: new Blob(["image"], { type: "image/jpeg" }),
            nomeArquivo: "foto.jpg",
            mimeType: "image/jpeg",
            tamanho: 5,
            tipo: "image",
            urlPreview: "blob:foto",
            viewOnce: false,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar foto.jpg para visualizar uma vez" }));
    expect(onAlternarVisualizacaoUnica).toHaveBeenCalledWith("attachment-image");
  });

  it("oculta midia view-once recebida e enviada atras de um placeholder 1x", () => {
    const viewOnceConversation: ChatConversa = {
      ...conversation,
      mensagens: [
        {
          id: "view-once-image",
          remetente: "contato",
          tipo: "midia",
          texto: "[Imagem]",
          arquivoUrl: "https://example.test/private-image.jpg",
          arquivoMime: "image/jpeg",
          nomeArquivo: "private-image.jpg",
          horario: "10:14",
          viewOnce: true,
        },
        {
          id: "view-once-audio",
          remetente: "usuario",
          tipo: "audio",
          texto: "[Audio]",
          arquivoUrl: "https://example.test/private-audio.ogg",
          arquivoMime: "audio/ogg",
          nomeArquivo: "private-audio.ogg",
          horario: "10:15",
          viewOnce: true,
        },
        {
          id: "view-once-video",
          remetente: "usuario",
          tipo: "midia",
          texto: "[Video]",
          arquivoUrl: "https://example.test/private-video.mp4",
          arquivoMime: "video/mp4",
          nomeArquivo: "private-video.mp4",
          horario: "10:16",
          viewOnce: true,
        },
      ],
    };

    const { container } = render(<AreaCentralChat {...baseProps} conversaAtiva={viewOnceConversation} />);

    expect(container.querySelector('[src*="private-"]')).not.toBeInTheDocument();
    expect(screen.getAllByText("1x")).toHaveLength(3);
  });
});
