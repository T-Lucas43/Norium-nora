import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  disconnect: vi.fn(),
}));

vi.mock("./whatsappApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsappApi")>();
  return { ...actual, whatsappApi: api };
});
vi.mock("./SidebarEsquerda", () => ({
  default: ({ onAbrirConfigPropria }: { onAbrirConfigPropria: () => void }) => (
    <button type="button" onClick={onAbrirConfigPropria}>Abrir configurações</button>
  ),
}));
vi.mock("./AreaCentralChat", () => ({ default: () => <div>Conversa</div> }));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("diálogo de configurações do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue({ conectado: true, status: "conectado" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.profile.mockResolvedValue({ name: "Operador" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [] });
    api.disconnect.mockResolvedValue({ status: "desconectado" });
  });

  it("expõe semântica de diálogo, contém o foco e fecha com Escape restaurando o gatilho", async () => {
    const user = userEvent.setup();
    render(<ChatCentral userId="usuario-acessibilidade" />);
    const trigger = await screen.findByRole("button", { name: "Abrir configurações" });
    trigger.focus();

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Configurações Gerais do Painel" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const closeButton = within(dialog).getByRole("button", { name: "Fechar configurações" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button", { name: "Fechar" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(closeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Configurações Gerais do Painel" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("ignora um QR antigo que chega depois da desconexão", async () => {
    const user = userEvent.setup();
    let statusPoll: (() => void) | undefined;
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 120_000 && typeof handler === "function" && handler.name === "checkConnection" && !statusPoll) statusPoll = handler as () => void;
      return 1;
    }) as typeof window.setInterval);

    let resolveStatusAntigo: ((value: { conectado: boolean; status: string; qrcode: string }) => void) | undefined;
    api.status
      .mockResolvedValueOnce({ conectado: true, status: "conectado" })
      .mockImplementationOnce(() => new Promise<{ conectado: boolean; status: string; qrcode: string }>((resolve) => {
        resolveStatusAntigo = resolve;
      }))
      .mockResolvedValue({
        conectado: false,
        status: "aguardando_qrcode",
        qrcode: "data:image/png;base64,antigo",
      });

    try {
      render(<ChatCentral userId="usuario-corrida-desconexao" />);
      const trigger = await screen.findByRole("button", { name: "Abrir configurações" });
      await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1));
      expect(statusPoll).toBeTypeOf("function");

      act(() => statusPoll?.());
      await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));

      await user.click(trigger);
      const settingsDialog = screen.getByRole("dialog", { name: "Configurações Gerais do Painel" });
      await user.click(within(settingsDialog).getByRole("button", { name: "Desconectar WhatsApp" }));
      const confirmationDialog = screen.getByRole("alertdialog", { name: "Desconectar WhatsApp?" });
      await user.click(within(confirmationDialog).getByRole("button", { name: "Desconectar" }));
      await waitFor(() => expect(api.disconnect).toHaveBeenCalledTimes(1));
      await screen.findByRole("button", { name: "Conectar WhatsApp" });

      await act(async () => {
        resolveStatusAntigo?.({
          conectado: false,
          status: "aguardando_qrcode",
          qrcode: "data:image/png;base64,antigo",
        });
      });

      await waitFor(() => expect(screen.getByRole("button", { name: "Conectar WhatsApp" })).toBeInTheDocument());
      expect(screen.queryByRole("img", { name: "QR Code para conectar o WhatsApp ao Norium" })).not.toBeInTheDocument();
    } finally {
      intervalSpy.mockRestore();
    }
  });
});
