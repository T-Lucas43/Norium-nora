import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBranding, type CommercialData, type CommercialProposal } from "../../features/commercial/types";
import { ownerPermissions, type AuthSession } from "../../types/auth";

const commercialApi = vi.hoisted(() => ({
  loadCommercialData: vi.fn(),
  loadCommercialTemplate: vi.fn(),
  createProposal: vi.fn(),
  loadProposal: vi.fn(),
  loadContract: vi.fn(),
  loadPdfCapabilities: vi.fn(),
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
    favorite: false,
    category: "proposals",
    validUntil: null,
  }],
  contracts: [],
  brandProfiles: [],
  templates: [],
  uploadedDocuments: [],
  processingJobs: [],
  summary: {
    documentCount: 1,
    proposalCount: 1,
    draftCount: 1,
    reviewCount: 0,
    approvedCount: 0,
    negotiationCount: 0,
    contractCount: 0,
    awaitingSignatureCount: 0,
    signedCount: 0,
    expiringCount: 0,
    archivedCount: 0,
    fileCount: 0,
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
    commercialApi.loadPdfCapabilities.mockResolvedValue({
      operations: [
        { id: "merge", label: "Combinar PDFs", engine: "native" },
        { id: "edit_pdf", label: "Editar PDF", engine: "native" },
      ],
      stirling: { available: false, operations: [] },
      maxUploadBytes: 25 * 1024 * 1024,
      asynchronous: true,
    });
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

    await userEvent.setup().click(screen.getByRole("button", { name: "Novo documento" }));

    await waitFor(() => expect(clientApi.apiRequest).toHaveBeenCalledWith("/api/clientes"));
    await waitFor(() => expect(clientApi.apiRequest).toHaveBeenCalledWith("/api/brainstorm/sessions"));
    expect(await screen.findByText("Criar documento com a Nora")).toBeInTheDocument();
  });

  it("preenche Conte o essencial por ditado de voz", async () => {
    const recognition: {
      onstart: (() => void) | null;
      onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
    } = { onstart: null, onresult: null };
    class SpeechRecognitionMock {
      lang = "";
      continuous = false;
      interimResults = false;
      get onstart() { return recognition.onstart; }
      set onstart(value: (() => void) | null) { recognition.onstart = value; }
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      get onresult() { return recognition.onresult; }
      set onresult(value: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null) { recognition.onresult = value; }
      start() { recognition.onstart?.(); }
      stop() { this.onend?.(); }
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", SpeechRecognitionMock);
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Novo documento" }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Ditar conteúdo essencial" }));
    act(() => recognition.onresult?.({ results: [{ 0: { transcript: "currículo de Ana com experiência em dados" }, isFinal: true }] }));
    expect(screen.getByRole("textbox", { name: "Conte o essencial" })).toHaveValue("currículo de Ana com experiência em dados");
    vi.unstubAllGlobals();
  });

  it("grava pelo microfone escolhido e transcreve pela API autenticada", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    const enumerateDevices = vi.fn().mockResolvedValue([
      { deviceId: "mic-1", kind: "audioinput", label: "Microfone interno" },
      { deviceId: "mic-2", kind: "audioinput", label: "Headset USB" },
    ]);
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() } });

    class MediaRecorderMock {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio gravado para transcrever ".repeat(30)], { type: this.mimeType }) });
        void this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", MediaRecorderMock);
    clientApi.apiRequest.mockImplementation((path: string) => {
      if (path === "/api/clientes") return Promise.resolve({ items: [] });
      if (path === "/api/brainstorm/sessions") return Promise.resolve([]);
      if (path === "/api/nora/transcrever") return Promise.resolve({ text: "experiência em dados e habilidade com SQL" });
      return Promise.resolve({});
    });

    try {
      render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);
      await userEvent.setup().click(await screen.findByRole("button", { name: "Novo documento" }));
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Microfone do ditado" })).toHaveTextContent("Headset USB"));
      await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Microfone do ditado" }), "mic-2");
      await userEvent.setup().click(screen.getByRole("button", { name: "Ditar conteúdo essencial" }));
      expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "mic-2" } }) }));
      await userEvent.setup().click(screen.getByRole("button", { name: "Parar ditado" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Conte o essencial" })).toHaveValue("experiência em dados e habilidade com SQL"));
      expect(clientApi.apiRequest).toHaveBeenCalledWith("/api/nora/transcrever", expect.objectContaining({ method: "POST" }));
      expect(stopTrack).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
      else Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    }
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

  it("abre o contrato indicado pelo vínculo da ficha do cliente", async () => {
    window.localStorage.setItem("norium-deep-link", JSON.stringify({ tab: "Propostas", entityType: "contract", entityId: "linked-contract" }));
    commercialApi.loadContract.mockResolvedValue({ contract: { ...proposal, id: "linked-contract", proposalId: proposal.id, title: "Contrato vinculado" } });
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);
    expect(await screen.findByText("Editor aberto: Contrato vinculado")).toBeInTheDocument();
    expect(commercialApi.loadContract).toHaveBeenCalledWith("linked-contract");
    expect(window.localStorage.getItem("norium-deep-link")).toBeNull();
  });

  it("abre o PDF Studio completo ao clicar em Ferramentas PDF", async () => {
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);

    await screen.findByText("Proposta sob demanda");
    await userEvent.setup().click(screen.getByRole("button", { name: /Ferramentas PDF/i }));

    expect(await screen.findByRole("heading", { name: "Norium PDF Studio" })).toBeInTheDocument();
    expect(await screen.findByText("Combinar PDF")).toBeInTheDocument();
    expect(await screen.findByText("Editar PDF")).toBeInTheDocument();
  });

  it("mostra texto e retrato ficticios na previa de curriculo", async () => {
    commercialApi.loadCommercialTemplate.mockResolvedValue({ template: {
      id: "standard_resume_foto_clean",
      layout: "resume-photo",
      paletteName: "Rosa queimado",
      branding: { primaryColor: "#7D3247", secondaryColor: "#C98F86", textColor: "#32242A" },
      contentHtml: '<h1>Marina Costa</h1><p>Todos os nomes, contatos, valores, datas e resultados são fictícios.</p><img src="/template-demo-portrait.svg" alt="Imagem demonstrativa fictícia" /><h2>Projeto selecionado 2</h2><p>Biblioteca de conhecimento com 40 conteúdos e avaliação de oito participantes.</p><h2>Informações complementares</h2><p>Conteúdo integral do servidor, incluindo a última seção.</p>',
    } });
    commercialApi.loadCommercialData.mockResolvedValue({
      ...commercialData,
      templates: [{
        id: "standard_resume_foto_clean",
        name: "Currículo clean com foto",
        description: "Currículo demonstrativo",
        contentHtml: "",
        shared: true,
        category: "Carreira",
        documentType: "resume",
        active: true,
        isDefault: false,
        variables: [],
        createdBy: "system",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        demoContent: true,
        sections: ["Contato e objetivo", "Resumo profissional", "Experiência"],
        layout: "resume-photo",
        paletteName: "Rosa queimado",
        branding: { primaryColor: "#7D3247", secondaryColor: "#C98F86", textColor: "#32242A" },
      }],
    });
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /Modelos/i }));
    await userEvent.setup().click(await screen.findByRole("button", { name: /Visualizar em A4/i }));

    expect(await screen.findByText(/Marina Costa/)).toBeInTheDocument();
    expect(screen.getByAltText("Imagem demonstrativa fictícia")).toHaveAttribute("src", "/template-demo-portrait.svg");
    expect(screen.getByText(/nomes, contatos, valores, datas e resultados são fictícios/i)).toBeInTheDocument();
    expect(screen.getByText(/incluindo a última seção/i)).toBeInTheDocument();
    expect(commercialApi.loadCommercialTemplate).toHaveBeenCalledWith("standard_resume_foto_clean", expect.any(AbortSignal));
    commercialApi.createProposal.mockResolvedValue({ proposal: { ...proposal, title: "[Exemplo] Currículo clean com foto" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Editar este exemplo" }));
    expect(await screen.findByText("Editor aberto: [Exemplo] Currículo clean com foto")).toBeInTheDocument();
    expect(commercialApi.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "__workspace__", contentHtml: expect.stringContaining("incluindo a última seção"),
      branding: expect.objectContaining({ primaryColor: "#7D3247", secondaryColor: "#C98F86", textColor: "#32242A" }),
      metadata: expect.objectContaining({ fictionalExample: true }),
    }));
  });

  it("mantem a foto escolhida na previa e no documento de curriculo", async () => {
    const resumeTemplate = {
      id: "standard_resume_foto_clean",
      name: "Currículo clean com foto",
      description: "Currículo demonstrativo",
      contentHtml: "",
      shared: true,
      category: "Carreira",
      documentType: "resume" as const,
      active: true,
      isDefault: false,
      variables: [],
      createdBy: "system",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      demoContent: true,
      sections: ["Contato e objetivo", "Resumo profissional", "Experiência"],
      layout: "resume-photo",
      paletteName: "Rosa queimado",
      branding: { primaryColor: "#7D3247", secondaryColor: "#C98F86", textColor: "#32242A" },
    };
    commercialApi.loadCommercialData.mockResolvedValue({ ...commercialData, templates: [resumeTemplate] });
    commercialApi.createProposal.mockResolvedValue({ proposal: { ...proposal, title: "Currículo de Ana" } });
    clientApi.apiRequest.mockImplementation((path: string) => {
      if (path === "/api/clientes") return Promise.resolve({ items: [] });
      if (path === "/api/brainstorm/sessions") return Promise.resolve([]);
      if (path === "/api/comercial/document-draft") return Promise.resolve({ draft: {
        title: "Currículo de Ana",
        summary: "Perfil profissional de Ana",
        contentHtml: "<h1>Ana Lima</h1><h2>Experiência</h2><p>Analista de dados.</p>",
        noraComment: "Informações organizadas por categoria.",
        client: { id: "", name: "Ana Lima", company: "", document: "", email: "" },
        amount: 0,
        currency: "BRL",
        validUntil: null,
        template: resumeTemplate,
      } });
      return Promise.resolve({});
    });

    render(<CommercialDashboard session={session} onOpenNora={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Novo documento" }));
    const photoInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
    expect(photoInput).not.toBeNull();
    await user.upload(photoInput!, new File(["foto do curriculo"], "ana.png", { type: "image/png" }));
    expect(await screen.findByRole("img", { name: "Prévia da foto" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/));
    await user.type(screen.getByRole("textbox", { name: "Conte o essencial" }), "Ana Lima, analista de dados.");
    await user.click(screen.getByRole("button", { name: "Gerar primeira versão" }));

    expect(await screen.findByRole("img", { name: "Foto do currículo na prévia" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/));
    await user.click(screen.getByRole("button", { name: "Criar e editar" }));
    await waitFor(() => expect(commercialApi.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      branding: expect.objectContaining({ logoUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
      metadata: expect.objectContaining({ photoAsPortrait: true }),
    })));
  });

  it("offers proposal upload directly and counts signed proposals in the signed filter", async () => {
    commercialApi.loadCommercialData.mockResolvedValue({ ...commercialData, proposals: [
      { ...commercialData.proposals[0], id: "signed-proposal", title: "Proposta assinada", status: "signed" },
      commercialData.proposals[0],
    ] });
    render(<CommercialDashboard session={session} onOpenNora={vi.fn()}/>);
    await screen.findByText("Proposta assinada");
    const signedMetric = screen.getByText("Assinados").closest("button")!;
    expect(signedMetric).toHaveTextContent("1");
    await userEvent.setup().click(signedMetric);
    expect(screen.getByText("Proposta assinada")).toBeInTheDocument();
    expect(screen.queryByText("Proposta sob demanda")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Importar proposta" }));
    expect(await screen.findByRole("dialog", { name: "Importar proposta em PDF" })).toBeInTheDocument();
  });
});
