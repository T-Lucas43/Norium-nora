import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mediaApi = vi.hoisted(() => ({ apiBlobRequest: vi.fn() }));
vi.mock("../../core/api/client", () => ({ apiBlobRequest: mediaApi.apiBlobRequest }));

import WhatsAppStatusView from "./WhatsAppStatusView";

const originalMediaDevices = navigator.mediaDevices;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("estado vazio do Status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
  });
  it("explica a ausência de eventos da integração e permite atualizar", () => {
    render(
      <WhatsAppStatusView
        items={[]}
        selectedId={null}
        sync={{ status: "error", progress: 4, message: "Falha ao sincronizar contatos" }}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCreateUnavailable={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/A W-API não disponibilizou Status recentes/)).toHaveLength(2);
    expect(screen.getByText(/continuará aguardando novos Status/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar Status" })).toBeInTheDocument();
  });

  it("navega por botões e gesto lateral e envia resposta de texto", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onReplyText = vi.fn().mockResolvedValue(undefined);
    const items = [
      { id: "one", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "text" as const, text: "Primeiro", timestamp: 1 },
      { id: "two", contactId: "5511888888888@s.whatsapp.net", name: "João", type: "text" as const, text: "Segundo", timestamp: 2 },
    ];
    render(<WhatsAppStatusView items={items} selectedId="one" onSelect={onSelect} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} onReplyText={onReplyText} />);

    await user.click(screen.getByRole("button", { name: "Próximo Status" }));
    expect(onSelect).toHaveBeenCalledWith(items[1]);

    fireEvent.pointerDown(screen.getByTestId("status-swipe-area"), { clientX: 240 });
    fireEvent.pointerUp(screen.getByTestId("status-swipe-area"), { clientX: 120 });
    expect(onSelect).toHaveBeenLastCalledWith(items[1]);

    await user.type(screen.getByPlaceholderText("Responder ao Status de Maria"), "Obrigado!");
    await user.click(screen.getByRole("button", { name: "Enviar resposta ao Status" }));
    await waitFor(() => expect(onReplyText).toHaveBeenCalledWith(items[0], "Obrigado!"));
  });

  it("bloqueia a navegação durante a gravação e envia o áudio somente ao Status selecionado", async () => {
    const onReplyAudio = vi.fn().mockResolvedValue(undefined);
    const onSelect = vi.fn();
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) } });

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: unknown, _options?: unknown) {}
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const item = { id: "one", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "text" as const, text: "Primeiro", timestamp: 1 };
    const nextItem = { id: "two", contactId: "5511888888888@s.whatsapp.net", name: "João", type: "text" as const, text: "Segundo", timestamp: 2 };
    const user = userEvent.setup();
    render(<WhatsAppStatusView items={[item, nextItem]} selectedId="one" onSelect={onSelect} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} onReplyAudio={onReplyAudio} />);

    await user.click(screen.getByRole("button", { name: "Responder com áudio" }));
    expect(screen.getByText(/finalize o áudio antes de mudar/i)).toBeInTheDocument();
    const nextButton = screen.getByRole("button", { name: "Próximo Status" });
    expect(nextButton).toBeDisabled();
    await user.click(nextButton);
    fireEvent.pointerDown(screen.getByTestId("status-swipe-area"), { clientX: 240 });
    fireEvent.pointerUp(screen.getByTestId("status-swipe-area"), { clientX: 120 });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Parar e enviar áudio" }));
    await waitFor(() => expect(onReplyAudio).toHaveBeenCalledWith(item, expect.any(Blob), "audio/webm"));
    expect(track.stop).toHaveBeenCalled();
  });

  it("bloqueia a troca de Status enquanto aguarda a permissão do microfone", async () => {
    const permission = deferred<{ getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> }>();
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockReturnValue(permission.promise) } });
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: unknown, _options?: unknown) {}
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const first = { id: "one", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "text" as const, text: "Primeiro", timestamp: 1 };
    const second = { id: "two", contactId: "5511888888888@s.whatsapp.net", name: "João", type: "text" as const, text: "Segundo", timestamp: 2 };
    const onSelect = vi.fn();
    const onReplyAudio = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<WhatsAppStatusView items={[first, second]} selectedId="one" onSelect={onSelect} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} onReplyAudio={onReplyAudio} />);

    await user.click(screen.getByRole("button", { name: "Responder com áudio" }));
    expect(screen.getByText(/solicitando acesso ao microfone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Próximo Status" })).toBeDisabled();
    fireEvent.pointerDown(screen.getByTestId("status-swipe-area"), { clientX: 240 });
    fireEvent.pointerUp(screen.getByTestId("status-swipe-area"), { clientX: 120 });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => { permission.resolve({ getTracks: () => [track] }); await permission.promise; });
    await user.click(await screen.findByRole("button", { name: "Parar e enviar áudio" }));
    await waitFor(() => expect(onReplyAudio).toHaveBeenCalledWith(first, expect.any(Blob), "audio/webm"));
    expect(onReplyAudio).not.toHaveBeenCalledWith(second, expect.anything(), expect.anything());
  });

  it("mantém a legenda sobreposta à própria mídia do Status", () => {
    const item = { id: "media", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "image" as const, text: "Legenda da foto", mediaUrl: "https://example.test/status.jpg", timestamp: 1 };
    render(<WhatsAppStatusView items={[item]} selectedId="media" onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    const caption = screen.getByText("Legenda da foto");
    expect(caption.tagName).toBe("FIGCAPTION");
    expect(caption.closest("figure")?.querySelector("img")).toHaveAttribute("alt", "Status de Maria");
  });

  it("mantém o estado de carregamento de uma mídia privada sem convertê-la em Status de texto", () => {
    mediaApi.apiBlobRequest.mockReturnValue(new Promise(() => {}));
    const item = {
      id: "media-loading",
      contactId: "5511999999999@s.whatsapp.net",
      name: "Maria",
      type: "image" as const,
      text: "Legenda que não é um Status de texto",
      mediaUrl: "/api/chat/midia/media-loading",
      timestamp: 1,
    };

    render(<WhatsAppStatusView items={[item]} selectedId={item.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Carregando mídia do Status...");
    expect(screen.queryByText(item.text)).not.toBeInTheDocument();
  });

  it("mostra a falha e permite tentar a mídia novamente sem convertê-la em Status de texto", async () => {
    const user = userEvent.setup();
    mediaApi.apiBlobRequest.mockRejectedValue(new Error("arquivo indisponível"));
    const item = {
      id: "media-error",
      contactId: "5511999999999@s.whatsapp.net",
      name: "Maria",
      type: "video" as const,
      text: "Legenda do vídeo indisponível",
      mediaUrl: "/api/chat/midia/media-error",
      timestamp: 1,
    };

    render(<WhatsAppStatusView items={[item]} selectedId={item.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(await screen.findByText("Mídia do Status indisponível")).toBeInTheDocument();
    expect(screen.getByText(/reconhecida como vídeo/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Tentar novamente" });
    await user.click(retry);
    await waitFor(() => expect(mediaApi.apiBlobRequest).toHaveBeenCalledTimes(2));
  });

  it("descarta a mídia anterior ao trocar de Status e permite repetir uma URL pública", async () => {
    const user = userEvent.setup();
    const first = {
      id: "first-image",
      contactId: "5511999999999@s.whatsapp.net",
      name: "Maria",
      type: "image" as const,
      mediaUrl: "https://example.test/first.jpg",
      timestamp: 1,
    };
    const second = {
      id: "second-image",
      contactId: "5511888888888@s.whatsapp.net",
      name: "João",
      type: "image" as const,
      mediaUrl: "https://example.test/second.jpg",
      timestamp: 2,
    };
    const view = render(<WhatsAppStatusView items={[first, second]} selectedId={first.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    fireEvent.error(screen.getByAltText("Status de Maria"));
    expect(screen.getByText("Mídia do Status indisponível")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(screen.getByAltText("Status de Maria")).toHaveAttribute("src", first.mediaUrl);

    view.rerender(<WhatsAppStatusView items={[first, second]} selectedId={second.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);
    expect(screen.getByAltText("Status de João")).toHaveAttribute("src", second.mediaUrl);
    expect(screen.queryByText("Mídia do Status indisponível")).not.toBeInTheDocument();
  });
});
