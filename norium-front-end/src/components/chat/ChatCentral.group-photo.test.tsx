import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DirectoryProps = {
  mode: "contacts" | "groups";
  groups: Array<{ photoUrl?: string }>;
};

const GROUP_PHOTO_URL = "https://cdn.example/group-photo.jpg";
const directoryRender = vi.hoisted(() => vi.fn());
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
vi.mock("./WhatsAppDirectory", () => ({
  default: (props: DirectoryProps) => {
    directoryRender(props);
    return <div>Diretorio de grupos</div>;
  },
}));
vi.mock("./AreaCentralChat", () => ({ default: () => <div>Conversa</div> }));
vi.mock("./PainelDireito", () => ({ default: () => null }));

import ChatCentral from "./ChatCentral";

describe("foto dos grupos do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue({ conectado: true, status: "conectado", numero: "5511999999999" });
    api.conversations.mockResolvedValue([]);
    api.contacts.mockResolvedValue([]);
    api.groups.mockResolvedValue({
      items: [
        {
          id: "120363000000000000@g.us",
          subject: "Grupo Norium",
          profilePicUrl: GROUP_PHOTO_URL,
          participants: [],
        },
      ],
    });
    api.profile.mockResolvedValue({ name: "Operador", phone: "5511999999999" });
    api.startSync.mockResolvedValue({ status: "complete", progress: 100 });
    api.syncStatus.mockResolvedValue({ status: "complete", progress: 100 });
    api.statuses.mockResolvedValue({ items: [] });
    api.channels.mockResolvedValue({ items: [] });
  });

  it("repassa profilePicUrl como photoUrl ao abrir a secao Grupos", async () => {
    const user = userEvent.setup();
    render(<ChatCentral />);

    await waitFor(() => expect(api.groups).toHaveBeenCalled());
    await user.click(await screen.findByLabelText("Grupos"));

    await waitFor(() => {
      const props = [...directoryRender.mock.calls]
        .reverse()
        .find(([candidate]) => candidate.mode === "groups")?.[0] as DirectoryProps | undefined;
      expect(props?.groups[0]?.photoUrl).toBe(GROUP_PHOTO_URL);
    });
  });
});
