import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBranding, type CommercialData, type CommercialProposal } from "../../features/commercial/types";
import { ownerPermissions, type AuthSession } from "../../types/auth";

const commercialApi = vi.hoisted(() => ({
  loadCommercialData: vi.fn(),
  loadProposal: vi.fn(),
  loadContract: vi.fn(),
}));
const clientApi = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("../../features/commercial/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/commercial/api")>();
  return { ...actual, ...commercialApi };
});

vi.mock("../../core/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/api/client")>();
  return { ...actual, apiRequest: clientApi.apiRequest };
});

vi.mock("./CommercialEditor", () => ({
  default: ({ document }: { document: CommercialProposal }) => <div>Editor aberto: {document.title}</div>,
}));

import CommercialDashboard from "./CommercialDashboard";

const session: AuthSession = {
  token: "token-test",
  availableModes: ["app"],
  user: {
    id: "user-test",
    nome: "Usuario teste",
    email: "teste@norium.local",
    role: "owner",
    plan: "individual",
    status: "ativo",
    systemAdmin: false,
    permissions: ownerPermissions,
  },
};

const proposal: CommercialProposal = {
  id: "proposal-1",
  clientId: "client-1",
  client: { id: "client-1", name: "Cliente Um", company: "Empresa", document: "", email: "cliente@empresa.local" },
  brainstormId: null,
  title: "Proposta sob demanda",
  contentHtml: "<p>Conteudo completo</p>",
  scopeSummary: "Escopo",
  amount: 1_000,
  currency: "BRL",
  validUntil: null,
  brandProfileId: null,
  branding: defaultBranding,
  signers: [],
  deliverables: [],
  metadata: {},
  status: "draft",
  approval: null,
  noraAnalysis: null,
  suggestions: [],
  version: 1,
  revisions: [],
  createdBy: "user-test",
  createdByName: "Usuario teste",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
};

const commercialData: CommercialData = {
  proposals: [{
    documentType: "proposal",
    id: proposal.id,
    client: proposal.client,
    brainstormId: null,
    contractId: undefined,
    title: proposal.title,
    amount: proposal.amount,
    currency: proposal.currency,
    status: proposal.status,
    updatedAt: proposal.updatedAt,
    primaryColor: defaultBranding.primaryColor,
  }],
  contracts: [],
  brandProfiles: [],
  templates: [],
  summary: {
    proposalCount: 1,
    draftCount: 1,
    reviewCount: 0,
    approvedCount: 0,
    contractCount: 0,
    signedCount: 0,
    planMode: "solo",
    requiresApproval: false,
    maxBrandProfiles: 1,
  },
};

describe("CommercialDashboard leve", () => {
  beforeEach(() => {
    window.localStorage.clear();
    commercialApi.loadCommercialData.mockResolvedValue(commercialData);
    commercialApi.loadProposal.mockResolvedValue({ proposal });
    commercialApi.loadContract.mockResolvedValue({ contract: null });
    clientApi.apiRequest.mockImplementation((path: string) => {
      if (path === "/api/clientes") {
        return Promise.resolve({ items: [{ id: "client-1", name: "Cliente Um", company: "Empresa", email: "cliente@empresa.local" }] });
      }
      if (path === "/api/brainstorm/sessions") return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  it("mostra a lista sem esperar clientes e brainstorms", async () => {
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);

    expect(await screen.findByText("Proposta sob demanda")).toBeInTheDocument();
    expect(clientApi.apiRequest).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Nova proposta" }));

    await waitFor(() => expect(clientApi.apiRequest).toHaveBeenCalledWith("/api/clientes"));
    await waitFor(() => expect(clientApi.apiRequest).toHaveBeenCalledWith("/api/brainstorm/sessions"));
    expect(await screen.findByText("Briefing da nova proposta")).toBeInTheDocument();
  });

  it("busca o documento completo apenas quando o usuario o abre", async () => {
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);

    const rowButton = (await screen.findByText("Proposta sob demanda")).closest("button");
    expect(rowButton).not.toBeNull();
    expect(commercialApi.loadProposal).not.toHaveBeenCalled();

    await userEvent.setup().click(rowButton!);

    await waitFor(() => expect(commercialApi.loadProposal).toHaveBeenCalledWith("proposal-1"));
    expect(await screen.findByText("Editor aberto: Proposta sob demanda")).toBeInTheDocument();
  });
});
