import { render, screen, waitFor } from "@testing-library/react";
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

vi.mock("./whatsappApi", () => ({ whatsappApi: api }));
vi.mock("./AreaCentralChat", () => ({ default: () => <div>Conversa</div> }));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("status do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    await user.click(await screen.findByRole("button", { name: /^Status/ }));
    await user.click(await screen.findByRole("button", { name: /Maria/ }));

    expect(api.statuses).toHaveBeenCalled();
    expect(api.markStatusViewed).toHaveBeenCalledWith("status-1");
    expect(await screen.findByText("Bom dia")).toBeInTheDocument();
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
