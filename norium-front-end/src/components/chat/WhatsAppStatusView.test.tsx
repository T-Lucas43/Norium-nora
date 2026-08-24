import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
