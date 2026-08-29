import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  conversations: vi.fn(),
  contacts: vi.fn(),
  groups: vi.fn(),
  profile: vi.fn(),
  startSync: vi.fn(),
  syncStatus: vi.fn(),
  statuses: vi.fn(),
  history: vi.fn(),
  details: vi.fn(),
  markConversation: vi.fn(),
  sendMedia: vi.fn(),
  sendText: vi.fn(),
}));
const mediaClient = vi.hoisted(() => ({ apiBlobRequest: vi.fn() }));

vi.mock("../../core/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/api/client")>();
  return { ...actual, apiBlobRequest: mediaClient.apiBlobRequest };
});

vi.mock("./whatsappApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsappApi")>();
  return { ...actual, whatsappApi: api };
});

vi.mock("./SidebarEsquerda", () => ({
  default: (props: { conversas: Array<{ id: string; contato: string }>; onSelecionar: (id: string) => void }) => (
    <button type="button" onClick={() => props.onSelecionar(props.conversas[0].id)}>Abrir conversa de Maria</button>
  ),
}));

vi.mock("./AreaCentralChat", () => ({
  default: (props: {
    anexosPendentes: Array<{ id: string }>;
    figurinhasRecentes: Array<{ id: string }>;
    onColarAnexos: (files: File[]) => void;
    onAlternarVisualizacaoUnica: (id: string) => void;
    onEnviar: (text: string) => void | Promise<void>;
    onEnviarFigurinhaExistente: (sticker: { id: string }) => void | Promise<void>;
  }) => (
    <div>
      <button type="button" onClick={() => props.onColarAnexos([new File(["photo"], "foto.jpg", { type: "image/jpeg" })])}>Adicionar foto</button>
      {props.anexosPendentes[0] && <button type="button" onClick={() => props.onAlternarVisualizacaoUnica(props.anexosPendentes[0].id)}>Ativar visualizacao unica</button>}
      <button type="button" onClick={() => void props.onEnviar("")}>Enviar anexos</button>
      {props.figurinhasRecentes[0] && (
        <button type="button" onClick={() => void props.onEnviarFigurinhaExistente(props.figurinhasRecentes[0])}>
          Reenviar figurinha
        </button>
      )}
    </div>
  ),
}));

vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

const conversation = {
  id: "5511999999999@s.whatsapp.net",
  contato: "Maria",
  canal: "whatsapp" as const,
  ultimoTexto: "Ola",
  horario: "10:00",
  timestampUltimaMsg: 1,
  lida: true,
  mensagens: [{ id: "one", remetente: "contato" as const, tipo: "texto" as const, texto: "Ola", horario: "10:00" }],
  metadados: { numeroCompleto: "5511999999999@s.whatsapp.net", statusOnline: false },
};

describe("midia em visualizacao unica", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:foto") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    mediaClient.apiBlobRequest.mockResolvedValue(new Blob(["sticker"], { type: "image/webp" }));
    api.status.mockResolvedValue({ conectado: true, status: "conectado", numero: "5511999999999" });
    api.conversations.mockResolvedValue([conversation]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.profile.mockResolvedValue({ name: "Tarcisio", phone: "5511999999999" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [] });
    api.history.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    api.details.mockResolvedValue(conversation);
    api.markConversation.mockResolvedValue({ status: "sucesso" });
    api.sendMedia.mockResolvedValue({ status: "enviado_real" });
    api.sendText.mockResolvedValue({ status: "enviado_real" });
  });

  it("envia a escolha 1x do cartao junto com o arquivo", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Abrir conversa de Maria" }));
    await user.click(screen.getByRole("button", { name: "Adicionar foto" }));
    await user.click(await screen.findByRole("button", { name: "Ativar visualizacao unica" }));
    await user.click(screen.getByRole("button", { name: "Enviar anexos" }));

    await waitFor(() => expect(api.sendMedia).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.id,
      fileName: "foto.jpg",
      viewOnce: true,
    })));
  });

  it("normaliza a URL absoluta do backend ao reenviar uma figurinha existente", async () => {
    const user = userEvent.setup();
    const stickerConversation = {
      ...conversation,
      mensagens: [
        ...conversation.mensagens,
        {
          id: "sticker-1",
          remetente: "contato" as const,
          tipo: "sticker" as const,
          texto: "[Figurinha]",
          horario: "10:01",
          timestamp: 2,
          arquivoUrl: "http://127.0.0.1:8000/api/chat/midia/sticker-1",
          arquivoMime: "image/webp",
          nomeArquivo: "sticker-1.webp",
        },
      ],
    };
    api.conversations.mockResolvedValue([stickerConversation]);
    api.details.mockResolvedValue(stickerConversation);
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Abrir conversa de Maria" }));
    await user.click(await screen.findByRole("button", { name: "Reenviar figurinha" }));

    await waitFor(() => expect(mediaClient.apiBlobRequest).toHaveBeenCalledWith(
      "/api/chat/midia/sticker-1",
      expect.objectContaining({ cache: "no-store" }),
    ));
    await waitFor(() => expect(api.sendMedia).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.id,
      asSticker: true,
      fileName: "sticker-1.webp",
    })));
  });
});
