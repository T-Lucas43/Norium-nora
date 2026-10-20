import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  apiBlobRequest: vi.fn(),
}));
vi.mock("../../core/api/client", () => api);
vi.mock("../commercial/PdfDocumentPreview", () => ({
  default: ({ title }: { title: string }) => <div>Prévia de {title}</div>,
}));
vi.mock("../shared/AppDialogProvider", () => ({
  showConfirm: vi.fn().mockResolvedValue(true),
}));
import ClientsDashboard from "./ClientsDashboard";
import { gmailUrl, whatsappUrl } from "./clientModel";
const client = {
  id: "client-1",
  name: "Marina Costa",
  company: "Estúdio Aurora",
  document: "",
  email: "marina+projetos@example.com",
  phone: "(11) 99999-0000",
  segment: "Design",
  status: "active",
  stage: "won",
  ownerName: "Lucas",
  nextActionAt: "2026-09-10T14:00",
  tags: ["Design"],
  notes: "Projeto de identidade visual.",
  updatedAt: "2026-09-08T12:00:00Z",
  attachmentCount: 0,
  createdBy: "owner",
  createdByName: "Lucas",
  accessRole: "owner",
  access: { teamPermission: "none", people: [] },
};

describe("Client workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:client-file"),
        revokeObjectURL: vi.fn(),
      }),
    );
    api.apiBlobRequest.mockResolvedValue(
      new Blob(["pdf"], { type: "application/pdf" }),
    );
    api.apiRequest.mockImplementation(
      async (path: string, options?: { method?: string; body?: string }) => {
        if (path === "/api/clientes?archived=all") return { items: [client] };
        if (path === "/api/business/client-views") return { items: [], canShare: false };
        if (path === "/api/business/tags?scope=client") return { items: [] };
        if (path === "/api/business/tags/client/client-1") return { items: [] };
        if (path === "/api/business/clients/client-1/relations?offset=0&limit=25") return { items: [], total: 0, nextOffset: null };
        if (path === "/api/team-chat/members")
          return {
            members: [
              { id: "owner", nome: "Lucas", email: "lucas@example.com", status: "ativo" },
              { id: "member", nome: "Fernanda", email: "fernanda@example.com", status: "ativo" },
            ],
          };
        if (path.endsWith("/access") && options?.method === "PUT")
          return {
            item: {
              ...client,
              access: JSON.parse(options.body || "{}"),
            },
          };
        if (path.endsWith("/files") && options?.method === "POST")
          return {
            item: {
              id: "file-1",
              fileName: "proposta.pdf",
              mimeType: "application/pdf",
              size: 100,
              createdAt: "2026-09-08",
              url: "/api/clientes/client-1/files/file-1",
            },
          };
        if (path.endsWith("/files")) return { items: [] };
        if (path.endsWith("/contracts"))
          return {
            items: [
              {
                id: "contract-1",
                title: "Contrato de design",
                status: "draft",
                updatedAt: "2026-09-08",
                linked: false,
                primary: false,
                client: { name: "Estúdio Aurora" },
              },
            ],
          };
        if (options?.method === "PATCH")
          return { item: { ...client, ...JSON.parse(options.body || "{}") } };
        return { ok: true };
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  it("starts without a selection and loads expensive tabs only on demand", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await user.click(
      await screen.findByRole("button", { name: /Marina Costa/ }),
    );
    expect(screen.getByRole("link", { name: /Abrir Gmail/ })).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/u/0/?view=cm&fs=1&to=marina%2Bprojetos%40example.com",
    );
    expect(
      screen.getByRole("link", { name: /Abrir WhatsApp/ }),
    ).toHaveAttribute("href", "https://wa.me/5511999990000");
    expect(api.apiRequest.mock.calls.filter(([path]) => path === "/api/clientes?archived=all")).toHaveLength(1);
    expect(api.apiRequest.mock.calls.some(([path]) => /\/(files|contracts|360)$/.test(path))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Clientes" }));
    expect(
      screen.getByRole("region", { name: "Lista de clientes" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Ficha do cliente" }),
    ).not.toBeInTheDocument();
  });
  it("searches phone numbers and filters client statuses", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await screen.findByRole("button", { name: /Marina Costa/ });
    await user.type(
      screen.getByRole("textbox", { name: "Buscar clientes" }),
      "99999",
    );
    expect(
      screen.getByRole("button", { name: /Marina Costa/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inativos" }));
    expect(screen.getByText("Nenhum resultado")).toBeInTheDocument();
  });
  it("abre a Nora com o contexto visível do cliente selecionado", async () => {
    const onOpenNora = vi.fn();
    const user = userEvent.setup();
    render(<ClientsDashboard onOpenNora={onOpenNora} />);
    await user.click(await screen.findByRole("button", { name: /Marina Costa/ }));
    await user.click(screen.getByRole("button", { name: "Resumo 360°" }));
    expect(onOpenNora).toHaveBeenCalledWith(expect.stringContaining("Marina Costa"));
    expect(onOpenNora).toHaveBeenCalledWith(expect.stringContaining("Estúdio Aurora"));
    expect(onOpenNora).toHaveBeenCalledWith(expect.stringContaining("Não invente histórico"));
  });
  it("links an existing contract and opens the exact document", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await user.click(
      await screen.findByRole("button", { name: /Marina Costa/ }),
    );
    await user.click(screen.getByRole("tab", { name: "Contratos" }));
    await user.click(
      await screen.findByRole("button", { name: "Vincular contrato" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Contrato de design/ }),
    );
    await waitFor(() =>
      expect(api.apiRequest).toHaveBeenCalledWith(
        "/api/clientes/client-1/contracts/contract-1",
        { method: "PUT" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    expect(JSON.parse(localStorage.getItem("norium-deep-link")!)).toEqual({
      tab: "Propostas",
      entityType: "contract",
      entityId: "contract-1",
    });
  });
  it("uploads and previews a document on the client page", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await user.click(
      await screen.findByRole("button", { name: /Marina Costa/ }),
    );
    await user.click(screen.getByRole("tab", { name: "Documentos" }));
    await user.upload(
      screen.getByLabelText("Anexar documento do cliente"),
      new File(["%PDF-1.7"], "proposta.pdf", { type: "application/pdf" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Visualizar proposta.pdf" }),
    );
    expect(
      await screen.findByText("Prévia de proposta.pdf"),
    ).toBeInTheDocument();
    expect(api.apiBlobRequest).toHaveBeenCalledWith(
      "/api/clientes/client-1/files/file-1",
    );
  });
  it("clears the next contact when the field is emptied", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await user.click(
      await screen.findByRole("button", { name: /Marina Costa/ }),
    );
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.clear(screen.getByLabelText("Próximo contato", { exact: true }));
    await user.click(screen.getByRole("button", { name: "Salvar cliente" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const update = api.apiRequest.mock.calls.find(
      (call) => call[1]?.method === "PATCH",
    );
    expect(JSON.parse(update?.[1].body)).toMatchObject({
      nextActionAt: null,
      name: "Marina Costa",
    });
  });

  it("shares a client with a specific team member", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await user.click(await screen.findByRole("button", { name: /Marina Costa/ }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(await screen.findByRole("dialog", { name: /Compartilhar “Marina Costa”/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver" }));
    await user.click(screen.getByRole("button", { name: "Salvar acesso" }));
    await waitFor(() =>
      expect(api.apiRequest).toHaveBeenCalledWith(
        "/api/clientes/client-1/access",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            teamPermission: "none",
            people: [{ userId: "member", permission: "view" }],
          }),
        }),
      ),
    );
  });

  it("keeps keyboard focus inside the editor and closes with Escape", async () => {
    const user = userEvent.setup();
    render(<ClientsDashboard />);
    await screen.findByRole("button", { name: /Marina Costa/ });
    await user.click(screen.getByRole("button", { name: "Novo cliente" }));
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
describe("Contact destinations", () => {
  it("preserves international codes and rejects invalid destinations", () => {
    expect(whatsappUrl("+1 (202) 555-0123")).toBe("https://wa.me/12025550123");
    expect(whatsappUrl("0044 20 7946 0123")).toBe("https://wa.me/442079460123");
    expect(whatsappUrl("123")).toBeNull();
    expect(gmailUrl("javascript:alert(1)")).toBeNull();
  });
});
