import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ status: vi.fn(), conversations: vi.fn(), contacts: vi.fn(), groups: vi.fn(), profile: vi.fn(), statuses: vi.fn(), syncStatus: vi.fn() }));
vi.mock("./whatsappApi", async (original) => ({ ...await original<typeof import("./whatsappApi")>(), whatsappApi: api }));
vi.mock("./SidebarEsquerda", () => ({ default: () => null }));
vi.mock("./AreaCentralChat", () => ({ default: () => null }));
vi.mock("./PainelDireito", () => ({ default: () => null }));
vi.mock("./WhatsAppRail", () => ({ default: ({ profile }: { profile?: { name: string } }) => <span data-testid="profile-name">{profile?.name || "Carregando"}</span> }));
import ChatCentral from "./ChatCentral";
describe("perfil WhatsApp por conta", () => {
  it("descarta resposta antiga de perfil depois da troca de usuário", async () => {
    let resolveOld!: (value: { name: string }) => void;
    api.status.mockResolvedValue({ conectado: true, status: "conectado" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({ items: [] });
    api.statuses.mockResolvedValue({ items: [] });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.profile.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ name: "Perfil B" });
    const view = render(<ChatCentral userId="synthetic-a" />);
    await waitFor(() => expect(api.profile).toHaveBeenCalledTimes(1));
    view.rerender(<ChatCentral userId="synthetic-b" />);
    await waitFor(() => expect(screen.getByTestId("profile-name")).toHaveTextContent("Perfil B"));
    await act(async () => { resolveOld({ name: "Perfil A" }); await Promise.resolve(); });
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Perfil B");
  });
});
