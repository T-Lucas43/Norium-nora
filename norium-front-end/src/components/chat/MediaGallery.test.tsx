import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MediaGallery from "./MediaGallery";
import type { ChatConversa } from "./types";
import { useAuthenticatedMediaState } from "./useAuthenticatedMedia";
vi.mock("./useAuthenticatedMedia", () => ({
  useAuthenticatedMedia: vi.fn((source?: string) => source || ""),
  useAuthenticatedMediaState: vi.fn((source?: string) => ({ source: source || "", loading: false, error: null, retry: vi.fn() })),
}));
const conversation = { id: "synthetic-conversation", contato: "Contato sintético", mensagens: [
  { id: "a", tipo: "midia", arquivoUrl: "/api/chat/midia/a", miniaturaUrl: "/api/chat/miniatura/a", horario: "10:00", texto: "Imagem A", remetente: "contato" },
  { id: "secret", tipo: "midia", viewOnce: true, arquivoUrl: "/api/chat/midia/private", horario: "10:01", remetente: "contato" },
  { id: "b", tipo: "midia", arquivoUrl: "/api/chat/midia/b", horario: "10:02", remetente: "usuario" },
] } as ChatConversa;
describe("galeria autenticada", () => {
  it("abre somente a mídia selecionada e navega com teclado sem incluir visualização única", () => {
    const select = vi.fn(), close = vi.fn();
    render(<MediaGallery conversation={conversation} messageId="a" onSelect={select} onClose={close} onForward={vi.fn()} />);
    expect(useAuthenticatedMediaState).toHaveBeenLastCalledWith("/api/chat/midia/a");
    expect(screen.getByText(/1 de 2/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(select).toHaveBeenCalledWith("b");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("encaminha pelo fluxo existente e usa download autenticado", () => {
    const forward = vi.fn(), close = vi.fn();
    render(<MediaGallery conversation={conversation} messageId="a" onSelect={vi.fn()} onClose={close} onForward={forward} />);
    expect(screen.getByRole("link", { name: "Baixar mídia" })).toHaveAttribute("href", "/api/chat/midia/a");
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar mídia" }));
    expect(close).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith(["a"]);
  });
});
