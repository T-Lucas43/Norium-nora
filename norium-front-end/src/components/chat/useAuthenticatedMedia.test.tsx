import { render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaApi = vi.hoisted(() => ({ apiBlobRequest: vi.fn(), apiRequest: vi.fn() }));
vi.mock("../../core/api/client", () => ({
  apiBlobRequest: mediaApi.apiBlobRequest,
  apiRequest: mediaApi.apiRequest,
}));

import { useAuthenticatedMedia, useAuthenticatedMediaState } from "./useAuthenticatedMedia";
import { apiBaseUrl } from "../../core/api/config";

function proxyUrl(source: string) {
  return `/api/chat/media-proxy?url=${encodeURIComponent(source)}`;
}

function MediaHarness({ imageSource, audioSource }: { imageSource: string; audioSource: string }) {
  const image = useAuthenticatedMedia(imageSource);
  const audio = useAuthenticatedMedia(audioSource);
  return (
    <>
      <img src={image} alt="Imagem protegida" />
      <audio src={audio} aria-label="Audio protegido" controls />
    </>
  );
}

describe("useAuthenticatedMediaState", () => {
  beforeEach(() => {
    mediaApi.apiBlobRequest.mockReset();
    mediaApi.apiRequest.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.type}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it.each([
    "/api/chat/midia/message-relative",
    new URL("/api/chat/midia/message-absolute", window.location.origin).href,
  ])("baixa midia protegida relativa ou same-origin: %s", async (source) => {
    mediaApi.apiBlobRequest.mockResolvedValue(new Blob(["image"], { type: "image/png" }));

    const { result } = renderHook(() => useAuthenticatedMediaState(source));

    await waitFor(() => expect(result.current.source).toBe("blob:image/png"));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(source, { cache: "default" });
  });

  it("baixa pela mesma origem do proxy local com autenticação", async () => {
    const source = new URL("/api/chat/midia/message-backend", apiBaseUrl()).href;
    mediaApi.apiBlobRequest.mockResolvedValue(new Blob(["image"], { type: "image/png" }));

    const { result } = renderHook(() => useAuthenticatedMediaState(source));

    await waitFor(() => expect(result.current.source).toBe("blob:image/png"));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(
      source,
      { cache: "default" },
    );
  });

  it.each([
    "https://host-malicioso.example/api/chat/x",
    "https://localhost.evil.example/api/chat/x",
    "https://sub.host-malicioso.example/api/chat/x",
  ])("encaminha origem externa ao proxy sem autenticar o host: %s", async (source) => {
    mediaApi.apiBlobRequest.mockResolvedValue(new Blob(["image"], { type: "image/png" }));

    const { result } = renderHook(() => useAuthenticatedMediaState(source));

    await waitFor(() => expect(result.current.source).toBe("blob:image/png"));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(proxyUrl(source), { cache: "default" });
    expect(mediaApi.apiBlobRequest).not.toHaveBeenCalledWith(source, expect.anything());
  });

  it("rejeita URL invalida sem tentar uma requisicao autenticada", () => {
    const { result } = renderHook(() => useAuthenticatedMediaState("https://["));

    expect(result.current.source).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toMatch(/inválida/i);
    expect(mediaApi.apiBlobRequest).not.toHaveBeenCalled();
  });

  it.each([
    "blob:https://app.example/1234",
    "data:image/png;base64,aW1hZ2U=",
  ])("preserva fonte local %s", (source) => {
    const { result } = renderHook(() => useAuthenticatedMediaState(source));

    expect(result.current.source).toBe(source);
    expect(result.current.error).toBeNull();
    expect(mediaApi.apiBlobRequest).not.toHaveBeenCalled();
  });

  it("mantem a exibicao de imagens e audios externos por blobs vindos do proxy", async () => {
    const imageSource = "https://cdn.example/imagem.jpg";
    const audioSource = "https://cdn.example/audio.ogg";
    mediaApi.apiBlobRequest
      .mockResolvedValueOnce(new Blob(["image"], { type: "image/jpeg" }))
      .mockResolvedValueOnce(new Blob(["audio"], { type: "audio/ogg" }));

    const view = render(<MediaHarness imageSource={imageSource} audioSource={audioSource} />);

    await waitFor(() => {
      expect(view.getByRole("img", { name: "Imagem protegida" })).toHaveAttribute("src", "blob:image/jpeg");
      expect(view.getByLabelText("Audio protegido")).toHaveAttribute("src", "blob:audio/ogg");
    });
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(proxyUrl(imageSource), { cache: "default" });
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(proxyUrl(audioSource), { cache: "default" });
  });
});
