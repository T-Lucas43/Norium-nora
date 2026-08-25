import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  channels: vi.fn(),
  history: vi.fn(),
  details: vi.fn(),
  markConversation: vi.fn(),
}));

vi.mock("./whatsappApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsappApi")>();
  return { ...actual, whatsappApi: api };
});
vi.mock("./AreaCentralChat", () => ({ default: () => <div>Conversa</div> }));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("canais do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue({ conectado: true, status: "conectado", numero: "5511999999999" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.profile.mockResolvedValue({ name: "Operador", phone: "5511999999999" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [] });
    api.channels.mockResolvedValue({
      items: [
        {
          id: "123456789@newsletter",
          name: "Noticias Norium",
          description: "Atualizacoes do produto",
          verified: true,
        },
      ],
    });
  });

  it("carrega e exibe os canais ao abrir a secao Canais", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    const channelsButton = await screen.findByRole("button", { name: "Canais" });
    const callsBeforeOpening = api.channels.mock.calls.length;

    await user.click(channelsButton);

    await waitFor(() => expect(api.channels.mock.calls.length).toBeGreaterThan(callsBeforeOpening));
    expect(await screen.findByText("Noticias Norium")).toBeInTheDocument();
  });

  it("descarta os canais do tenant anterior e recarrega ao trocar de usuario", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChatCentral userId="tenant-a" />);

    await user.click(await screen.findByRole("button", { name: "Canais" }));
    expect(await screen.findByText("Noticias Norium")).toBeInTheDocument();

    const callsBeforeTenantChange = api.channels.mock.calls.length;
    api.channels.mockResolvedValue({
      items: [
        {
          id: "tenant-b@newsletter",
          name: "Noticias Tenant B",
          description: "Catalogo exclusivo do tenant B",
          verified: false,
        },
      ],
    });

    rerender(<ChatCentral userId="tenant-b" />);

    await waitFor(() => expect(screen.queryByText("Noticias Norium")).not.toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: "Canais" }));

    expect(screen.queryByText("Noticias Norium")).not.toBeInTheDocument();
    await waitFor(() => expect(api.channels.mock.calls.length).toBeGreaterThan(callsBeforeTenantChange));
    expect(await screen.findByText("Noticias Tenant B")).toBeInTheDocument();
  });

  it("rele os canais quando a sincronizacao passa de syncing para complete", async () => {
    vi.useFakeTimers();
    let syncComplete = false;
    try {
      api.syncStatus.mockImplementation(() => Promise.resolve(
        syncComplete ? { status: "complete", progress: 100 } : { status: "syncing", progress: 50 },
      ));
      api.channels
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValue({
          items: [
            {
              id: "sincronizado@newsletter",
              name: "Canal sincronizado",
              description: "Disponivel depois da sincronizacao",
              verified: true,
            },
          ],
        });

      render(<ChatCentral />);

      await act(async () => {
        await Promise.resolve();
      });
      expect(api.syncStatus).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Canais" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Nenhum canal dispon/)).toBeInTheDocument();
      const callsBeforeSyncCompletion = api.channels.mock.calls.length;

      syncComplete = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      expect(api.syncStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(api.channels.mock.calls.length).toBeGreaterThan(callsBeforeSyncCompletion);
      expect(screen.getByText("Canal sincronizado")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
