import { act, render, screen, waitFor } from "@testing-library/react";
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
  markStatusViewed: vi.fn(),
  history: vi.fn(),
  details: vi.fn(),
  markConversation: vi.fn(),
}));
const mediaApi = vi.hoisted(() => ({ apiBlobRequest: vi.fn(), apiRequest: vi.fn() }));

vi.mock("../../core/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/api/client")>();
  return { ...actual, apiBlobRequest: mediaApi.apiBlobRequest, apiRequest: mediaApi.apiRequest };
});

vi.mock("./whatsappApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsappApi")>();
  return { ...actual, whatsappApi: api };
});
vi.mock("./AreaCentralChat", () => ({ default: () => <div>Conversa</div> }));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("status do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:status-photo") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    mediaApi.apiBlobRequest.mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
    mediaApi.apiRequest.mockImplementation(async (path: string) =>
      path === "/api/business/tags?scope=contact" ? { items: [] } : {});
    api.status.mockResolvedValue({ conectado: true, status: "conectado", numero: "5511999999999" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.profile.mockResolvedValue({ name: "Tarcisio", phone: "5511999999999" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [{ id: "status-1", name: "Maria", type: "text", text: "Bom dia", timestamp: 1_800_000_000, viewed: "false", mine: "false" }] });
    api.markStatusViewed.mockResolvedValue({ status: "visualizado" });
  });

  it("usa o cache na montagem e so forca a sincronizacao por acao explicita", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    await waitFor(() => expect(api.conversations).toHaveBeenCalled());
    await waitFor(() => {
      expect(api.contacts).toHaveBeenCalled();
      expect(api.groups).toHaveBeenCalled();
      expect(api.profile).toHaveBeenCalled();
      expect(api.statuses).toHaveBeenCalled();
    });
    expect(api.conversations).toHaveBeenCalledWith(undefined, false);
    expect(api.startSync).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Sincronizar agora" }));

    await waitFor(() => expect(api.startSync).toHaveBeenCalledTimes(1));
  });

  it("mantem status fora das conversas e sincroniza a visualizacao", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    expect(await screen.findByRole("button", { name: "Status, 1 nao visualizados" })).toBeInTheDocument();
    const statusCallsBeforeOpening = api.statuses.mock.calls.length;
    await user.click(await screen.findByRole("button", { name: /^Status/ }));
    await waitFor(() => expect(api.statuses.mock.calls.length).toBeGreaterThan(statusCallsBeforeOpening));
    await user.click(await screen.findByRole("button", { name: /Maria/ }));

    expect(api.statuses).toHaveBeenCalled();
    expect(api.markStatusViewed).toHaveBeenCalledWith("status-1");
    expect(await screen.findByText("Bom dia")).toBeInTheDocument();
  });
  it("exibe a foto do contato quando o Status traz profilePicUrl aninhada", async () => {
    const user = userEvent.setup();
    const photoUrl = "https://cdn.example/maria-status.jpg";
    api.statuses.mockResolvedValue({
      items: [{
        id: "status-com-foto",
        contactId: "5511999999999@s.whatsapp.net",
        contactName: "Maria",
        contact: { profilePicUrl: photoUrl },
        type: "text",
        text: "Bom dia com foto",
        timestamp: 1_800_000_000,
      }],
    });

    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: /^Status/ }));
    const contactRow = await screen.findByRole("button", { name: /Maria/ });
    await waitFor(() => expect(contactRow.querySelector("img")).toHaveAttribute("src", "blob:status-photo"));
    expect(mediaApi.apiBlobRequest).toHaveBeenCalledWith(
      `/api/chat/media-proxy?url=${encodeURIComponent(photoUrl)}`,
      { cache: "default" },
    );
  });


  it("nao exibe timeout de atualizacoes automaticas como alerta para o usuario", async () => {
    render(<ChatCentral />);

    await waitFor(() => expect(api.conversations).toHaveBeenCalled());
    const previousCalls = api.conversations.mock.calls.length;
    api.conversations.mockRejectedValueOnce(new Error("A operacao demorou mais que o esperado."));

    window.dispatchEvent(new Event("norium:whatsapp-event"));

    await waitFor(() => expect(api.conversations.mock.calls.length).toBeGreaterThan(previousCalls));
    expect(screen.queryByText("A operacao demorou mais que o esperado.")).not.toBeInTheDocument();
  });

  it("ignora a resposta de Status do usuário anterior depois da troca", async () => {
    const user = userEvent.setup();
    let resolveOld!: (value: { items: unknown[] }) => void;
    api.statuses
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({
        items: [{ id: "status-new", name: "Contato novo", type: "text", text: "Feed novo", timestamp: 1_800_000_100 }],
      });
    const view = render(<ChatCentral userId="usuario-a" />);
    await waitFor(() => expect(api.statuses).toHaveBeenCalledTimes(1));

    view.rerender(<ChatCentral userId="usuario-b" />);
    await waitFor(() => expect(api.statuses.mock.calls.length).toBeGreaterThanOrEqual(2));
    await user.click(await screen.findByRole("button", { name: /^Status/ }));
    expect(await screen.findByRole("button", { name: /Contato novo/ })).toBeInTheDocument();

    await act(async () => {
      resolveOld({
        items: [{ id: "status-old", name: "Contato antigo", type: "text", text: "Feed antigo", timestamp: 1_800_000_000 }],
      });
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Contato antigo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Contato novo/ })).toBeInTheDocument();
  });

  it("trata sincronizacao parcial como terminal e recarrega o cache disponível", async () => {
    api.syncStatus.mockResolvedValue({
      status: "partial",
      progress: 99,
      message: "Catálogo carregado parcialmente.",
      warnings: ["Agenda PRO indisponível"],
    });

    render(<ChatCentral />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Catálogo carregado parcialmente.");
    expect(screen.getByRole("alert")).toHaveTextContent("Agenda PRO indisponível");
    await waitFor(() => expect(api.contacts.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("button", { name: "Sincronizar agora" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Atualizar novamente" })).toBeInTheDocument();
    const terminalPollCount = api.syncStatus.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 2_700));
    expect(api.syncStatus).toHaveBeenCalledTimes(terminalPollCount);
  });
});
