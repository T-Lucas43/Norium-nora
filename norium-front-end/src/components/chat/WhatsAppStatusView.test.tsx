import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaApi = vi.hoisted(() => ({ apiBlobRequest: vi.fn(), apiRequest: vi.fn() }));
vi.mock("../../core/api/client", () => ({ apiBlobRequest: mediaApi.apiBlobRequest, apiRequest: mediaApi.apiRequest }));

import WhatsAppStatusView from "./WhatsAppStatusView";

const originalMediaDevices = navigator.mediaDevices;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function mediaProxyUrl(source: string) {
  return `/api/chat/media-proxy?url=${encodeURIComponent(source)}`;
}

describe("estado vazio do Status", () => {
  beforeEach(() => {
    let objectUrlIndex = 0;
    const NativeURL = URL;
    vi.stubGlobal("URL", class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => `blob:status-media-${++objectUrlIndex}`);
      static revokeObjectURL = vi.fn();
    });
    mediaApi.apiBlobRequest.mockResolvedValue(new Blob(["media"]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mediaApi.apiBlobRequest.mockReset();
    mediaApi.apiRequest.mockReset();
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


  it("agrupa as atualiza\u00e7\u00f5es por contato e usa a m\u00eddia mais recente como pr\u00e9via", async () => {
    const items = [
      { id: "maria-text", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "text" as const, text: "Primeiro", timestamp: 1 },
      { id: "maria-image", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "image" as const, mediaUrl: "https://example.test/maria-status.jpg", timestamp: 2 },
      { id: "joao-text", contactId: "5511888888888@s.whatsapp.net", name: "Jo\u00e3o", type: "text" as const, text: "Outro contato", timestamp: 3 },
    ];

    render(<WhatsAppStatusView items={items} selectedId={null} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /Maria/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Maria/ })).toHaveAccessibleName(/2 atualiza\u00e7\u00f5es/);
    expect(await screen.findByAltText("Pr\u00e9via do Status de Maria")).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(items[1].mediaUrl!), { cache: "default" });
  });

  it("agrupa por nome quando o contato n\u00e3o tem ID e indica v\u00eddeo e \u00e1udio", async () => {
    const items = [
      { id: "ana-video", name: "Ana", type: "video" as const, mediaUrl: "https://example.test/ana.mp4", timestamp: 1 },
      { id: "ana-text", name: "Ana", type: "text" as const, text: "Depois", timestamp: 4 },
      { id: "bia-audio", name: "Bia", type: "audio" as const, mediaUrl: "https://example.test/bia.ogg", timestamp: 3 },
      { id: "fallback-one", name: "", type: "text" as const, text: "Sem contato", timestamp: 2 },
      { id: "fallback-two", name: " ", type: "text" as const, text: "Outro sem contato", timestamp: 1 },
    ];

    const view = render(<WhatsAppStatusView items={items} selectedId={null} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /Ana/ })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Pr\u00e9via em v\u00eddeo do Status de Ana" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pr\u00e9via em \u00e1udio do Status de Bia" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /1 atualiza\u00e7\u00e3o/ })).toHaveLength(3);
    await waitFor(() => expect(view.container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(items[0].mediaUrl!), { cache: "default" });
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(items[2].mediaUrl!), { cache: "default" });
  });

  it("renova uma foto de contato expirada uma unica vez pelo ID do Status", async () => {
    const contactId = "5511777777777@s.whatsapp.net";
    const expiredPhoto = "https://cdn.example/expired-status.jpg";
    const freshPhoto = "https://cdn.example/fresh-status.jpg";
    mediaApi.apiRequest.mockResolvedValue({ photoUrl: freshPhoto });
    const item = {
      id: "status-expired-photo",
      contactId,
      name: "Maria",
      photoUrl: expiredPhoto,
      type: "text" as const,
      text: "Foto vencida",
      timestamp: 1_800_000_000,
    };

    render(<WhatsAppStatusView items={[item]} selectedId={null} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    const row = screen.getByRole("button", { name: /Maria/ });
    await waitFor(() => expect(row.querySelector("img")?.getAttribute("src")).toMatch(/^blob:status-media-/));
    const expiredBlobUrl = row.querySelector("img")?.getAttribute("src");
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(expiredPhoto), { cache: "default" });
    fireEvent.error(row.querySelector("img") as HTMLImageElement);
    await waitFor(() => {
      const refreshedBlobUrl = row.querySelector("img")?.getAttribute("src");
      expect(refreshedBlobUrl).toMatch(/^blob:status-media-/);
      expect(refreshedBlobUrl).not.toBe(expiredBlobUrl);
    });
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(freshPhoto), { cache: "default" });
    fireEvent.error(row.querySelector("img") as HTMLImageElement);

    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(1));
    expect(mediaApi.apiRequest).toHaveBeenCalledWith(`/api/chat/foto-perfil?phone=${encodeURIComponent(contactId)}`, expect.any(Object));
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

  it("mantém a legenda sobreposta à própria mídia do Status", async () => {
    const item = { id: "media", contactId: "5511999999999@s.whatsapp.net", name: "Maria", type: "image" as const, text: "Legenda da foto", mediaUrl: "https://example.test/status.jpg", timestamp: 1 };
    render(<WhatsAppStatusView items={[item]} selectedId="media" onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    const image = await screen.findByAltText("Status de Maria");
    const caption = screen.getByText("Legenda da foto");
    expect(caption.tagName).toBe("FIGCAPTION");
    expect(image).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));
    expect(caption.closest("figure")?.querySelector("img")).toBe(image);
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(item.mediaUrl), { cache: "default" });
  });

  it("exibe imagens e áudios externos somente após baixá-los pelo proxy seguro", async () => {
    const image = { id: "external-image", name: "Maria", type: "image" as const, mediaUrl: "https://cdn.example/status.jpg", timestamp: 1 };
    const audio = { id: "external-audio", name: "João", type: "audio" as const, mediaUrl: "https://cdn.example/status.ogg", timestamp: 2 };
    const view = render(<WhatsAppStatusView items={[image, audio]} selectedId={image.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(await screen.findByAltText("Status de Maria")).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(image.mediaUrl), { cache: "default" });

    view.rerender(<WhatsAppStatusView items={[image, audio]} selectedId={audio.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);
    await waitFor(() => expect(view.container.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(audio.mediaUrl), { cache: "default" });
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
      mediaUrl: "https://cdn.example/media-error.mp4",
      timestamp: 1,
    };

    render(<WhatsAppStatusView items={[item]} selectedId={item.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);

    expect(await screen.findByText("Mídia do Status indisponível")).toBeInTheDocument();
    expect(screen.getByText(/reconhecida como vídeo/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Tentar novamente" });
    const callsBeforeRetry = mediaApi.apiBlobRequest.mock.calls.length;
    await user.click(retry);
    await waitFor(() => expect(mediaApi.apiBlobRequest).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    expect(mediaApi.apiBlobRequest).toHaveBeenLastCalledWith(mediaProxyUrl(item.mediaUrl), { cache: "default" });
  });

  it("descarta a mídia anterior ao trocar de Status e permite repetir uma URL externa pelo proxy", async () => {
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

    const firstImage = await screen.findByAltText("Status de Maria");
    expect(firstImage).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(first.mediaUrl), { cache: "default" });
    fireEvent.error(firstImage);
    expect(await screen.findByText("Mídia do Status indisponível")).toBeInTheDocument();
    const callsBeforeRetry = mediaApi.apiBlobRequest.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(mediaApi.apiBlobRequest).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    expect(await screen.findByAltText("Status de Maria")).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));

    view.rerender(<WhatsAppStatusView items={[first, second]} selectedId={second.id} onSelect={vi.fn()} onRefresh={vi.fn()} onCreateUnavailable={vi.fn()} />);
    expect(await screen.findByAltText("Status de João")).toHaveAttribute("src", expect.stringMatching(/^blob:status-media-/));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(mediaProxyUrl(second.mediaUrl), { cache: "default" });
    expect(screen.queryByText("Mídia do Status indisponível")).not.toBeInTheDocument();
  });
});
