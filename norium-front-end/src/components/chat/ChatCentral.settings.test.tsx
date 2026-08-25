import { render, screen, waitFor, within } from "@testing-library/react";
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
});
