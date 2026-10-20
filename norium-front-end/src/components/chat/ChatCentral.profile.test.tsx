import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ status: vi.fn(), conversations: vi.fn(), contacts: vi.fn(), groups: vi.fn(), profile: vi.fn(), statuses: vi.fn(), syncStatus: vi.fn() }));
vi.mock("./whatsappApi", async (original) => ({ ...await original<typeof import("./whatsappApi")>(), whatsappApi: api }));
vi.mock("./SidebarEsquerda", () => ({ default: ({ conversas }: { conversas: { id: string; contato: string }[] }) => <div data-testid="catalog">{conversas.map(item => <span key={item.id}>{item.contato}</span>)}</div> }));
vi.mock("./AreaCentralChat", () => ({ default: () => null }));
vi.mock("./PainelDireito", () => ({ default: () => null }));
vi.mock("./WhatsAppRail", () => ({ default: ({ profile }: { profile?: { name: string } }) => <span data-testid="profile-name">{profile?.name || "Carregando"}</span> }));
import ChatCentral from "./ChatCentral";
describe("perfil WhatsApp por conta", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.status.mockResolvedValue({ conectado: true, status: "conectado" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.statuses.mockResolvedValue({ items: [] });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.profile.mockResolvedValue({ name: "Perfil B" });
  });
  it("descarta resposta antiga de perfil depois da troca de usuário", async () => {
    let resolveOld!: (value: { name: string }) => void;
    api.profile.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ name: "Perfil B" });
    const view = render(<ChatCentral userId="synthetic-a" />);
    await waitFor(() => expect(api.profile).toHaveBeenCalledTimes(1));
    view.rerender(<ChatCentral userId="synthetic-b" />);
    await waitFor(() => expect(screen.getByTestId("profile-name")).toHaveTextContent("Perfil B"));
    await act(async () => { resolveOld({ name: "Perfil A" }); await Promise.resolve(); });
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Perfil B");
  });
  it("inclui todos os grupos e descarta catálogo antigo depois da troca de usuário", async () => {
    let resolveOld!: (value: { items: unknown[] }) => void;
    api.groups.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ items: [{ id: "1203634000002@g.us", contato: "Grupo B", esGrupo: true, mensagens: [] }] });
    const view = render(<ChatCentral userId="synthetic-a" />);
    await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(1));
    view.rerender(<ChatCentral userId="synthetic-b" />);
    await waitFor(() => expect(screen.getByTestId("catalog")).toHaveTextContent("Grupo B"));
    await act(async () => {
      resolveOld({ items: [{ id: "1203634000001@g.us", contato: "Grupo A", esGrupo: true, mensagens: [] }] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("catalog")).toHaveTextContent("Grupo B");
    expect(screen.getByTestId("catalog")).not.toHaveTextContent("Grupo A");
  });
});
