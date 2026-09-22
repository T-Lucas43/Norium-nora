import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  consentStatus: vi.fn(),
  acceptConsent: vi.fn(),
  start: vi.fn(),
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

describe("escolha de plano LITE/PRO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue({ conectado: false, status: "desconectado" });
    api.consentStatus.mockResolvedValue({ termVersion: "2026-08-22", accepted: true });
    api.start.mockResolvedValue({ status: "aguardando_qrcode", qrcode: "qr-code", plano: "pro" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.profile.mockResolvedValue({ name: "Operador" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [] });
    api.channels.mockResolvedValue({ items: [] });
  });

  it("exibe a escolha de plano antes de criar a instancia", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Conectar WhatsApp" }));

    expect(await screen.findByRole("heading", { name: "Escolha o plano da instância" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^LITE/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^PRO/ })).toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("envia o plano escolhido ao backend e mostra a instancia atual", async () => {
    api.start.mockResolvedValue({ status: "aguardando_qrcode", qrcode: "qr-code", plano: "lite" });
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Conectar WhatsApp" }));
    await user.click(await screen.findByRole("radio", { name: /^LITE/ }));
    await user.click(screen.getByRole("button", { name: "Continuar e gerar QR Code" }));

    await waitFor(() => expect(api.start).toHaveBeenCalledWith(undefined, "lite"));
    expect(await screen.findByText(/Instância atual: LITE/)).toBeInTheDocument();
  });

  it("pula a escolha quando ja existe instancia vinculada", async () => {
    api.status.mockResolvedValue({ conectado: false, status: "desconectado", plano: "pro" });
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Conectar WhatsApp" }));

    await waitFor(() => expect(api.start).toHaveBeenCalledWith(undefined, undefined));
    expect(screen.queryByRole("heading", { name: "Escolha o plano da instância" })).not.toBeInTheDocument();
    expect(await screen.findByText(/Instância atual: PRO/)).toBeInTheDocument();
  });

  it("avisa quando a instancia existente tem outro plano", async () => {
    api.start.mockResolvedValue({ status: "aguardando_qrcode", qrcode: "qr-code", plano: "pro" });
    const user = userEvent.setup();
    render(<ChatCentral />);

    await user.click(await screen.findByRole("button", { name: "Conectar WhatsApp" }));
    await user.click(await screen.findByRole("radio", { name: /^LITE/ }));
    await user.click(screen.getByRole("button", { name: "Continuar e gerar QR Code" }));

    expect(await screen.findByText(/Você escolheu LITE, mas a instância vinculada foi mantida/)).toBeInTheDocument();
  });
});
