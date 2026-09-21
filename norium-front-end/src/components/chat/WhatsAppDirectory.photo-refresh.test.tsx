import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaApi = vi.hoisted(() => ({ apiBlobRequest: vi.fn(), apiRequest: vi.fn() }));
vi.mock("../../core/api/client", () => ({ apiBlobRequest: mediaApi.apiBlobRequest, apiRequest: mediaApi.apiRequest }));

import WhatsAppDirectory from "./WhatsAppDirectory";
import { useWhatsAppProfilePhoto } from "./useAuthenticatedMedia";

function proxiedSource(requestUrl: string) {
  return new URL(requestUrl, window.location.origin).searchParams.get("url") || "unknown";
}

function blobUrl(source: string) {
  return `blob:${encodeURIComponent(source)}`;
}

function ProfilePhotoProbe({
  identifier,
  initialSource,
  onSource,
}: {
  identifier: string;
  initialSource?: string;
  onSource: (source: string) => void;
}) {
  const photo = useWhatsAppProfilePhoto(identifier, initialSource);
  onSource(photo.source);
  return photo.source ? <img alt="foto renovada" src={photo.source} onError={photo.onError} /> : null;
}

describe("renovacao de fotos de grupos", () => {
  beforeEach(() => {
    mediaApi.apiBlobRequest.mockReset();
    mediaApi.apiRequest.mockReset();
    mediaApi.apiBlobRequest.mockImplementation(async (requestUrl: string) => ({ requestUrl } as unknown as Blob));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob & { requestUrl?: string }) => blobUrl(proxiedSource(blob.requestUrl || ""))),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    window.localStorage.removeItem("norium-auth-token");
    window.sessionStorage.removeItem("norium-auth-token");
    window.localStorage.removeItem("norium-workspace-id");
  });

  afterEach(() => {
    window.localStorage.removeItem("norium-auth-token");
    window.sessionStorage.removeItem("norium-auth-token");
    window.localStorage.removeItem("norium-workspace-id");
  });
  it("busca uma foto ausente uma unica vez para avatares simultaneos do mesmo grupo", async () => {
    const groupId = "120363000000000777@g.us";
    const freshPhoto = "https://cdn.example/fresh-group.jpg";
    let resolvePhoto!: (value: { photoUrl: string }) => void;
    mediaApi.apiRequest.mockReturnValue(new Promise((resolve) => { resolvePhoto = resolve; }));
    const group = {
      id: groupId,
      contato: "Equipe",
      canal: "whatsapp" as const,
      channel: "whatsapp" as const,
      ultimoTexto: "Oi",
      timestampUltimaMsg: 0,
      horario: "10:00",
      lida: true,
      esGrupo: true,
      mensagens: [],
      metadados: { numeroCompleto: groupId, statusOnline: false, participantes: [] },
    };
    const props = {
      mode: "groups" as const,
      contacts: [],
      groups: [group],
      onOpenContact: vi.fn(),
      onOpenGroup: vi.fn(),
      onCreateGroup: vi.fn(),
      onRefresh: vi.fn(),
    };

    const first = render(<WhatsAppDirectory {...props} />);
    const second = render(<WhatsAppDirectory {...props} />);

    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(1));
    expect(mediaApi.apiRequest).toHaveBeenCalledWith(`/api/chat/foto-perfil?phone=${encodeURIComponent(groupId)}`, expect.any(Object));
    resolvePhoto({ photoUrl: freshPhoto });
    await waitFor(() => {
      expect(first.container.querySelector("img")).toHaveAttribute("src", blobUrl(freshPhoto));
      expect(second.container.querySelector("img")).toHaveAttribute("src", blobUrl(freshPhoto));
    });
  });
  it("não compartilha uma busca em voo entre tokens ou workspaces", async () => {
    const groupId = "120363000000000778@g.us";
    const resolvers: Array<(value: { photoUrl: string }) => void> = [];
    mediaApi.apiRequest.mockImplementation(() => new Promise<{ photoUrl: string }>((resolve) => {
      resolvers.push(resolve);
    }));
    const group = {
      id: groupId,
      contato: "Equipe isolada",
      canal: "whatsapp" as const,
      channel: "whatsapp" as const,
      ultimoTexto: "Oi",
      timestampUltimaMsg: 0,
      horario: "10:00",
      lida: true,
      esGrupo: true,
      mensagens: [],
      metadados: { numeroCompleto: groupId, statusOnline: false, participantes: [] },
    };
    const props = {
      mode: "groups" as const,
      contacts: [],
      groups: [group],
      onOpenContact: vi.fn(),
      onOpenGroup: vi.fn(),
      onCreateGroup: vi.fn(),
      onRefresh: vi.fn(),
    };

    window.sessionStorage.setItem("norium-auth-token", "token-a");
    window.localStorage.setItem("norium-workspace-id", "workspace-a");
    render(<WhatsAppDirectory {...props} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(1));

    window.sessionStorage.setItem("norium-auth-token", "token-b");
    render(<WhatsAppDirectory {...props} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(2));

    window.localStorage.setItem("norium-workspace-id", "workspace-b");
    render(<WhatsAppDirectory {...props} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolvers.forEach((resolve, index) => resolve({ photoUrl: `https://cdn.example/${index}.jpg` }));
      await Promise.resolve();
    });
  });

  it("não exibe a foto renovada do contato anterior ao reutilizar o componente", async () => {
    const freshA = "https://cdn.example/contact-a.jpg";
    let resolveB!: (value: { photoUrl: string }) => void;
    mediaApi.apiRequest
      .mockResolvedValueOnce({ photoUrl: freshA })
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    const observedSources: string[] = [];
    const view = render(<ProfilePhotoProbe identifier="contact-a" onSource={(source) => observedSources.push(source)} />);
    await waitFor(() => expect(view.getByRole("img", { name: "foto renovada" })).toHaveAttribute("src", blobUrl(freshA)));

    observedSources.length = 0;
    view.rerender(<ProfilePhotoProbe identifier="contact-b" onSource={(source) => observedSources.push(source)} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(2));
    expect(observedSources).not.toContain(freshA);
    expect(view.queryByRole("img", { name: "foto renovada" })).not.toBeInTheDocument();

    await act(async () => {
      resolveB({ photoUrl: "https://cdn.example/contact-b.jpg" });
      await Promise.resolve();
    });
  });

  it("não reutiliza a foto do mesmo ID depois de uma troca de sessão", async () => {
    const freshA = "https://cdn.example/session-a.jpg";
    let resolveB!: (value: { photoUrl: string }) => void;
    mediaApi.apiRequest
      .mockResolvedValueOnce({ photoUrl: freshA })
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    const observedSources: string[] = [];
    window.sessionStorage.setItem("norium-auth-token", "token-a");
    const view = render(<ProfilePhotoProbe identifier="same-contact" onSource={(source) => observedSources.push(source)} />);
    await waitFor(() => expect(view.getByRole("img", { name: "foto renovada" })).toHaveAttribute("src", blobUrl(freshA)));

    observedSources.length = 0;
    window.sessionStorage.setItem("norium-auth-token", "token-b");
    view.rerender(<ProfilePhotoProbe identifier="same-contact" onSource={(source) => observedSources.push(source)} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(2));
    expect(observedSources).not.toContain(freshA);
    expect(view.queryByRole("img", { name: "foto renovada" })).not.toBeInTheDocument();

    await act(async () => {
      resolveB({ photoUrl: "https://cdn.example/session-b.jpg" });
      await Promise.resolve();
    });
  });
  it("ignora uma renovação antiga que termina depois da foto da entrada nova", async () => {
    const staleA = "https://cdn.example/stale-a.jpg";
    const freshA = "https://cdn.example/fresh-a.jpg";
    const freshB = "https://cdn.example/fresh-b.jpg";
    let resolveA!: (value: { photoUrl: string }) => void;
    let resolveB!: (value: { photoUrl: string }) => void;
    mediaApi.apiRequest.mockImplementation((path: string) => {
      if (path.includes("contact-a")) return new Promise((resolve) => { resolveA = resolve; });
      return new Promise((resolve) => { resolveB = resolve; });
    });
    const view = render(
      <ProfilePhotoProbe identifier="contact-a" initialSource={staleA} onSource={() => undefined} />,
    );
    await waitFor(() => expect(view.getByRole("img", { name: "foto renovada" })).toHaveAttribute("src", blobUrl(staleA)));
    fireEvent.error(view.getByRole("img", { name: "foto renovada" }));
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(1));

    view.rerender(<ProfilePhotoProbe identifier="contact-b" onSource={() => undefined} />);
    await waitFor(() => expect(mediaApi.apiRequest).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveB({ photoUrl: freshB });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("img", { name: "foto renovada" })).toHaveAttribute("src", blobUrl(freshB)));

    await act(async () => {
      resolveA({ photoUrl: freshA });
      await Promise.resolve();
    });
    expect(view.getByRole("img", { name: "foto renovada" })).toHaveAttribute("src", blobUrl(freshB));
  });
});
