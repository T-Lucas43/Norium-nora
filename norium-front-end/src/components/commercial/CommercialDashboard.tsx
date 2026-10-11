import ProposalPdfUploadDialog from "./ProposalPdfUploadDialog";
import ProposalPdfWorkspace from "./ProposalPdfWorkspace";
import { proposalStatuses, statusLabels } from "./proposalWorkflow";
import SignatureComposer from "./SignatureComposer";
import "../../styles/screens/trabalho-comum.css";
import "../../styles/screens/documentos.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Ban,
  BadgeCheck,
  Copy,
  FileCheck2,
  FilePlus2,
  FileSignature,
  FileText,
  Filter,
  Grid3X3,
  ExternalLink,
  Eye,
  Link2,
  LayoutTemplate,
  List,
  ImagePlus,
  Mic,
  Square,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Star,
  Sparkles,
  Trash2,
  Upload,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { apiRequest, ApiError } from "../../core/api/client";

type DocumentSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type DocumentSpeechRecognitionConstructor = new () => DocumentSpeechRecognition;

function documentSpeechRecognition() {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: DocumentSpeechRecognitionConstructor;
    webkitSpeechRecognition?: DocumentSpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
}

function documentAudioDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Não foi possível preparar o áudio para transcrição."));
    reader.readAsDataURL(blob);
  });
}
import {
  analyzeProposal,
  cancelContract,
  changeProposalStatus,
  createBrandProfile,
  createProposal,
  createTemplate,
  deleteImportedDocument,
  deleteTemplate,
  deleteContract,
  downloadImportedDocument,
  deleteProposal,
  decideProposal,
  decideSuggestion,
  duplicateProposal,
  duplicateTemplate,
  generateContract,
  generateProposalDraft,
  generateSmartDocumentDraft,
  importDocument,
  instantiateContract,
  loadContract,
  loadCommercialData,
  loadCommercialTemplate,
  loadPdfCapabilities,
  loadProposal,
  processPdf,
  sendContractForSignature,
  shareCommercialDocument,
  signContract,
  submitProposal,
  updateContract,
  updateImportedDocument,
  updateTemplate,
  updateProposal,
  type DocumentUpdateInput,
} from "../../features/commercial/api";
import {
  commercialDocumentSummary,
  defaultBranding,
  isProposal,
  type BrainstormOption,
  type ClientOption,
  type CommercialContract,
  type CommercialData,
  type CommercialDocument,
  type CommercialDocumentSummary,
  type CommercialProposal,
  type CommercialTemplate,
  type PdfCapabilities,
  type PdfProcessingJob,
  type PdfOperation,
  type ProposalBriefInput,
  type ProposalDraft,
  type SmartDocumentDraft,
  type SmartDocumentInput,
  type SignatureLink,
  type TemplateDocumentType,
  type UploadedDocument,
} from "../../features/commercial/types";

import type { AuthSession } from "../../types/auth";
import Button from "../shared/Button";
import EmptyState from "../shared/EmptyState";
import LoadingState from "../shared/LoadingState";
import StatusBanner from "../shared/StatusBanner";
import { showConfirm, showPrompt } from "../shared/AppDialogProvider";
import A4ContentPages from "./A4ContentPages";
import CommercialEditor from "./CommercialEditor";
import DocumentAccessDialog from "./DocumentAccessDialog";
import PdfToolsWorkspace from "./PdfToolsWorkspace";

function brandingForTemplate(template?: CommercialTemplate | null) {
  return {
    ...defaultBranding,
    ...(template?.branding || {}),
  };
}

type View = "all" | "mine" | "shared" | "documents" | "proposals" | "contracts" | "files" | "templates" | "brands";
type DisplayMode = "list" | "grid";
type SortMode = "updated_desc" | "updated_asc" | "title";

type CommercialDashboardProps = {
  session: AuthSession;
  onOpenNora: (prompt?: string) => void;
  initialPdfToolsOpen?: boolean;
  onOpenDocuments?: () => void;
};

type ProposalTemplateGuidance = {
  summary: string;
  objective: string;
  scope: string;
  team: string;
  deliverables: string;
  deadline: string;
  exclusions: string;
  prompt: string;
};

function templateGuidance(template?: CommercialTemplate): ProposalTemplateGuidance {
  const key = `${template?.category || ""} ${template?.name || ""}`.toLocaleLowerCase("pt-BR");
  const base: ProposalTemplateGuidance = {
    summary: "Estrutura comercial completa, adaptada ao objetivo informado e aos dados do cliente.",
    objective: "Qual resultado de negócio o cliente quer alcançar?",
    scope: "O que será executado, quais frentes estão incluídas e qual resultado será entregue?",
    team: "Pessoas, papéis, responsabilidades e aprovações necessárias.",
    deliverables: "Um entregável por linha, com formato e critério de aceite.",
    deadline: "Prazo total, etapas, marcos de validação e dependências.",
    exclusions: "Limites, dependências do cliente e itens não contemplados.",
    prompt: "Estruture a proposta com contexto, objetivo mensurável, escopo detalhado, entregáveis verificáveis, responsabilidades, cronograma, premissas, exclusões, investimento e próximos passos.",
  };

  if (key.includes("marketing") || key.includes("campanha")) {
    return { ...base, summary: "Modelo de marketing orientado a canais, público, metas, calendário e indicadores.", objective: "Qual meta de marketing, público e indicador principal devem ser alcançados?", scope: "Canais, campanhas, peças, conteúdo, mídia, segmentação e rotina de otimização.", team: "Estratégia, criação, mídia, conteúdo, atendimento e aprovadores do cliente.", deliverables: "Plano de campanha, calendário, peças, relatórios e indicadores por período.", deadline: "Período da campanha, fases, datas de publicação e ciclos de otimização.", exclusions: "Verba de mídia, produção externa, ferramentas e aprovações fora do prazo.", prompt: "Adapte o documento a uma proposta de marketing, incluindo público, canais, calendário editorial, métricas, rotina de otimização, responsabilidades e limites da verba de mídia." };
  }
  if (key.includes("consult")) {
    return { ...base, summary: "Modelo de consultoria com diagnóstico, método, workshops, recomendações e plano de ação.", objective: "Qual problema será diagnosticado e qual decisão o cliente precisa tomar?", scope: "Diagnóstico, entrevistas, análise, workshops, recomendações e acompanhamento.", team: "Consultores, especialistas, patrocinador, participantes e responsáveis pelas decisões.", deliverables: "Diagnóstico, matriz de achados, recomendações, plano de ação e apresentação executiva.", deadline: "Fases de diagnóstico, validação, entrega executiva e acompanhamento.", exclusions: "Implantação operacional, dados não fornecidos e atividades fora do método contratado.", prompt: "Adapte o documento a uma proposta de consultoria com método, diagnóstico, hipóteses, workshops, entregáveis executivos, critérios de sucesso e responsabilidades do cliente." };
  }
  if (key.includes("manuten") || key.includes("suporte")) {
    return { ...base, summary: "Modelo de manutenção e suporte com cobertura, SLA, canais, limites e recorrência.", objective: "Quais ativos precisam de suporte e qual disponibilidade deve ser garantida?", scope: "Ambientes cobertos, manutenção preventiva, corretiva, monitoramento e atendimento.", team: "Responsáveis técnicos, ponto focal do cliente, escalonamento e aprovadores.", deliverables: "Relatórios, correções, rotinas preventivas, evidências e registro de chamados.", deadline: "Vigência, janela de atendimento, SLA, recorrência e calendário preventivo.", exclusions: "Projetos evolutivos, peças, licenças, terceiros e atendimentos fora da cobertura.", prompt: "Adapte o documento a manutenção e suporte, detalhando cobertura, SLA, severidades, canais, recorrência, escalonamento, limites e obrigações das partes." };
  }
  if (key.includes("design") || key.includes("marca") || key.includes("identidade")) {
    return { ...base, summary: "Modelo criativo com etapas de pesquisa, conceito, produção, revisões e arquivos finais.", objective: "Que percepção, experiência ou resultado a solução visual deve produzir?", scope: "Pesquisa, referências, conceito, prototipação, aplicações e rodadas de revisão.", team: "Direção criativa, design, conteúdo, responsáveis pela marca e aprovadores.", deliverables: "Conceitos, protótipos, aplicações, arquivos editáveis e guia de uso.", deadline: "Pesquisa, conceito, apresentação, revisões, aprovação e entrega final.", exclusions: "Produção física, banco de imagens, licenças e revisões além do contratado.", prompt: "Adapte o documento a um projeto de design, detalhando pesquisa, conceito, aplicações, formatos, rodadas de revisão, direitos de uso e critérios de aprovação." };
  }
  if (key.includes("desenvol") || key.includes("software") || key.includes("tecnolog")) {
    return { ...base, summary: "Modelo de desenvolvimento com requisitos, arquitetura, etapas, validação e implantação.", objective: "Qual problema do usuário ou do negócio a solução tecnológica deve resolver?", scope: "Módulos, jornadas, integrações, requisitos não funcionais e ambientes contemplados.", team: "Produto, UX/UI, desenvolvimento, qualidade, infraestrutura e aprovadores.", deliverables: "Protótipos, código, integrações, testes, documentação e publicação.", deadline: "Descoberta, design, desenvolvimento, homologação, implantação e estabilização.", exclusions: "Licenças, serviços de terceiros, conteúdo, migração não prevista e novas funcionalidades.", prompt: "Adapte o documento a desenvolvimento de software, detalhando módulos, requisitos, integrações, arquitetura, segurança, testes, homologação, implantação, suporte e controle de mudanças." };
  }
  return base;
}

export default function CommercialDashboard({ session, onOpenNora, initialPdfToolsOpen = false, onOpenDocuments }: CommercialDashboardProps) {
  const [data, setData] = useState<CommercialData | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [brainstorms, setBrainstorms] = useState<BrainstormOption[]>([]);
  const [view, setView] = useState<View>("all");
  const [selected, setSelected] = useState<CommercialDocument | null>(null);
  const [accessDocument, setAccessDocument] = useState<CommercialDocument | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("list");
  const [sortMode, setSortMode] = useState<SortMode>("updated_desc");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [creationOptionsLoading, setCreationOptionsLoading] = useState(false);
  const [creationOptionsError, setCreationOptionsError] = useState("");
  const creationOptionsLoadingRef = useRef(false);
  const creationOptionsLoadedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [preferredTemplateId, setPreferredTemplateId] = useState("");
  const [signOpen, setSignOpen] = useState(false);
  const [instantiateOpen, setInstantiateOpen] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [proposalUploadOpen, setProposalUploadOpen] = useState(false);
  const [proposalUploadTarget, setProposalUploadTarget] = useState<CommercialProposal | undefined>();
  const [proposalUploadSigned, setProposalUploadSigned] = useState(false);
  const [editUploadedPdf, setEditUploadedPdf] = useState(false);
  const [pdfToolsOpen, setPdfToolsOpen] = useState(initialPdfToolsOpen);
  const [pdfCapabilities, setPdfCapabilities] = useState<PdfCapabilities | null>(null);
  const [templatePreview, setTemplatePreview] = useState<CommercialTemplate | null>(null);
  const [contractProposal, setContractProposal] = useState<CommercialProposal | null>(null);
  const [signatureLinks, setSignatureLinks] = useState<SignatureLink[]>([]);

  useEffect(() => {
    setPdfToolsOpen(initialPdfToolsOpen);
  }, [initialPdfToolsOpen]);

  useEffect(() => {
    if (!initialPdfToolsOpen || pdfCapabilities) return undefined;
    let active = true;
    void loadPdfCapabilities()
      .then((capabilities) => { if (active) setPdfCapabilities(capabilities); })
      .catch((requestError) => { if (active) setError(messageFromError(requestError, "Nao foi possivel carregar as ferramentas de PDF.")); });
    return () => { active = false; };
  }, [initialPdfToolsOpen, pdfCapabilities]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const commercial = await loadCommercialData(signal);
      setData(commercial);
    } catch (requestError) {
      if (signal?.aborted || (requestError instanceof DOMException && requestError.name === "AbortError") || (requestError instanceof ApiError && requestError.status === 499)) return;
      setError(messageFromError(requestError, "Nao foi possivel carregar a Central de Documentos."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const loadCreationOptions = useCallback(async () => {
    if (creationOptionsLoadingRef.current || creationOptionsLoadedRef.current) return;
    creationOptionsLoadingRef.current = true;
    setCreationOptionsLoading(true);
    setCreationOptionsError("");
    try {
      const [clientResponse, brainstormResponse] = await Promise.all([
        apiRequest<{ items: ClientOption[] }>("/api/clientes"),
        apiRequest<BrainstormOption[]>("/api/brainstorm/sessions").catch((requestError) => {
          if (requestError instanceof ApiError && [403, 404].includes(requestError.status)) return [];
          throw requestError;
        }),
      ]);
      setClients(clientResponse.items || []);
      setBrainstorms(brainstormResponse || []);
      creationOptionsLoadedRef.current = true;
    } catch (requestError) {
      setCreationOptionsError(messageFromError(requestError, "Nao foi possivel carregar clientes para a nova proposta."));
    } finally {
      creationOptionsLoadingRef.current = false;
      setCreationOptionsLoading(false);
    }
  }, []);

  const openCreate = useCallback((templateId = "") => {
    setPreferredTemplateId(templateId);
    setCreateOpen(true);
    void loadCreationOptions();
  }, [loadCreationOptions]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const hasCommercialData = Boolean(data);
  useEffect(() => {
    if (!hasCommercialData) return;
    let active = true;
    const consume = (event?: Event) => {
      let link: { tab?: string; entityType?: string; entityId?: string } | null = null;
      if (event instanceof CustomEvent && event.detail) link = event.detail;
      if (!link) {
        try { link = JSON.parse(localStorage.getItem("norium-deep-link") || "null"); } catch { return; }
      }
      if (!link?.entityId || !["Documentos", "Propostas"].includes(String(link.tab || "")) || !["proposal", "contract", "commercial_document"].includes(String(link.entityType || ""))) return;
      localStorage.removeItem("norium-deep-link");
      const isContractLink = link.entityType === "contract";
      setView(isContractLink ? "contracts" : "all");
      setOpeningDocumentId(link.entityId);
      const request = isContractLink ? loadContract(link.entityId) : loadProposal(link.entityId);
      void request.then(response => {
        if (!active) return;
        setSelected("contract" in response ? response.contract : response.proposal);
      }).catch(reason => { if (active) setError(messageFromError(reason, "Não foi possível abrir o documento vinculado.")); }).finally(() => { if (active) setOpeningDocumentId(null); });
    };
    consume();
    window.addEventListener("norium:deep-link", consume);
    return () => { active = false; window.removeEventListener("norium:deep-link", consume); };
  }, [hasCommercialData]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error || !data) return undefined;
    const timer = window.setTimeout(() => setError(""), 9000);
    return () => window.clearTimeout(timer);
  }, [data, error]);

  useEffect(() => {
    const openFromBrainstorm = () => openCreate();
    if (window.localStorage.getItem("norium:commercial-brainstorm-id")) {
      openCreate();
    }
    window.addEventListener("norium:commercial-create", openFromBrainstorm);
    return () => window.removeEventListener("norium:commercial-create", openFromBrainstorm);
  }, [openCreate]);

  useEffect(() => {
    if (!data?.processingJobs.some((job) => job.status === "queued" || job.status === "processing")) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadCommercialData().then(setData).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.processingJobs]);

  const currentItems = useMemo<CommercialDocumentSummary[]>(() => {
    if (!data) return [];
    const allDocuments = [...data.proposals, ...data.contracts];
    const source: CommercialDocumentSummary[] = view === "mine"
      ? allDocuments.filter((item) => item.accessRole === "owner" || item.createdBy === session.user.id)
      : view === "shared"
        ? allDocuments.filter((item) => item.accessRole !== "owner" && item.createdBy !== session.user.id)
      : view === "contracts"
      ? data.contracts
      : view === "proposals"
        ? data.proposals.filter((item) => (item.templateDocumentType || "proposal") === "proposal")
        : view === "documents"
          ? data.proposals.filter((item) => (item.templateDocumentType || "proposal") !== "proposal")
        : allDocuments;
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return source.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter || (statusFilter === "signed" && ["active", "completed"].includes(item.status));
      const matchesQuery = !needle || `${item.title} ${item.client?.name || ""} ${item.client?.company || ""}`.toLocaleLowerCase("pt-BR").includes(needle);
      return matchesStatus && matchesQuery && (!favoritesOnly || item.favorite);
    }).sort((left, right) => sortMode === "title"
      ? left.title.localeCompare(right.title, "pt-BR")
      : sortMode === "updated_asc"
        ? left.updatedAt.localeCompare(right.updatedAt)
        : right.updatedAt.localeCompare(left.updatedAt));
  }, [data, favoritesOnly, query, session.user.id, sortMode, statusFilter, view]);

  const currentFiles = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return data.uploadedDocuments.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.category === statusFilter || item.status === statusFilter;
      const matchesQuery = !needle || `${item.title} ${item.originalFileName}`.toLocaleLowerCase("pt-BR").includes(needle);
      return matchesStatus && matchesQuery && (!favoritesOnly || item.favorite);
    }).sort((left, right) => sortMode === "title"
      ? left.title.localeCompare(right.title, "pt-BR")
      : sortMode === "updated_asc"
        ? left.updatedAt.localeCompare(right.updatedAt)
        : right.updatedAt.localeCompare(left.updatedAt));
  }, [data, favoritesOnly, query, sortMode, statusFilter]);

  async function openDocument(item: CommercialDocumentSummary) {
    if (openingDocumentId) return;
    setOpeningDocumentId(item.id);
    setError("");
    try {
      if (item.documentType === "proposal") {
        const response = await loadProposal(item.id);
        setEditUploadedPdf(false);
        setSelected(response.proposal);
        if (response.proposal.sourceDocumentId) void loadCreationOptions();
      } else {
        const response = await loadContract(item.id);
        setSelected(response.contract);
      }
    } catch (requestError) {
      setError(messageFromError(requestError, "Nao foi possivel abrir o documento."));
    } finally {
      setOpeningDocumentId(null);
    }
  }

  async function openDocumentAccess(item: CommercialDocumentSummary) {
    if (openingDocumentId) return;
    setOpeningDocumentId(item.id);
    setError("");
    try {
      const response = item.documentType === "proposal" ? await loadProposal(item.id) : await loadContract(item.id);
      setAccessDocument("proposal" in response ? response.proposal : response.contract);
    } catch (requestError) {
      setError(messageFromError(requestError, "Não foi possível abrir as permissões do documento."));
    } finally {
      setOpeningDocumentId(null);
    }
  }

  function saveDocumentAccess(document: CommercialDocument) {
    const summary = commercialDocumentSummary(document);
    setData((current) => {
      if (!current) return current;
      return isProposal(document)
        ? { ...current, proposals: current.proposals.map((item) => item.id === document.id ? summary as typeof item : item) }
        : { ...current, contracts: current.contracts.map((item) => item.id === document.id ? summary as typeof item : item) };
    });
    if (selected?.id === document.id) setSelected(document);
    setNotice("Acesso da equipe atualizado.");
  }

  function replaceDocument(nextDocument: CommercialDocument) {
    setSelected(nextDocument);
    const nextSummary = commercialDocumentSummary(nextDocument);
    setData((current) => {
      if (!current) return current;
      if (isProposal(nextDocument)) {
        return { ...current, proposals: current.proposals.map((item) => item.id === nextDocument.id ? nextSummary as typeof item : item) };
      }
      return { ...current, contracts: current.contracts.map((item) => item.id === nextDocument.id ? nextSummary as typeof item : item) };
    });
  }

  async function runAction(action: () => Promise<void>, successMessage?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (requestError) {
      setError(messageFromError(requestError, "Nao foi possivel concluir a acao."));
    } finally {
      setBusy(false);
    }
  }

  async function saveDocument(document: CommercialDocument, input: DocumentUpdateInput) {
    if (isProposal(document)) {
      const response = await updateProposal(document.id, input);
      return response.proposal;
    }
    const response = await updateContract(document.id, input);
    return response.contract;
  }

  async function handleSubmit(proposal: CommercialProposal) {
    const pendingCritical = proposal.suggestions.filter((item) => item.status === "pending" && item.severity === "critical");
    if (pendingCritical.length > 0) {
      const proceed = await showConfirm({
        title: "Sugestões críticas da Nora ainda pendentes",
        description: `Há ${pendingCritical.length} sugestão(ões) crítica(s) da Nora sem decisão nesta proposta. Deseja enviar para aprovação mesmo assim?`,
        confirmLabel: "Enviar mesmo assim",
        tone: "danger",
      });
      if (!proceed) return;
    }
    const note = await showPrompt({
      title: "Enviar proposta para aprovacao",
      description: "Inclua uma observacao para quem revisara o documento ou deixe o campo vazio.",
      confirmLabel: "Enviar proposta",
      placeholder: "Observacao opcional",
      multiline: true,
    });
    if (note === null) return;
    await runAction(async () => {
      const response = await submitProposal(proposal.id, note);
      replaceDocument(response.proposal);
    }, data?.summary.requiresApproval ? "Proposta enviada para aprovacao." : "Proposta aprovada no fluxo Solo.");
  }

  async function handleApprove(proposal: CommercialProposal) {
    const note = await showPrompt({
      title: "Aprovar proposta",
      description: "Registre uma observacao para a trilha de aprovacao ou confirme sem texto.",
      confirmLabel: "Aprovar",
      placeholder: "Observacao opcional",
      multiline: true,
    });
    if (note === null) return;
    await runAction(async () => {
      const response = await decideProposal(proposal.id, "approve", note);
      replaceDocument(response.proposal);
    }, "Proposta aprovada.");
  }

  async function handleRequestChanges(proposal: CommercialProposal) {
    const note = await showPrompt({
      title: "Solicitar ajustes",
      description: "Descreva com clareza o que precisa ser alterado na proposta.",
      confirmLabel: "Solicitar ajustes",
      placeholder: "Ex.: detalhar o cronograma e revisar a condicao de pagamento",
      multiline: true,
      required: true,
    });
    if (!note?.trim()) return;
    await runAction(async () => {
      const response = await decideProposal(proposal.id, "request-changes", note.trim());
      replaceDocument(response.proposal);
    }, "Ajustes solicitados ao responsavel.");
  }

  async function handleGenerateContract(proposal: CommercialProposal) {
    setContractProposal(proposal);
  }

  async function createContractFromTemplate(proposal: CommercialProposal, templateId: string, title: string) {
    await runAction(async () => {
      const response = await generateContract(proposal.id, templateId, title);
      setData((current) => current ? {
        ...current,
        proposals: current.proposals.map((item) => item.id === response.proposal.id ? commercialDocumentSummary(response.proposal) as typeof item : item),
        contracts: [commercialDocumentSummary(response.contract) as typeof current.contracts[number], ...current.contracts.filter((item) => item.id !== response.contract.id)],
      } : current);
      setView("contracts");
      setSelected(response.contract);
      setContractProposal(null);
    }, "Contrato gerado com os dados e o historico da proposta.");
  }

  async function handleAnalyze(proposal: CommercialProposal, context: string, focus: Array<"scope" | "risk" | "tone" | "commercial" | "legal" | "grammar">) {
    await runAction(async () => {
      const response = await analyzeProposal(proposal.id, context, focus);
      replaceDocument(response.proposal);
    }, "A Nora concluiu a analise do documento.");
  }

  async function handleSuggestion(proposal: CommercialProposal, suggestionId: string, decision: "accepted" | "rejected") {
    await runAction(async () => {
      const response = await decideSuggestion(proposal.id, suggestionId, decision);
      replaceDocument(response.proposal);
    });
  }

  async function handleSendForSignature(contract: CommercialContract) {
    await runAction(async () => {
      const response = await sendContractForSignature(contract.id);
      replaceDocument(response.contract);
      setSignatureLinks(response.signatureLinks || []);
    }, "Solicitacoes de assinatura registradas.");
  }

  async function handleDeleteProposal(proposal: Pick<CommercialProposal, "id" | "title" | "contractId">) {
    const confirmed = await showConfirm({
      title: "Excluir proposta?",
      description: `A proposta "${proposal.title}" e seu historico de revisoes serao removidos. Esta acao nao pode ser desfeita.`,
      confirmLabel: "Excluir proposta",
      tone: "danger",
    });
    if (!confirmed) return;
    await runAction(async () => {
      await deleteProposal(proposal.id);
      setSelected(null);
      await load();
    }, "Proposta excluida.");
  }

  async function handleCancelContract(contract: Pick<CommercialContract, "id" | "title" | "status">) {
    const confirmed = await showConfirm({
      title: "Cancelar contrato?",
      description: `O contrato "${contract.title}" sera marcado como cancelado e permanecera no historico com sua trilha de auditoria.`,
      confirmLabel: "Cancelar contrato",
      tone: "danger",
    });
    if (!confirmed) return;
    await runAction(async () => {
      const response = await cancelContract(contract.id);
      replaceDocument(response.contract);
      setSelected(null);
    }, "Contrato cancelado e preservado no historico.");
  }

  async function handleDeleteContract(contract: Pick<CommercialContract, "id" | "title" | "status">) {
    const confirmed = await showConfirm({
      title: "Excluir minuta?",
      description: `A minuta "${contract.title}" sera removida e a proposta vinculada voltara a ficar disponivel. Esta acao nao pode ser desfeita.`,
      confirmLabel: "Excluir minuta",
      tone: "danger",
    });
    if (!confirmed) return;
    await runAction(async () => {
      await deleteContract(contract.id);
      setSelected(null);
      await load();
    }, "Minuta excluida. A proposta vinculada foi restaurada.");
  }

  async function handleDuplicateProposal(proposal: Pick<CommercialProposal, "id" | "title">) {
    await runAction(async () => {
      const response = await duplicateProposal(proposal.id);
      setData((current) => current ? {
        ...current,
        proposals: [commercialDocumentSummary(response.proposal) as typeof current.proposals[number], ...current.proposals],
        summary: { ...current.summary, documentCount: current.summary.documentCount + 1, proposalCount: current.summary.proposalCount + 1, draftCount: current.summary.draftCount + 1 },
      } : current);
    }, `Copia de "${proposal.title}" criada como rascunho.`);
  }

  async function handleProposalStatus(proposal: CommercialDocumentSummary, status: CommercialProposal["status"]) {
    if (status === "signed") {
      await runAction(async () => {
        const response = await loadProposal(proposal.id);
        setProposalUploadTarget(response.proposal); setProposalUploadSigned(true); setProposalUploadOpen(true);
      });
      return;
    }
    await runAction(async () => {
      const response = await changeProposalStatus(proposal.id, status);
      setData((current) => current ? {
        ...current,
        proposals: current.proposals.map((item) => item.id === proposal.id ? commercialDocumentSummary(response.proposal) as typeof item : item),
      } : current);
    }, `Status alterado para ${statusLabels[status] || status}.`);
  }

  async function handleImport(input: {
    file: File;
    category: UploadedDocument["category"];
    direction: UploadedDocument["direction"];
    confidential: boolean;
  }) {
    await runAction(async () => {
      const dataBase64 = await fileAsDataUrl(input.file);
      const response = await importDocument({
        fileName: input.file.name,
        mimeType: input.file.type as "application/pdf" | "image/png" | "image/jpeg" | "image/webp",
        dataBase64,
        category: input.category,
        direction: input.direction,
        confidential: input.confidential,
      });
      setData((current) => current ? {
        ...current,
        uploadedDocuments: [response.document, ...current.uploadedDocuments],
        summary: {
          ...current.summary,
          documentCount: current.summary.documentCount + 1,
          fileCount: current.summary.fileCount + 1,
        },
      } : current);
      setView("files");
      setImportOpen(false);
    }, "Documento importado para o armazenamento privado.");
  }

  async function handleToggleFavorite(document: UploadedDocument) {
    await runAction(async () => {
      const response = await updateImportedDocument(document.id, { favorite: !document.favorite });
      setData((current) => current ? {
        ...current,
        uploadedDocuments: current.uploadedDocuments.map((item) => item.id === document.id ? response.document : item),
      } : current);
    });
  }

  async function handleDownload(document: UploadedDocument) {
    await runAction(async () => {
      const blob = await downloadImportedDocument(document.id);
      downloadBlob(blob, document.originalFileName);
    }, "Download preparado.");
  }

  async function handleDeleteImported(document: UploadedDocument) {
    const confirmed = await showConfirm({
      title: "Excluir arquivo?",
      description: `O arquivo "${document.title}" sera removido do armazenamento privado.`,
      confirmLabel: "Excluir arquivo",
      tone: "danger",
    });
    if (!confirmed) return false;
    let deleted = false;
    await runAction(async () => {
      await deleteImportedDocument(document.id);
      setData((current) => current ? {
        ...current,
        uploadedDocuments: current.uploadedDocuments.filter((item) => item.id !== document.id),
        summary: {
          ...current.summary,
          documentCount: Math.max(0, current.summary.documentCount - 1),
          fileCount: Math.max(0, current.summary.fileCount - 1),
        },
      } : current);
      deleted = true;
    }, "Arquivo excluido.");
    return deleted;
  }

  async function openPdfTools() {
    setPdfToolsOpen(true);
    if (pdfCapabilities) return;
    try {
      setPdfCapabilities(await loadPdfCapabilities());
    } catch (requestError) {
      setError(messageFromError(requestError, "Nao foi possivel carregar as ferramentas de PDF."));
    }
  }

  async function handlePdfProcess(operation: PdfOperation, documentIds: string[], options: Record<string, unknown>) {
    let queuedJob: PdfProcessingJob | undefined;
    await runAction(async () => {
      const response = await processPdf(operation, documentIds, options);
      queuedJob = response.job;
      setData((current) => current ? { ...current, processingJobs: [response.job, ...current.processingJobs] } : current);
    }, "Processamento iniciado. O resultado ficará disponível nesta página.");
    return queuedJob;
  }

  async function handleRenameTemplate(template: CommercialTemplate) {
    const name = await showPrompt({
      title: "Renomear modelo",
      description: "Atualize o nome usado na biblioteca.",
      confirmLabel: "Salvar",
      defaultValue: template.name,
      required: true,
    });
    if (!name?.trim()) return;
    await runAction(async () => {
      const response = await updateTemplate(template.id, { name: name.trim() });
      setData((current) => current ? { ...current, templates: current.templates.map((item) => item.id === template.id ? response.template : item) } : current);
      setTemplatePreview(response.template);
    }, "Modelo atualizado.");
  }

  async function handleDuplicateTemplate(template: CommercialTemplate) {
    await runAction(async () => {
      const response = await duplicateTemplate(template.id);
      setData((current) => current ? { ...current, templates: [...current.templates, response.template] } : current);
      setTemplatePreview(response.template);
    }, "Modelo duplicado como copia pessoal.");
  }

  async function handleEditTemplateExample(template: CommercialTemplate) {
    await runAction(async () => {
      const { template: full } = await loadCommercialTemplate(template.id);
      const { proposal } = await createProposal({
        clientId: "__workspace__", brainstormId: null, title: `[Exemplo] ${full.name}`,
        contentHtml: full.contentHtml, scopeSummary: full.description || "", amount: 0, currency: "BRL",
        validUntil: null, brandProfileId: null, branding: brandingForTemplate(full), signers: [], deliverables: [],
        metadata: { documentType: full.documentType, templateId: full.id, templateLayout: full.layout, fictionalExample: true },
      });
      setData((current) => current ? { ...current, proposals: [commercialDocumentSummary(proposal) as typeof current.proposals[number], ...current.proposals], summary: { ...current.summary, documentCount: current.summary.documentCount + 1, draftCount: current.summary.draftCount + 1, proposalCount: current.summary.proposalCount + (full.documentType === "proposal" ? 1 : 0) } } : current);
      setTemplatePreview(null);
      setSelected(proposal);
    }, "Cópia editável criada. Substitua os dados fictícios antes de enviar.");
  }

  async function handleDeleteTemplate(template: CommercialTemplate) {
    const confirmed = await showConfirm({ title: "Excluir modelo?", description: `O modelo "${template.name}" sera removido da biblioteca.`, confirmLabel: "Excluir modelo", tone: "danger" });
    if (!confirmed) return;
    await runAction(async () => {
      await deleteTemplate(template.id);
      setData((current) => current ? { ...current, templates: current.templates.filter((item) => item.id !== template.id) } : current);
      setTemplatePreview(null);
    }, "Modelo excluido.");
  }

  function proposalUploaded(proposal: CommercialProposal) {
    setProposalUploadOpen(false); setProposalUploadTarget(undefined);
    setEditUploadedPdf(!proposal.signedDocumentId); setSelected(proposal);
    setData(current => current ? { ...current, proposals: [commercialDocumentSummary(proposal) as typeof current.proposals[number], ...current.proposals.filter(item => item.id !== proposal.id)] } : current);
    void loadCommercialData().then(setData).catch(() => undefined);
    void loadCreationOptions();
    setNotice(proposal.signedDocumentId ? "Arquivo recebido e proposta registrada como assinada." : "Proposta importada. O PDF está pronto para editar.");
  }
  const liveSummary = data ? {
    ...data.summary,
    documentCount: data.proposals.length + data.contracts.length + data.uploadedDocuments.length,
    reviewCount: data.proposals.filter(item => item.status === "in_review").length,
    awaitingSignatureCount: [...data.proposals, ...data.contracts].filter(item => item.status === "awaiting_signatures").length,
    signedCount: [...data.proposals, ...data.contracts].filter(item => ["signed", "active", "completed"].includes(item.status)).length,
  } : null;

  if (pdfToolsOpen && data) {
    return (
      <>
        <PdfToolsWorkspace
          capabilities={pdfCapabilities}
          documents={data.uploadedDocuments}
          jobs={data.processingJobs}
          busy={busy}
          onBack={() => { setPdfToolsOpen(false); if (initialPdfToolsOpen) onOpenDocuments?.(); }}
          onProcess={handlePdfProcess}
          onDelete={handleDeleteImported}
          onImported={(document) => setData((current) => current ? {
            ...current,
            uploadedDocuments: [document, ...current.uploadedDocuments],
            summary: {
              ...current.summary,
              documentCount: current.summary.documentCount + 1,
              fileCount: current.summary.fileCount + 1,
            },
          } : current)}
        />
        {error && <FloatingMessage kind="error" message={error} onClose={() => setError("")} />}
        {notice && <FloatingMessage kind="success" message={notice} onClose={() => setNotice("")} />}
      </>
    );
  }

  if (selected) {
    return (
      <>
        {isProposal(selected) && selected.sourceDocumentId ? <ProposalPdfWorkspace
          key={`${selected.id}:${selected.sourceDocumentId}`} proposal={selected} clients={clients} editImmediately={editUploadedPdf}
          onBack={() => { setSelected(null); setEditUploadedPdf(false); }}
          onUpload={(proposal, signed = false) => { setProposalUploadTarget(proposal); setProposalUploadSigned(signed); setProposalUploadOpen(true); }}
          onChange={replaceDocument}
        /> : <CommercialEditor
          document={selected}
          session={session}
          busy={busy}
          onBack={() => setSelected(null)}
          onDocumentChange={replaceDocument}
          onSave={saveDocument}
          onSubmitProposal={handleSubmit}
          onApproveProposal={handleApprove}
          onRequestChanges={handleRequestChanges}
          onGenerateContract={handleGenerateContract}
          onAnalyze={handleAnalyze}
          onSuggestion={handleSuggestion}
          onSendForSignature={handleSendForSignature}
          onSign={async () => setSignOpen(true)}
          onInstantiate={async () => setInstantiateOpen(true)}
          onDeleteProposal={handleDeleteProposal}
          onUploadProposal={(proposal) => { setProposalUploadSigned(false); setProposalUploadTarget(proposal); setProposalUploadOpen(true); }}
        />}
        {proposalUploadOpen && <ProposalPdfUploadDialog initialSigned={proposalUploadSigned} proposal={proposalUploadTarget} clients={clients} onClose={() => setProposalUploadOpen(false)} onUploaded={proposalUploaded}/>}

        {error && <FloatingMessage kind="error" message={error} onClose={() => setError("")} />}
        {notice && <FloatingMessage kind="success" message={notice} onClose={() => setNotice("")} />}
        {signOpen && !isProposal(selected) && (
          <SignatureDialog
            contract={selected}
            busy={busy}
            onClose={() => setSignOpen(false)}
            onSubmit={(signerId, name, email, signatureDataUrl) => void runAction(async () => {
              const response = await signContract(selected.id, signerId, { name, email, consent: true, signatureDataUrl });
              replaceDocument(response.contract);
              setSignOpen(false);
            }, "Assinatura registrada com trilha de auditoria.")}
          />
        )}
        {instantiateOpen && !isProposal(selected) && (
          <InstantiateDialog
            busy={busy}
            onClose={() => setInstantiateOpen(false)}
            onSubmit={(projectId, projectName, calendar) => void runAction(async () => {
              const response = await instantiateContract(selected.id, projectId, projectName, calendar);
              replaceDocument(response.contract);
              setInstantiateOpen(false);
            }, "Obrigações transformadas em tarefas e prazos.")}
          />
        )}
        {contractProposal && data && (
          <ContractGenerationDialog
            proposal={contractProposal}
            templates={data.templates.filter((item) => item.documentType === "contract")}
            busy={busy}
            onClose={() => setContractProposal(null)}
            onSubmit={(templateId, title) => void createContractFromTemplate(contractProposal, templateId, title)}
          />
        )}
        {signatureLinks.length > 0 && (
          <SignatureLinksDialog
            links={signatureLinks}
            contractId={selected.id}
            contractTitle={selected.title}
            onClose={() => setSignatureLinks([])}
          />
        )}
      </>
    );
  }

  return (
    <main className="clean-workspace nxw-screen nxw-remap nx-page nxd-page min-h-[calc(100dvh-74px)]">
      <div className="nxd-inner">
        <header className="nx-ph">
          <div><h1>Documentos</h1><p>Propostas, contratos e PDFs gerados</p></div>
          <div className="nx-ph-actions">
            <Button variant="secondary" loading={loading} onClick={() => void load()} icon={<RefreshCw size={15} />}>Atualizar</Button>
            <Button variant="secondary" onClick={() => { setProposalUploadTarget(undefined); setProposalUploadSigned(false); setProposalUploadOpen(true); void loadCreationOptions(); }} icon={<Upload size={15} />}>Importar proposta</Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)} icon={<Upload size={15} />}>Importar arquivo</Button>
            <Button variant="secondary" onClick={() => void openPdfTools()} icon={<Wrench size={15} />}>Ferramentas PDF</Button>
            <Button variant="secondary" onClick={() => onOpenNora("Quero criar um documento. Pergunte tudo o que for essencial em uma única mensagem e gere mesmo que alguns detalhes fiquem como A definir.")} icon={<Sparkles size={15} />}>Criar com a Nora</Button>
            <Button variant="primary" onClick={() => openCreate()} icon={<Plus size={16} />}>Novo documento</Button>
          </div>
        </header>

        {error && (
          <StatusBanner
            tone="error"
            action={!data ? <Button size="sm" variant="secondary" onClick={() => void load()}>Tentar novamente</Button> : undefined}
          >
            {error}
          </StatusBanner>
        )}
        {notice && <StatusBanner tone="success">{notice}</StatusBanner>}

        {loading ? <LoadingState label="Carregando documentos comerciais..." /> : data && (
          <>
            <section className="nx-kpis" aria-label="Resumo dos documentos">
              <Metric tone="blue" label="Total" value={liveSummary?.documentCount || 0} icon={FileText} onClick={() => { setView("all"); setStatusFilter("all"); }} />
              <Metric tone="amber" label="Em aprovação" value={liveSummary?.reviewCount || 0} icon={UsersRound} onClick={() => { setView("proposals"); setStatusFilter("in_review"); }} />
              <Metric tone="amber" label="Aguardando assinatura" value={liveSummary?.awaitingSignatureCount || 0} icon={FileSignature} onClick={() => { setView("all"); setStatusFilter("awaiting_signatures"); }} />
              <Metric tone="emerald" label="Assinados" value={liveSummary?.signedCount || 0} icon={BadgeCheck} onClick={() => { setView("all"); setStatusFilter("signed"); }} />
            </section>

            <section className="nx-card nxd-main">
              <div className="nxd-toolbar">
                <div className="nx-tabs nxd-tabs" aria-label="Tipos de documento">
                  <ViewTab active={view === "all"} label="Todos" count={liveSummary?.documentCount || 0} onClick={() => { setView("all"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "mine"} label="Meus documentos" count={[...data.proposals, ...data.contracts].filter((item) => item.accessRole === "owner" || item.createdBy === session.user.id).length} onClick={() => { setView("mine"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "shared"} label="Compartilhados" count={[...data.proposals, ...data.contracts].filter((item) => item.accessRole !== "owner" && item.createdBy !== session.user.id).length} onClick={() => { setView("shared"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "documents"} label="Editáveis" count={data.proposals.filter((item) => (item.templateDocumentType || "proposal") !== "proposal").length} onClick={() => { setView("documents"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "proposals"} label="Propostas" count={data.proposals.filter((item) => (item.templateDocumentType || "proposal") === "proposal").length} onClick={() => { setView("proposals"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "contracts"} label="Contratos" count={data.contracts.length} onClick={() => { setView("contracts"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "files"} label="Arquivos e PDFs" count={data.uploadedDocuments.length} onClick={() => { setView("files"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "templates"} label="Modelos" count={data.templates.length} onClick={() => setView("templates")} />
                  <ViewTab active={view === "brands"} label="Marcas" count={data.brandProfiles.length} onClick={() => setView("brands")} />
                </div>
                <div className="nxd-controls">
                  <label className="nx-input nxd-search"><Search size={15} className="nx-faint" /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Buscar documentos" placeholder="Buscar por documento ou cliente" /></label>
                  {(view === "all" || view === "mine" || view === "shared" || view === "documents" || view === "proposals" || view === "contracts" || view === "files") && (
                    <>
                      <label className="nx-input"><Filter size={14} className="nx-faint" /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="commercial-status-select min-w-[150px]"><option value="all">Todos os status</option>{view === "files" ? <><option value="pdf">PDFs</option><option value="sent">Enviados</option><option value="received">Recebidos</option><option value="archived">Arquivados</option></> : Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                      <select aria-label="Ordenar documentos" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="nxw-field min-w-[150px]"><option value="updated_desc">Mais recentes</option><option value="updated_asc">Mais antigos</option><option value="title">Título A-Z</option></select>
                      <Button variant={favoritesOnly ? "primary" : "secondary"} iconOnly onClick={() => setFavoritesOnly((current) => !current)} aria-label="Mostrar favoritos" title="Favoritos"><Star size={15} fill={favoritesOnly ? "currentColor" : "none"} /></Button>
                      <Button variant={displayMode === "list" ? "primary" : "secondary"} iconOnly onClick={() => setDisplayMode("list")} aria-label="Visualização em lista" title="Lista"><List size={15} /></Button>
                      <Button variant={displayMode === "grid" ? "primary" : "secondary"} iconOnly onClick={() => setDisplayMode("grid")} aria-label="Visualização em grade" title="Grade"><Grid3X3 size={15} /></Button>
                    </>
                  )}
                </div>
              </div>

              {(view === "all" || view === "mine" || view === "shared" || view === "documents" || view === "proposals" || view === "contracts") && (
                <div className={`min-h-0 ${displayMode === "grid" ? "grid gap-3 p-4 sm:grid-cols-2 2xl:grid-cols-3" : ""}`}>
                  {currentItems.map((item) => (
                    <article key={item.id} className={displayMode === "grid" ? "nxd-doc-card flex min-h-72 flex-col gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-4 transition" : "nxd-doc-row grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b border-[var(--border)] px-[18px] py-3 transition hover:bg-[var(--nx-surface-2)] xl:grid-cols-[34px_minmax(180px,1fr)_110px_150px_120px_180px_minmax(250px,auto)] xl:items-center"}>
                      <span className={`nxw-icon row-start-1 ${item.documentType === "contract" ? "is-green" : (item.templateDocumentType || "proposal") === "proposal" ? "" : "is-violet"}`}>{item.documentType === "contract" ? <FileCheck2 size={16} /> : (item.templateDocumentType || "proposal") === "proposal" ? <FileSignature size={16} /> : <FileText size={16} />}</span>
                      <button type="button" disabled={openingDocumentId !== null} onClick={() => void openDocument(item)} className="min-w-0 text-left disabled:cursor-wait disabled:opacity-70">
                        <strong className="block truncate text-[13.5px] font-medium">{item.title}</strong>
                        <small className="mt-0.5 block truncate text-[12.5px] text-[var(--nx-text-3)]">{item.documentTypeLabel || (item.documentType === "contract" ? "Contrato" : "Proposta")}{item.client?.name ? ` · ${item.client.name}` : ""} {item.brainstormId ? "· vinculado ao Estúdio" : ""}{item.accessRole && item.accessRole !== "owner" ? ` · Compartilhado por ${item.createdByName || "membro da equipe"}` : ""}</small>
                      </button>
                      <span className="col-start-2 text-[13px] xl:col-auto">{(item.templateDocumentType || "proposal") === "proposal" || item.templateDocumentType === "budget" || item.documentType === "contract" ? formatMoney(item.amount, item.currency) : item.documentTypeLabel || "Documento"}</span>
                      <span className="col-start-2 xl:col-auto"><StatusChip status={item.status} /></span>
                      <time className="col-start-2 text-[12.5px] text-[var(--nx-text-2)] xl:col-auto">{formatDate(item.updatedAt)}</time>
                      <DocumentPreviewButton
                        title={item.title}
                        label={item.documentTypeLabel || (item.documentType === "contract" ? "Contrato" : "Proposta")}
                        primaryColor={item.primaryColor}
                        onClick={() => void openDocument(item)}
                        className="col-span-2 xl:col-auto"
                      />
                      <div className="col-span-2 flex min-h-10 flex-wrap items-center gap-2 xl:col-auto xl:justify-end">
                        {(item.accessRole === "owner" || item.createdBy === session.user.id) && (
                          <Button variant="secondary" loading={openingDocumentId === item.id} disabled={openingDocumentId !== null} onClick={() => void openDocumentAccess(item)} icon={<UsersRound size={15} />} aria-label={`Compartilhar ${item.title} com a equipe`}>Compartilhar</Button>
                        )}
                        {item.accessRole !== "view" && item.documentType === "proposal" && (item.templateDocumentType || "proposal") === "proposal" && (
                          <>
                            <select aria-label={`Alterar status de ${item.title}`} value="" disabled={busy} onChange={(event) => event.target.value && void handleProposalStatus(item, event.target.value as CommercialProposal["status"])} className="commercial-status-select nxw-field max-w-[160px]"><option value="">Alterar status</option>{proposalStatuses.filter((status) => status !== item.status).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select>
                            <Button variant="secondary" iconOnly onClick={() => void handleDuplicateProposal(item)} aria-label={`Duplicar proposta ${item.title}`} title="Duplicar proposta"><Copy size={15} /></Button>
                          </>
                        )}
                        {item.accessRole !== "view" && item.documentType === "contract" && !["signed", "active", "completed", "cancelled"].includes(item.status) && (
                          <Button variant="secondary" iconOnly loading={openingDocumentId === item.id} disabled={openingDocumentId !== null} onClick={() => void openDocument(item)} aria-label={`Editar contrato ${item.title}`} title="Editar contrato"><Pencil size={16} /></Button>
                        )}
                        {(item.accessRole === "owner" || item.createdBy === session.user.id) && item.documentType === "proposal" && !item.contractId && (
                          <Button variant="danger" iconOnly onClick={() => void handleDeleteProposal(item)} className="border-red-400/20 text-red-400 hover:bg-red-500/10" aria-label={`Excluir documento ${item.title}`} title="Excluir documento"><Trash2 size={16} /></Button>
                        )}
                        {item.accessRole !== "view" && item.documentType === "contract" && item.status !== "cancelled" && item.status !== "completed" && (
                          <Button variant="danger" iconOnly onClick={() => void handleCancelContract(item)} className="border-amber-400/20 text-amber-300 hover:bg-amber-500/10" aria-label={`Cancelar contrato ${item.title}`} title="Cancelar contrato"><Ban size={16} /></Button>
                        )}
                        {(item.accessRole === "owner" || item.createdBy === session.user.id) && item.documentType === "contract" && item.status === "draft" && (
                          <Button variant="danger" iconOnly onClick={() => void handleDeleteContract(item)} className="border-red-400/20 text-red-400 hover:bg-red-500/10" aria-label={`Excluir minuta ${item.title}`} title="Excluir minuta"><Trash2 size={16} /></Button>
                        )}
                      </div>
                    </article>
                  ))}
                  {!currentItems.length && <EmptyState title="Nenhum documento encontrado" description="Escolha um dos modelos, escreva um briefing curto e deixe a Nora montar a primeira versão." icon={FilePlus2} className="min-h-[430px] border-none" />}
                </div>
              )}

              {(view === "files" || view === "all") && (
                <div className="documents-results">
                  {data.processingJobs.length > 0 && (
                    <section className="nxd-queue">
                      <div className="flex items-center justify-between gap-3"><div><h2 className="text-[14px] font-semibold">Fila de processamento</h2><p className="mt-1 text-[12.5px] text-[var(--nx-text-3)]">Tentativas, progresso e resultados ficam registrados.</p></div><Wrench size={17} className="text-blue-300" /></div>
                      <div className="mt-3 grid gap-2 lg:grid-cols-2">
                        {data.processingJobs.slice(0, 6).map((job) => <article key={job.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="flex items-center justify-between gap-2"><strong className="truncate text-xs">{job.label}</strong><StatusChip status={job.status} /></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-hover)]"><span className="block h-full bg-[var(--nx-primary)] transition-all" style={{ width: `${job.progress}%` }} /></div><p className="mt-2 text-xs font-semibold text-[var(--text-secondary)]">{job.message}</p></article>)}
                      </div>
                    </section>
                  )}
                  <div className={displayMode === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2"}>
                    {currentFiles.map((document) => (
                      <article key={document.id} className={`border border-[var(--border)] bg-[var(--surface)] p-4 ${displayMode === "grid" ? "rounded-[12px]" : "flex flex-col gap-3 rounded-[10px] lg:flex-row lg:items-center"}`}>
                        <span className="nxw-icon is-red"><FileText size={16} /></span>
                        <div className="min-w-0 flex-1"><strong className="block truncate text-[13.5px] font-medium">{document.title}</strong><p className="mt-0.5 truncate text-[12.5px] text-[var(--nx-text-3)]">{document.originalFileName} · {formatFileSize(document.size)}</p><div className="mt-2 flex flex-wrap gap-2"><StatusChip status={document.category} />{document.confidential && <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">Confidencial</span>}<time className="px-1 py-1 text-xs font-bold text-[var(--text-secondary)]">{formatDate(document.updatedAt)}</time></div></div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" iconOnly onClick={() => void handleToggleFavorite(document)} aria-label={`Favoritar ${document.title}`} title="Favorito"><Star size={15} fill={document.favorite ? "currentColor" : "none"} /></Button>
                          <Button variant="secondary" onClick={() => void handleDownload(document)} icon={<ExternalLink size={14} />}>Baixar</Button>
                          <Button variant="danger" iconOnly onClick={() => void handleDeleteImported(document)} aria-label={`Excluir ${document.title}`} title="Excluir"><Trash2 size={15} /></Button>
                        </div>
                      </article>
                    ))}
                  </div>
                  {!currentFiles.length && view === "files" && <EmptyState title="Nenhum arquivo encontrado" description="Importe PDFs ou imagens para organizar e processar com segurança." icon={Upload} className="min-h-[380px] border-none" />}
                </div>
              )}

              {view === "templates" && (
                <LibraryView
                  title="Modelos inteligentes"
                  description="Modelos editáveis para propostas, contratos, currículos, RH, gestão, financeiro, marketing, operações, educação e uso pessoal."
                  icon={LayoutTemplate}
                  items={data.templates.filter((item) => !query.trim() || `${item.name} ${item.description} ${item.category} ${(item.keywords || []).join(" ")}`.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR"))).map((item) => ({ id: item.id, title: item.name, description: `${item.category} · ${item.description || (item.shared ? "Modelo compartilhado" : "Modelo pessoal")}`, template: item }))}
                  actionLabel="Salvar modelo"
                  onAction={() => setTemplateOpen(true)}
                  onItemClick={(id) => setTemplatePreview(data.templates.find((item) => item.id === id) || null)}
                />
              )}

              {view === "brands" && (
                <LibraryView
                  title="Perfis de marca"
                  description={data.summary.planMode === "solo" ? "Seu plano permite um perfil de marca pessoal." : "Gerencie marcas e subsidiárias sem misturar identidades."}
                  icon={Palette}
                  items={data.brandProfiles.map((item) => ({ id: item.id, title: item.name, description: item.isDefault ? "Marca padrão" : item.branding.primaryColor }))}
                  actionLabel="Nova marca"
                  onAction={() => setBrandOpen(true)}
                />
              )}
            </section>
          </>
        )}
      </div>

      {createOpen && data && (
        <CreateSmartDocumentDialog
          clients={clients}
          brainstorms={brainstorms}
          optionsLoading={creationOptionsLoading}
          optionsError={creationOptionsError}
          onRetryOptions={() => void loadCreationOptions()}
          templates={data.templates}
          initialTemplateId={preferredTemplateId}
          brands={data.brandProfiles.map((item) => ({ id: item.id, name: item.name, branding: item.branding }))}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => void runAction(async () => {
            const response = await createProposal(input);
            const isCommercialProposal = input.metadata.documentType === "proposal";
            setData((current) => current ? { ...current, proposals: [commercialDocumentSummary(response.proposal) as typeof current.proposals[number], ...current.proposals], summary: { ...current.summary, documentCount: current.summary.documentCount + 1, proposalCount: current.summary.proposalCount + (isCommercialProposal ? 1 : 0), draftCount: current.summary.draftCount + 1 } } : current);
            setCreateOpen(false);
            setSelected(response.proposal);
          }, "Documento criado. O salvamento automático está ativo.")}
        />
      )}

      {brandOpen && <BrandProfileDialog busy={busy} onClose={() => setBrandOpen(false)} onSubmit={(name, isDefault) => void runAction(async () => {
        const response = await createBrandProfile(name, defaultBranding, isDefault);
        setData((current) => current ? { ...current, brandProfiles: [...current.brandProfiles, response.brandProfile] } : current);
        setBrandOpen(false);
      }, "Perfil de marca criado.")} />}

      {templateOpen && <TemplateDialog busy={busy} onClose={() => setTemplateOpen(false)} onSubmit={(name, description, shared, documentType, category) => void runAction(async () => {
        const response = await createTemplate(name, description, "<h1>Titulo do documento</h1><p>Apresente o contexto, o escopo, os entregaveis e as condicoes comerciais.</p>", shared, category, documentType);
        setData((current) => current ? { ...current, templates: [...current.templates, response.template] } : current);
        setTemplateOpen(false);
      }, "Modelo salvo na biblioteca.")} />}
      {templatePreview && <TemplatePreviewDialog template={templatePreview} busy={busy} onClose={() => setTemplatePreview(null)} onEditExample={() => void handleEditTemplateExample(templatePreview)} onUse={() => { const id = templatePreview.id; setTemplatePreview(null); openCreate(id); }} onRename={() => void handleRenameTemplate(templatePreview)} onDuplicate={() => void handleDuplicateTemplate(templatePreview)} onDelete={templatePreview.id.startsWith("standard_") ? undefined : () => void handleDeleteTemplate(templatePreview)} />}
      {proposalUploadOpen && <ProposalPdfUploadDialog initialSigned={proposalUploadSigned} proposal={proposalUploadTarget} clients={clients} onClose={() => setProposalUploadOpen(false)} onUploaded={proposalUploaded}/>}
      {importOpen && <ImportDocumentDialog busy={busy} onClose={() => setImportOpen(false)} onSubmit={(input) => void handleImport(input)} />}
      {accessDocument && <DocumentAccessDialog document={accessDocument} onClose={() => setAccessDocument(null)} onSaved={saveDocumentAccess} />}
    </main>
  );
}

function CreateSmartDocumentDialog({
  clients,
  brainstorms,
  optionsLoading,
  optionsError,
  onRetryOptions,
  templates,
  initialTemplateId,
  brands,
  busy,
  onClose,
  onCreate,
}: {
  clients: ClientOption[];
  brainstorms: BrainstormOption[];
  optionsLoading: boolean;
  optionsError: string;
  onRetryOptions: () => void;
  templates: CommercialTemplate[];
  initialTemplateId: string;
  brands: Array<{ id: string; name: string; branding: typeof defaultBranding }>;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: CreateInput) => void;
}) {
  const availableTemplates = templates.filter((item) => item.active !== false);
  const suggestedTemplate = availableTemplates.find((item) => item.id === initialTemplateId) || availableTemplates.find((item) => item.id === "standard_proposal_consultoria") || availableTemplates.find((item) => item.featured) || availableTemplates[0];
  const suggestedBranding = brandingForTemplate(suggestedTemplate);
  const [templateId, setTemplateId] = useState(suggestedTemplate?.id || "");
  const [clientId, setClientId] = useState("");
  const [brainstormId, setBrainstormId] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [details, setDetails] = useState("");
  const [amount, setAmount] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [tone, setTone] = useState<SmartDocumentInput["tone"]>("consultive");
  const [brandId, setBrandId] = useState("");
  const [primaryColor, setPrimaryColor] = useState(suggestedBranding.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(suggestedBranding.secondaryColor);
  const [textColor, setTextColor] = useState(suggestedBranding.textColor);
  const [photoDataUrl, setPhotoDataUrl] = useState("");
  const [draft, setDraft] = useState<SmartDocumentDraft | null>(null);
  const [generating, setGenerating] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [localError, setLocalError] = useState("");
  const [dictating, setDictating] = useState(false);
  const [transcribingDictation, setTranscribingDictation] = useState(false);
  const [dictationError, setDictationError] = useState("");
  const [dictationMicrophones, setDictationMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [dictationMicrophoneId, setDictationMicrophoneId] = useState("");
  const recognitionRef = useRef<DocumentSpeechRecognition | null>(null);
  const nativeDictationFailedRef = useRef(false);
  const dictationRecorderRef = useRef<MediaRecorder | null>(null);
  const dictationStreamRef = useRef<MediaStream | null>(null);
  const dictationChunksRef = useRef<Blob[]>([]);
  const dictationPrefixRef = useRef("");
  const selectedTemplate = availableTemplates.find((item) => item.id === templateId);
  const selectedBrand = brands.find((item) => item.id === brandId);
  const client = clients.find((item) => item.id === clientId);
  const isResume = selectedTemplate?.documentType === "resume";
  const groupedTemplates = useMemo(() => {
    const groups = new Map<string, CommercialTemplate[]>();
    availableTemplates.forEach((template) => {
      const category = template.category || "Outros";
      groups.set(category, [...(groups.get(category) || []), template]);
    });
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "pt-BR"));
  }, [availableTemplates]);

  const refreshDictationMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setDictationMicrophones(devices.filter((device) => device.kind === "audioinput"));
  }, []);

  useEffect(() => {
    void refreshDictationMicrophones().catch(() => undefined);
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refreshDictationMicrophones);
    return () => {
      recognitionRef.current?.abort();
      if (dictationRecorderRef.current?.state === "recording") dictationRecorderRef.current.stop();
      dictationStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaDevices?.removeEventListener?.("devicechange", refreshDictationMicrophones);
    };
  }, [refreshDictationMicrophones]);

  async function startRecordedDictation() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: dictationMicrophoneId ? { exact: dictationMicrophoneId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find((candidate) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(candidate)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      dictationPrefixRef.current = brief.trim();
      dictationChunksRef.current = [];
      dictationStreamRef.current = stream;
      dictationRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) dictationChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        setDictationError("Não consegui gravar o áudio. Verifique o microfone selecionado e tente novamente.");
        setDictating(false);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        dictationStreamRef.current = null;
        dictationRecorderRef.current = null;
        setDictating(false);
        const audio = new Blob(dictationChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        dictationChunksRef.current = [];
        if (audio.size < 400) {
          setDictationError("O áudio ficou curto demais. Fale por alguns segundos e tente novamente.");
          return;
        }
        setTranscribingDictation(true);
        try {
          const result = await apiRequest<{ text: string }>("/api/nora/transcrever", {
            method: "POST",
            timeoutMs: 60_000,
            body: JSON.stringify({ audio_data_url: await documentAudioDataUrl(audio), mime_type: audio.type || "audio/webm" }),
          });
          const spoken = String(result.text || "").trim();
          if (!spoken) throw new Error("Não identifiquei nenhuma fala no áudio.");
          setBrief([dictationPrefixRef.current, spoken].filter(Boolean).join(" "));
          setDictationError("");
        } catch (error) {
          setDictationError(messageFromError(error, "Não foi possível transcrever o áudio agora."));
        } finally {
          setTranscribingDictation(false);
        }
      };
      recorder.start(250);
      setDictating(true);
      setDictationError("");
      await refreshDictationMicrophones().catch(() => undefined);
      return true;
    } catch (error) {
      setDictationError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Permita o uso do microfone para ditar o conteúdo."
        : "Microfone indisponível. Escolha outro dispositivo ou verifique a conexão.");
      return true;
    }
  }

  async function toggleDictation() {
    if (dictating) {
      if (dictationRecorderRef.current?.state === "recording") {
        dictationRecorderRef.current.stop();
        return;
      }
      recognitionRef.current?.stop();
      return;
    }
    if (transcribingDictation) return;
    if ((dictationMicrophoneId || nativeDictationFailedRef.current) && await startRecordedDictation()) return;
    const Recognition = documentSpeechRecognition();
    if (Recognition) {
      setDictationError("");
      dictationPrefixRef.current = brief.trim();
      const recognition = new Recognition();
      recognition.lang = "pt-BR";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => setDictating(true);
      recognition.onend = () => {
        setDictating(false);
        recognitionRef.current = null;
      };
      recognition.onerror = (event) => {
        setDictating(false);
        recognitionRef.current = null;
        nativeDictationFailedRef.current = event.error !== "not-allowed" && event.error !== "service-not-allowed";
        setDictationError(
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "Permita o uso do microfone para ditar o conteúdo."
            : "O reconhecimento direto do navegador foi interrompido. Pressione Falar novamente para usar a transcrição segura.",
        );
      };
      recognition.onresult = (event) => {
        let transcript = "";
        for (let index = 0; index < event.results.length; index += 1) {
          transcript += `${event.results[index][0].transcript} `;
        }
        const spoken = transcript.trim();
        if (spoken) {
          nativeDictationFailedRef.current = false;
          setBrief([dictationPrefixRef.current, spoken].filter(Boolean).join(" "));
        }
      };
      recognitionRef.current = recognition;
      try {
        recognition.start();
        return;
      } catch {
        recognitionRef.current = null;
        setDictating(false);
        nativeDictationFailedRef.current = true;
      }
    }
    if (await startRecordedDictation()) return;
    setDictationError("Nenhum mecanismo de voz está disponível neste navegador. Atualize o Chrome ou Edge e tente novamente.");
  }

  useEffect(() => {
    const pendingBrainstormId = window.localStorage.getItem("norium:commercial-brainstorm-id") || "";
    if (!pendingBrainstormId || optionsLoading) return;
    if (brainstorms.some((item) => item.id === pendingBrainstormId)) setBrainstormId(pendingBrainstormId);
    window.localStorage.removeItem("norium:commercial-brainstorm-id");
  }, [brainstorms, optionsLoading]);

  function requestInput(): SmartDocumentInput {
    return {
      templateId,
      clientId,
      title: title.trim(),
      brief: brief.trim(),
      details: details.trim(),
      amount,
      currency: "BRL",
      validUntil: validUntil || null,
      tone,
      photoDataUrl: isResume ? photoDataUrl : "",
      primaryColor,
      secondaryColor,
      textColor,
    };
  }

  async function choosePhoto(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 1_450_000) {
      setLocalError("Use uma foto JPG, PNG ou WebP de até 1,4 MB.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
      reader.readAsDataURL(file);
    });
    setPhotoDataUrl(dataUrl);
    setLocalError("");
  }

  function selectBrand(nextId: string) {
    setBrandId(nextId);
    const brand = brands.find((item) => item.id === nextId);
    const nextBranding = brand?.branding || brandingForTemplate(selectedTemplate);
    setPrimaryColor(nextBranding.primaryColor);
    setSecondaryColor(nextBranding.secondaryColor);
    setTextColor(nextBranding.textColor);
  }

  function selectTemplate(nextId: string) {
    setTemplateId(nextId);
    setDraft(null);
    if (brandId) return;
    const nextBranding = brandingForTemplate(availableTemplates.find((item) => item.id === nextId));
    setPrimaryColor(nextBranding.primaryColor);
    setSecondaryColor(nextBranding.secondaryColor);
    setTextColor(nextBranding.textColor);
  }

  async function generateDraft() {
    if (!templateId || brief.trim().length < 3) {
      setLocalError("Escolha um modelo e descreva o essencial em pelo menos três caracteres.");
      return;
    }
    setGenerating(true);
    setLocalError("");
    try {
      const response = await generateSmartDocumentDraft(requestInput());
      setDraft(response.draft);
    } catch (requestError) {
      setLocalError(messageFromError(requestError, "A Nora não conseguiu gerar esta primeira versão."));
    } finally {
      setGenerating(false);
    }
  }

  function submit() {
    if (!draft || !selectedTemplate) return;
    const baseBranding = selectedBrand?.branding || brandingForTemplate(selectedTemplate);
    onCreate({
      clientId: clientId || "__workspace__",
      brainstormId: brainstormId || null,
      title: draft.title,
      contentHtml: draft.contentHtml,
      scopeSummary: draft.summary,
      amount: draft.amount,
      currency: draft.currency,
      validUntil: draft.validUntil,
      brandProfileId: brandId || null,
      branding: {
        ...baseBranding,
        logoUrl: isResume && photoDataUrl ? photoDataUrl : baseBranding.logoUrl,
        logoAlignment: isResume && photoDataUrl ? "center" : baseBranding.logoAlignment,
        logoScale: isResume && photoDataUrl ? 112 : baseBranding.logoScale,
        primaryColor,
        secondaryColor,
        textColor,
      },
      signers: selectedTemplate.requiresClient && client?.email ? [{ name: client.name || client.company, email: client.email, role: "client", order: 1, required: true }] : [],
      deliverables: [],
      metadata: {
        createdByNora: true,
        documentType: draft.template.documentType,
        templateId: draft.template.id,
        templateCategory: draft.template.category,
        templateLayout: draft.template.layout,
        minimalBrief: brief.trim(),
        noraDraft: draft.noraComment,
        legalReview: draft.template.legalReview,
        photoAsPortrait: Boolean(isResume && photoDataUrl),
      },
    });
  }

  return (
    <Dialog
      title={draft ? `Revisar ${draft.template.name}` : "Criar documento com a Nora"}
      subtitle={draft ? "A primeira versão continua totalmente editável depois de criada." : "Escolha um modelo e escreva só o essencial. A Nora estrutura o restante e marca lacunas como “A definir”."}
      onClose={onClose}
      wide
    >
      {localError && <StatusBanner tone="error">{localError}</StatusBanner>}
      {optionsError && <StatusBanner tone="warning" action={<Button size="sm" variant="secondary" onClick={onRetryOptions}>Tentar novamente</Button>}>Clientes e sessões opcionais não puderam ser carregados. Você ainda pode gerar um documento sem vínculo.</StatusBanner>}
      {draft ? (
        <div className="mt-4 grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-wider text-cyan-400">Prévia editável</p><h3 className="mt-1 text-lg font-black">{draft.title}</h3></div><span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-bold">{draft.template.category}</span></div>
            <article
              className={`commercial-rich-editor commercial-draft-preview commercial-layout-${draft.template.layout || "classic"} max-h-[60dvh] overflow-y-auto rounded-lg bg-white p-6 text-slate-900 shadow-inner`}
              style={{ borderTop: `7px solid ${primaryColor}`, "--document-primary": primaryColor, "--document-secondary": secondaryColor, "--document-text": textColor } as CSSProperties}
            >
              {isResume && photoDataUrl && <div data-document-decoration className="mb-5 flex justify-end"><img src={photoDataUrl} alt="Foto do currículo na prévia" className="h-28 w-28 rounded-full border-[5px] object-cover" style={{ borderColor: secondaryColor }} /></div>}
              <div dangerouslySetInnerHTML={{ __html: draft.contentHtml }} />
            </article>
          </section>
          <aside className="space-y-3">
            <ReviewBlock label="Comentário da Nora" value={draft.noraComment} accent />
            <ReviewBlock label="Tipo" value={draft.template.name} />
            <ReviewBlock label="Resumo" value={draft.summary} />
            {draft.template.legalReview && <StatusBanner tone="warning">Revise esta minuta com profissional habilitado antes de assinar ou publicar.</StatusBanner>}
            <div className="flex flex-col gap-2 pt-2 sm:flex-row"><Button variant="ghost" onClick={() => setDraft(null)}>Voltar e ajustar</Button><Button loading={busy} onClick={submit}>Criar e editar</Button></div>
          </aside>
        </div>
      ) : (
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="space-y-4">
            <FormField label={`Modelo (${availableTemplates.length} disponíveis)`}>
              <select value={templateId} onChange={(event) => selectTemplate(event.target.value)} className="commercial-field">
                {groupedTemplates.map(([category, items]) => <optgroup key={category} label={category}>{items.map((item) => <option key={item.id} value={item.id}>{item.featured ? "★ " : ""}{item.name}</option>)}</optgroup>)}
              </select>
            </FormField>
            <FormField label="Conte o essencial">
              <div className="relative">
                <textarea aria-label="Conte o essencial" value={brief} onChange={(event) => setBrief(event.target.value)} className="commercial-field min-h-32 resize-y pr-36" placeholder={isResume ? "Ex.: João Silva, desenvolvedor front-end, 4 anos com React, trabalhou na Empresa X, formado em ADS. Quero um currículo azul." : "Ex.: Proposta de site para a Clínica Aurora, com agenda online, entrega em 45 dias e valor de R$ 12 mil."} />
                <button
                  type="button"
                  onClick={() => void toggleDictation()}
                  aria-pressed={dictating}
                  aria-label={dictating ? "Parar ditado" : transcribingDictation ? "Transcrevendo ditado" : "Ditar conteúdo essencial"}
                  disabled={transcribingDictation}
                  className={`absolute right-3 top-3 inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-black transition ${dictating ? "border-rose-300/50 bg-rose-400/15 text-rose-100" : "border-cyan-300/35 bg-[var(--surface)] text-cyan-200 hover:bg-cyan-400/10"}`}
                >
                  {dictating ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
                  {dictating ? "Parar" : transcribingDictation ? "Transcrevendo" : "Falar"}
                </button>
              </div>
              <p className={`mt-2 text-xs font-semibold ${dictationError ? "text-rose-300" : dictating ? "text-cyan-200" : "text-[var(--text-secondary)]"}`} role={dictationError ? "alert" : "status"}>
                {dictationError || (transcribingDictation ? "Transcrevendo com segurança…" : dictating ? "Ouvindo… descreva livremente e pressione Parar ao terminar." : "Use o microfone ou escreva. A Nora classifica cada informação na seção correta.")}
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="min-w-56 flex-1 text-[11px] font-bold text-[var(--text-secondary)]"><span className="mb-1 block">Microfone do ditado</span><select aria-label="Microfone do ditado" value={dictationMicrophoneId} disabled={dictating || transcribingDictation} onChange={(event) => setDictationMicrophoneId(event.target.value)} className="commercial-field h-10"><option value="">Padrão do sistema</option>{dictationMicrophones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label>
                <button type="button" disabled={dictating || transcribingDictation} onClick={() => void refreshDictationMicrophones()} className="h-10 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">Atualizar microfones</button>
              </div>
            </FormField>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Título (opcional)"><input value={title} onChange={(event) => setTitle(event.target.value)} className="commercial-field" placeholder="A Nora pode sugerir" /></FormField>
              <FormField label="Cliente ou pessoa (opcional)"><select value={clientId} disabled={optionsLoading} onChange={(event) => setClientId(event.target.value)} className="commercial-field"><option value="">Sem vínculo</option>{clients.map((item) => <option key={item.id} value={item.id}>{item.name}{item.company ? ` · ${item.company}` : ""}</option>)}</select></FormField>
            </div>
            {isResume && <FormField label="Foto do currículo (opcional)"><div className="flex flex-wrap items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold hover:bg-[var(--surface-hover)]"><ImagePlus size={15} /> Escolher foto<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => void choosePhoto(event.target.files?.[0])} /></label>{photoDataUrl && <><img src={photoDataUrl} alt="Prévia da foto" className="h-14 w-14 rounded-full border-2 object-cover" style={{ borderColor: secondaryColor }} /><Button size="sm" variant="ghost" onClick={() => setPhotoDataUrl("")}>Remover</Button></>}</div></FormField>}
            <button type="button" className="text-xs font-bold text-cyan-300" onClick={() => setAdvanced((current) => !current)}>{advanced ? "Ocultar opções" : "Cores e opções adicionais"}</button>
            {advanced && <div className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
              {selectedTemplate?.branding && <button type="button" onClick={() => selectBrand("")} className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-xs font-bold hover:border-cyan-400" aria-label={`Aplicar paleta ${selectedTemplate.paletteName || selectedTemplate.name}`}>
                <span><span className="block">Paleta do modelo</span><small className="font-semibold text-[var(--text-secondary)]">{selectedTemplate.paletteName || "Editorial"}</small></span>
                <span className="flex overflow-hidden rounded-full border border-white/10">{[selectedTemplate.branding.primaryColor, selectedTemplate.branding.secondaryColor, selectedTemplate.branding.textColor].map((color) => <span key={color} className="h-6 w-7" style={{ backgroundColor: color }} />)}</span>
              </button>}
              <div className="grid gap-3 sm:grid-cols-3"><FormField label="Cor principal"><input type="color" value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} className="commercial-field h-11 p-1" /></FormField><FormField label="Destaque"><input type="color" value={secondaryColor} onChange={(event) => setSecondaryColor(event.target.value)} className="commercial-field h-11 p-1" /></FormField><FormField label="Texto"><input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} className="commercial-field h-11 p-1" /></FormField></div>
              <FormField label="Marca"><select value={brandId} onChange={(event) => selectBrand(event.target.value)} className="commercial-field"><option value="">Identidade padrão</option>{brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
              <FormField label="Detalhes adicionais"><textarea value={details} onChange={(event) => setDetails(event.target.value)} className="commercial-field min-h-20 resize-y" placeholder="Preferências, limites ou observações — tudo opcional." /></FormField>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><FormField label="Valor"><input type="number" min="0" value={amount} onChange={(event) => setAmount(Number(event.target.value))} className="commercial-field" /></FormField><FormField label="Validade"><input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="commercial-field" /></FormField><FormField label="Tom"><select value={tone} onChange={(event) => setTone(event.target.value as SmartDocumentInput["tone"])} className="commercial-field"><option value="consultive">Consultivo</option><option value="executive">Executivo</option><option value="technical">Técnico</option><option value="friendly">Próximo</option></select></FormField><FormField label="Estúdio"><select value={brainstormId} onChange={(event) => setBrainstormId(event.target.value)} className="commercial-field"><option value="">Sem vínculo</option>{brainstorms.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField></div>
            </div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={generating} disabled={!templateId || brief.trim().length < 3} onClick={() => void generateDraft()} icon={<Sparkles size={15} />}>Gerar primeira versão</Button></div>
          </section>
          <aside className="space-y-3 rounded-lg border border-cyan-400/20 bg-cyan-500/5 p-4">
            <p className="text-xs font-black uppercase tracking-wider text-cyan-300">{selectedTemplate?.name || "Modelo"}</p>
            <p className="text-sm font-semibold leading-6">{selectedTemplate?.description}</p>
            <p className="text-xs font-semibold leading-5 text-[var(--text-secondary)]">{selectedTemplate?.generationGuide || "A Nora organiza o conteúdo com base somente nas informações fornecidas."}</p>
            <div className="flex flex-wrap gap-2">{selectedTemplate?.sections?.slice(0, 6).map((section) => <span key={section} className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold">{section}</span>)}</div>
            <p className="border-t border-[var(--border)] pt-3 text-xs font-semibold text-[var(--text-secondary)]">Foto, logo, cores, texto, páginas e assinantes continuam editáveis depois da criação.</p>
          </aside>
        </div>
      )}
    </Dialog>
  );
}

export function CreateProposalDialog({
  clients,
  brainstorms,
  optionsLoading,
  optionsError,
  onRetryOptions,
  templates,
  brands,
  busy,
  onClose,
  onCreate,
}: {
  clients: ClientOption[];
  brainstorms: BrainstormOption[];
  optionsLoading: boolean;
  optionsError: string;
  onRetryOptions: () => void;
  templates: CommercialTemplate[];
  brands: Array<{ id: string; name: string; branding: typeof defaultBranding }>;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: CreateInput) => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id || "");
  const [brainstormId, setBrainstormId] = useState("");
  const [pendingBrainstormId] = useState(() => window.localStorage.getItem("norium:commercial-brainstorm-id") || "");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [scopeNotes, setScopeNotes] = useState("");
  const [team, setTeam] = useState("");
  const [deadline, setDeadline] = useState("");
  const [deliverablesNotes, setDeliverablesNotes] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [notes, setNotes] = useState("");
  const [amount, setAmount] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [tone, setTone] = useState<ProposalBriefInput["tone"]>("consultive");
  const [templateId, setTemplateId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [draft, setDraft] = useState<ProposalDraft | null>(null);
  const [generating, setGenerating] = useState(false);
  const [localError, setLocalError] = useState("");
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false);
  const proposalTemplates = templates.filter((item) => item.documentType !== "contract");
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const guidance = templateGuidance(selectedTemplate);
  const selectedBrand = brands.find((item) => item.id === brandId);
  const client = clients.find((item) => item.id === clientId);

  useEffect(() => {
    if (!clientId && clients[0]) setClientId(clients[0].id);
  }, [clientId, clients]);

  useEffect(() => {
    if (optionsLoading || optionsError || !pendingBrainstormId) return;
    if (brainstorms.some((item) => item.id === pendingBrainstormId)) {
      setBrainstormId(pendingBrainstormId);
    }
    window.localStorage.removeItem("norium:commercial-brainstorm-id");
  }, [brainstorms, optionsError, optionsLoading, pendingBrainstormId]);

  function selectBrainstorm(nextId: string) {
    setBrainstormId(nextId);
    const brainstorm = brainstorms.find((item) => item.id === nextId);
    if (!brainstorm) return;
    if (!title.trim()) setTitle(brainstorm.title);
    if (!objective.trim() && brainstorm.objective) setObjective(brainstorm.objective);
  }

  async function generateDraft() {
    if (!clientId || objective.trim().length < 10 || scopeNotes.trim().length < 10) {
      setLocalError("Informe o cliente, o objetivo e o escopo com pelo menos 10 caracteres.");
      return;
    }
    setGenerating(true);
    setLocalError("");
    try {
      const response = await generateProposalDraft({
        clientId,
        brainstormId: brainstormId || null,
        title: title.trim(),
        objective: objective.trim(),
        scopeNotes: scopeNotes.trim(),
        team: team.trim(),
        deadline: deadline.trim(),
        deliverablesNotes: deliverablesNotes.trim(),
        exclusions: exclusions.trim(),
        notes: [
          notes.trim(),
          selectedTemplate
            ? `Modelo selecionado: ${selectedTemplate.name}. Categoria: ${selectedTemplate.category || "geral"}. ${guidance.prompt}`
            : guidance.prompt,
        ].filter(Boolean).join("\n\n"),
        amount,
        currency: "BRL",
        tone,
      });
      setDraft(response.draft);
    } catch (requestError) {
      setLocalError(messageFromError(requestError, "A Nora não conseguiu detalhar este briefing."));
    } finally {
      setGenerating(false);
    }
  }

  function submit() {
    if (!draft || !clientId) return;
    const templateHtml = selectedTemplate?.generationContentHtml || selectedTemplate?.contentHtml || "";
    const contentHtml = templateHtml
      ? templateHtml.includes("{{NORA_CONTENT}}")
        ? templateHtml.replace("{{NORA_CONTENT}}", draft.contentHtml)
        : `${templateHtml}${draft.contentHtml}`
      : draft.contentHtml;
    onCreate({
      clientId,
      brainstormId: brainstormId || null,
      title: draft.title,
      contentHtml,
      scopeSummary: draft.scopeSummary,
      amount: draft.amount,
      currency: draft.currency,
      validUntil: validUntil || null,
      brandProfileId: brandId || null,
      branding: selectedBrand?.branding || defaultBranding,
      signers: client?.email ? [{ name: client.name, email: client.email, role: "client", order: 1, required: true }] : [],
      deliverables: draft.deliverables,
      metadata: {
        briefing: draft.briefing,
        noraDraft: draft.noraComment,
        templateId: selectedTemplate?.id || null,
        templateCategory: selectedTemplate?.category || null,
      },
    });
  }

  return (
    <Dialog
      title={draft ? "Revise antes de gerar a proposta" : "Briefing da nova proposta"}
      subtitle={draft ? "Nada foi salvo ainda. Confirme a prévia detalhada pela Nora." : "A sessão do Estúdio é opcional e só será vinculada se você a selecionar."}
      onClose={onClose}
      wide
    >
      {optionsLoading ? (
        <LoadingState label="Carregando clientes e brainstorms..." />
      ) : optionsError ? (
        <StatusBanner tone="error" action={<Button size="sm" variant="secondary" onClick={onRetryOptions}>Tentar novamente</Button>}>{optionsError}</StatusBanner>
      ) : !clients.length ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-sm font-bold text-amber-300">Cadastre ao menos um cliente na tela Clientes antes de criar a proposta.</div>
      ) : draft ? (
        <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-xs font-bold uppercase tracking-wider text-cyan-400">Prévia do documento</p><h3 className="mt-1 text-lg font-black">{draft.title}</h3></div>
              <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-bold">{selectedTemplate?.name || "Estrutura da Nora"}</span>
            </div>
            <article className="commercial-rich-editor max-h-[58dvh] overflow-y-auto rounded-lg bg-white p-6 text-slate-900 shadow-inner" dangerouslySetInnerHTML={{ __html: draft.contentHtml }} />
          </section>
          <aside className="space-y-3">
            <ReviewBlock label="Comentário da Nora" value={draft.noraComment} accent />
            <ReviewBlock label="Resumo do escopo" value={draft.scopeSummary} />
            <ReviewBlock label="Equipe e responsabilidades" value={draft.teamPlan || "A definir"} />
            <ReviewBlock label="Prazo e etapas" value={draft.timeline || "A definir"} />
            <ReviewBlock label="Entregáveis" value={draft.deliverables.map((item) => item.title).join("\n") || "A definir"} />
            <div className="flex flex-col gap-2 pt-2 sm:flex-row"><Button variant="ghost" onClick={() => setDraft(null)}>Voltar e ajustar</Button><Button loading={busy} onClick={submit}>Gerar proposta</Button></div>
          </aside>
        </div>
      ) : (
        <div className="space-y-4">
          {localError && <StatusBanner tone="error">{localError}</StatusBanner>}
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Cliente"><select value={clientId} onChange={(event) => setClientId(event.target.value)} className="commercial-field">{clients.map((item) => <option key={item.id} value={item.id}>{item.name}{item.company ? ` - ${item.company}` : ""}</option>)}</select></FormField>
            <FormField label="Sessão do Estúdio (opcional)"><select value={brainstormId} onChange={(event) => selectBrainstorm(event.target.value)} className="commercial-field"><option value="">Não vincular</option>{brainstorms.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField>
          </div>
          <FormField label="Título (opcional)"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="A Nora também pode sugerir o título" className="commercial-field" /></FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Objetivo da proposta"><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder={guidance.objective} className="commercial-field min-h-28 resize-y" /></FormField>
            <FormField label="Escopo inicial"><textarea value={scopeNotes} onChange={(event) => setScopeNotes(event.target.value)} placeholder={guidance.scope} className="commercial-field min-h-28 resize-y" /></FormField>
            <FormField label="Equipe e responsabilidades"><textarea value={team} onChange={(event) => setTeam(event.target.value)} placeholder={guidance.team} className="commercial-field min-h-24 resize-y" /></FormField>
            <FormField label="Entregáveis"><textarea value={deliverablesNotes} onChange={(event) => setDeliverablesNotes(event.target.value)} placeholder={guidance.deliverables} className="commercial-field min-h-24 resize-y" /></FormField>
            <FormField label="Prazo e etapas"><textarea value={deadline} onChange={(event) => setDeadline(event.target.value)} placeholder={guidance.deadline} className="commercial-field min-h-20 resize-y" /></FormField>
            <FormField label="Fora do escopo"><textarea value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder={guidance.exclusions} className="commercial-field min-h-20 resize-y" /></FormField>
          </div>
          <FormField label="Contexto adicional para a Nora"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Preferências do cliente, margem, riscos ou condições especiais." className="commercial-field min-h-20 resize-y" /></FormField>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Valor"><input value={amount} onChange={(event) => setAmount(Number(event.target.value))} type="number" min="0" className="commercial-field" /></FormField>
            <FormField label="Validade"><input value={validUntil} onChange={(event) => setValidUntil(event.target.value)} type="date" className="commercial-field" /></FormField>
            <FormField label="Tom de voz"><select value={tone} onChange={(event) => setTone(event.target.value as ProposalBriefInput["tone"])} className="commercial-field"><option value="consultive">Consultivo</option><option value="executive">Executivo</option><option value="technical">Técnico</option><option value="friendly">Próximo e cordial</option></select></FormField>
            <FormField label="Marca"><select value={brandId} onChange={(event) => setBrandId(event.target.value)} className="commercial-field"><option value="">Identidade padrão</option>{brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
          </div>
          <FormField label="Modelo por categoria"><select value={templateId} onChange={(event) => { setTemplateId(event.target.value); setTemplatePreviewOpen(false); }} className="commercial-field"><option value="">Estrutura inteligente da Nora</option>{proposalTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
          <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/8 px-4 py-3">
            <p className="text-xs font-black uppercase tracking-wide text-cyan-300">Como este modelo orienta a proposta</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{guidance.summary}</p>
          </div>
          {selectedTemplate && (
            <section className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold">{selectedTemplate.name}</p>
                  <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{selectedTemplate.description}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setTemplatePreviewOpen((current) => !current)}>
                  {templatePreviewOpen ? "Ocultar prévia" : "Visualizar modelo"}
                </Button>
              </div>
              {templatePreviewOpen && <div className="mt-4"><TemplateA4Preview template={selectedTemplate} compact /></div>}
            </section>
          )}
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={generating} disabled={!clientId || objective.trim().length < 10 || scopeNotes.trim().length < 10} onClick={() => void generateDraft()} icon={<Sparkles size={15} />}>Detalhar com a Nora</Button></div>
        </div>
      )}
    </Dialog>
  );
}

function ReviewBlock({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <section className={`rounded-lg border p-3 ${accent ? "border-cyan-400/30 bg-cyan-500/10" : "border-[var(--border)] bg-[var(--background)]"}`}><p className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">{label}</p><p className="mt-2 whitespace-pre-line text-xs font-semibold leading-5">{value}</p></section>;
}

type CreateInput = Parameters<typeof createProposal>[0];

export function LegacyCreateProposalDialog({
  clients,
  brainstorms,
  templates,
  brands,
  busy,
  onClose,
  onCreate,
}: {
  clients: ClientOption[];
  brainstorms: BrainstormOption[];
  templates: Array<{ id: string; name: string; contentHtml: string }>;
  brands: Array<{ id: string; name: string; branding: typeof defaultBranding }>;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: CreateInput) => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id || "");
  const [brainstormId, setBrainstormId] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [brandId, setBrandId] = useState("");
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const selectedBrand = brands.find((item) => item.id === brandId);
  const client = clients.find((item) => item.id === clientId);

  function submit() {
    if (!clientId || !title.trim()) return;
    onCreate({
      clientId,
      brainstormId: brainstormId || null,
      title: title.trim(),
      contentHtml: selectedTemplate?.contentHtml || `<h2>Proposta comercial</h2><p>Prezado(a) ${client?.name || "cliente"},</p><p>Apresentamos a seguir o escopo, os entregaveis e as condicoes desta proposta.</p><h2>Escopo</h2><p>Descreva aqui o que sera realizado.</p><h2>Investimento</h2><p>Detalhe as condicoes comerciais.</p>`,
      scopeSummary: "",
      amount,
      currency: "BRL",
      validUntil: validUntil || null,
      brandProfileId: brandId || null,
      branding: selectedBrand?.branding || defaultBranding,
      signers: [],
      deliverables: [],
      metadata: {},
    });
  }

  return (
    <Dialog title="Nova proposta comercial" subtitle="Vincule a origem e comece com dados consistentes." onClose={onClose}>
      {!clients.length ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-sm font-bold text-amber-300">Cadastre ao menos um cliente na tela Clientes antes de criar a proposta.</div>
      ) : (
        <div className="space-y-4">
          <FormField label="Cliente"><select value={clientId} onChange={(event) => setClientId(event.target.value)} className="commercial-field">{clients.map((item) => <option key={item.id} value={item.id}>{item.name}{item.company ? ` · ${item.company}` : ""}</option>)}</select></FormField>
          <FormField label="Sessão do Estúdio"><select value={brainstormId} onChange={(event) => setBrainstormId(event.target.value)} className="commercial-field"><option value="">Sem vinculo</option>{brainstorms.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField>
          <FormField label="Titulo"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Desenvolvimento de plataforma de e-commerce" className="commercial-field" /></FormField>
          <div className="grid grid-cols-2 gap-3"><FormField label="Valor"><input value={amount} onChange={(event) => setAmount(Number(event.target.value))} type="number" min="0" className="commercial-field" /></FormField><FormField label="Validade"><input value={validUntil} onChange={(event) => setValidUntil(event.target.value)} type="date" className="commercial-field" /></FormField></div>
          <FormField label="Modelo"><select value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="commercial-field"><option value="">Estrutura padrao</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
          <FormField label="Marca"><select value={brandId} onChange={(event) => setBrandId(event.target.value)} className="commercial-field"><option value="">Identidade padrao</option>{brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!clientId || !title.trim()} onClick={submit}>Criar e editar</Button></div>
        </div>
      )}
    </Dialog>
  );
}

function SignatureDialog({ contract, busy, onClose, onSubmit }: { contract: CommercialContract; busy: boolean; onClose: () => void; onSubmit: (signerId: string, name: string, email: string, signatureDataUrl: string) => void }) {
  const pending = contract.signers.filter((item) => item.status !== "signed").sort((a, b) => a.order - b.order);
  const [signerId, setSignerId] = useState(pending[0]?.id || "");
  const signer = pending.find((item) => item.id === signerId);
  const [name, setName] = useState(signer?.name || "");
  const [email, setEmail] = useState(signer?.email || "");
  const [consent, setConsent] = useState(false);
  const [signature, setSignature] = useState("");
  const [composing, setComposing] = useState(false);

  return (
    <Dialog title="Registrar assinatura" subtitle="O aceite gera uma entrada na trilha de auditoria." onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Assinante"><select value={signerId} onChange={(event) => { const next = pending.find((item) => item.id === event.target.value); setSignerId(event.target.value); setName(next?.name || ""); setEmail(next?.email || ""); }} className="commercial-field">{pending.map((item) => <option key={item.id} value={item.id}>{item.order}. {item.name} · {item.email}</option>)}</select></FormField>
        <FormField label="Nome confirmado"><input value={name} onChange={(event) => setName(event.target.value)} className="commercial-field" /></FormField>
        <FormField label="E-mail confirmado"><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" className="commercial-field" /></FormField>
        <div>{signature && <img src={signature} alt="Sua assinatura" className="mb-3 max-h-24 max-w-full rounded bg-white p-2"/>}<Button variant="secondary" onClick={() => setComposing(true)}>{signature ? "Alterar assinatura" : "Criar assinatura"}</Button></div>
        {composing && <SignatureComposer onClose={() => setComposing(false)} onApply={(dataUrl) => { setSignature(dataUrl); setComposing(false); }}/>}
        <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-semibold leading-5"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1" /> Confirmo a identidade informada e concordo em registrar esta assinatura eletronicamente.</label>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!signerId || !name.trim() || !email.trim() || !consent || !signature} onClick={() => onSubmit(signerId, name.trim(), email.trim(), signature)}>Assinar</Button></div>
      </div>
    </Dialog>
  );
}

function ContractGenerationDialog({
  proposal,
  templates,
  busy,
  onClose,
  onSubmit,
}: {
  proposal: CommercialProposal;
  templates: CommercialTemplate[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (templateId: string, title: string) => void;
}) {
  const category = String(proposal.metadata?.templateCategory || "");
  const suggested = templates.find((item) => item.category === category) || templates[0];
  const [templateId, setTemplateId] = useState(suggested?.id || "");
  const [title, setTitle] = useState(`Contrato - ${proposal.title}`);
  const [previewOpen, setPreviewOpen] = useState(false);
  const selectedTemplate = templates.find((item) => item.id === templateId);

  return (
    <Dialog title="Gerar contrato" subtitle="Escolha uma minuta-base. O contrato herdara cliente, escopo, valores e historico da proposta." onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Titulo do contrato">
          <input value={title} onChange={(event) => setTitle(event.target.value)} className="commercial-field" />
        </FormField>
        <FormField label="Modelo por categoria">
          <select value={templateId} onChange={(event) => { setTemplateId(event.target.value); setPreviewOpen(false); }} className="commercial-field">
            {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </FormField>
        {selectedTemplate && (
          <section className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-sm font-bold">{selectedTemplate.name}</p><p className="mt-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{selectedTemplate.description}</p></div>
              <Button size="sm" variant="secondary" onClick={() => setPreviewOpen((current) => !current)}>{previewOpen ? "Ocultar prévia" : "Visualizar modelo"}</Button>
            </div>
            <p className="mt-3 text-xs font-bold text-amber-300">Minuta operacional editavel. Revise as clausulas com assessoria juridica antes do uso real.</p>
            {previewOpen && <div className="mt-4"><TemplateA4Preview template={selectedTemplate} compact /></div>}
          </section>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={busy} disabled={!templateId || !title.trim()} onClick={() => onSubmit(templateId, title.trim())}>Gerar e editar</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SignatureLinksDialog({
  links,
  contractId,
  contractTitle,
  onClose,
}: {
  links: SignatureLink[];
  contractId: string;
  contractTitle: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState("");
  const [sendingTo, setSendingTo] = useState("");
  const [sentTo, setSentTo] = useState<string[]>([]);
  const [sendError, setSendError] = useState("");

  async function copyLink(link: SignatureLink) {
    await navigator.clipboard.writeText(link.url);
    setCopied(link.signerId);
    window.setTimeout(() => setCopied(""), 1800);
  }

  async function sendLinkByEmail(link: SignatureLink) {
    setSendingTo(link.signerId);
    setSendError("");
    try {
      await shareCommercialDocument("contract", contractId, {
        channel: "email",
        recipient: link.email,
        subject: `Assinatura pendente: ${contractTitle}`,
        message: `Olá ${link.name || ""}, segue o contrato "${contractTitle}" para sua assinatura. O link individual de assinatura está no final desta mensagem.`.trim(),
      });
      setSentTo((current) => [...current, link.signerId]);
    } catch (error) {
      setSendError(messageFromError(error, "Nao foi possivel enviar o e-mail para este assinante."));
    } finally {
      setSendingTo("");
    }
  }

  return (
    <Dialog title="Links de assinatura" subtitle="Envie o link individual ao respectivo assinante. Cada acesso expira automaticamente." onClose={onClose}>
      <div className="space-y-3">
        {links.map((link) => (
          <article key={link.signerId} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{link.name}</p>
                <p className="mt-1 truncate text-xs font-semibold text-[var(--text-secondary)]">{link.email}</p>
                <p className="mt-2 text-xs font-bold uppercase text-cyan-300">
                  Expira em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(link.expiresAt))}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="secondary"
                  loading={sendingTo === link.signerId}
                  disabled={Boolean(sendingTo) || sentTo.includes(link.signerId)}
                  onClick={() => void sendLinkByEmail(link)}
                  icon={<Send size={14} />}
                >
                  {sentTo.includes(link.signerId) ? "Enviado" : "Enviar e-mail"}
                </Button>
                <Button variant="secondary" onClick={() => void copyLink(link)} icon={<Link2 size={14} />}>
                  {copied === link.signerId ? "Copiado" : "Copiar"}
                </Button>
                <Button variant="secondary" onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")} icon={<ExternalLink size={14} />}>
                  Abrir
                </Button>
              </div>
            </div>
          </article>
        ))}
        {sendError && <StatusBanner tone="error">{sendError}</StatusBanner>}
        <div className="flex justify-end pt-2"><Button onClick={onClose}>Concluir</Button></div>
      </div>
    </Dialog>
  );
}

function InstantiateDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (projectId: string, projectName: string, calendar: boolean) => void }) {
  const [projectName, setProjectName] = useState("Contrato");
  const [calendar, setCalendar] = useState(true);
  return <Dialog title="Ativar contrato" subtitle="Transforme entregaveis em tarefas vinculadas." onClose={onClose}><div className="space-y-4"><FormField label="Projeto de destino"><input value={projectName} onChange={(event) => setProjectName(event.target.value)} className="commercial-field" /></FormField><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={calendar} onChange={(event) => setCalendar(event.target.checked)} /> Criar compromissos para entregaveis com prazo</label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!projectName.trim()} onClick={() => onSubmit(`contract_${projectName.trim().toLocaleLowerCase("pt-BR").replace(/\W+/g, "_")}`, projectName.trim(), calendar)}>Criar tarefas</Button></div></div></Dialog>;
}

function BrandProfileDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (name: string, isDefault: boolean) => void }) {
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  return <Dialog title="Novo perfil de marca" subtitle="Depois, personalize cores e logo dentro do documento." onClose={onClose}><div className="space-y-4"><FormField label="Nome da marca"><input value={name} onChange={(event) => setName(event.target.value)} className="commercial-field" /></FormField><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /> Usar como marca padrao</label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!name.trim()} onClick={() => onSubmit(name.trim(), isDefault)}>Criar perfil</Button></div></div></Dialog>;
}

function TemplateDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (name: string, description: string, shared: boolean, documentType: TemplateDocumentType, category: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState(false);
  const [documentType, setDocumentType] = useState<TemplateDocumentType>("proposal");
  const [category, setCategory] = useState("geral");
  return <Dialog title="Salvar novo modelo" subtitle="Crie uma estrutura reutilizável e classificada para a biblioteca." onClose={onClose}><div className="space-y-4"><FormField label="Nome"><input value={name} onChange={(event) => setName(event.target.value)} className="commercial-field" /></FormField><FormField label="Descrição"><textarea value={description} onChange={(event) => setDescription(event.target.value)} className="commercial-field min-h-20 resize-y" /></FormField><div className="grid gap-3 sm:grid-cols-2"><FormField label="Tipo"><select value={documentType} onChange={(event) => setDocumentType(event.target.value as TemplateDocumentType)} className="commercial-field">{(["proposal", "contract", "term", "budget", "report", "resume", "letter", "invoice", "receipt", "plan", "policy", "hr", "certificate", "meeting", "project", "marketing", "academic", "personal", "custom"] as TemplateDocumentType[]).map((type) => <option key={type} value={type}>{templateTypeLabel(type)}</option>)}</select></FormField><FormField label="Categoria"><input value={category} onChange={(event) => setCategory(event.target.value)} className="commercial-field" /></FormField></div><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /> Compartilhar com a empresa</label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!name.trim()} onClick={() => onSubmit(name.trim(), description.trim(), shared, documentType, category.trim() || "geral")}>Salvar modelo</Button></div></div></Dialog>;
}

function ImportDocumentDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (input: { file: File; category: UploadedDocument["category"]; direction: UploadedDocument["direction"]; confidential: boolean }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<UploadedDocument["category"]>("pdf");
  const [direction, setDirection] = useState<UploadedDocument["direction"]>("internal");
  const [confidential, setConfidential] = useState(false);
  const supported = file ? ["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.type) : false;
  return <Dialog title="Importar documento" subtitle="PDFs e imagens ficam privados no workspace e passam por validacao de tipo e assinatura." onClose={onClose}><div className="space-y-4"><FormField label="Arquivo"><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] || null)} className="commercial-field p-2" /></FormField>{file && !supported && <StatusBanner tone="error">Formato nao permitido. Selecione PDF, PNG, JPG ou WebP.</StatusBanner>}<div className="grid gap-3 sm:grid-cols-2"><FormField label="Categoria"><select value={category} onChange={(event) => setCategory(event.target.value as UploadedDocument["category"])} className="commercial-field"><option value="pdf">PDF / Arquivo</option><option value="draft">Rascunho</option><option value="sent">Enviado</option><option value="received">Recebido</option><option value="archived">Arquivado</option></select></FormField><FormField label="Origem"><select value={direction} onChange={(event) => setDirection(event.target.value as UploadedDocument["direction"])} className="commercial-field"><option value="internal">Interno</option><option value="sent">Enviado</option><option value="received">Recebido</option></select></FormField></div><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={confidential} onChange={(event) => setConfidential(event.target.checked)} /> Documento confidencial</label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!file || !supported} onClick={() => file && onSubmit({ file, category, direction, confidential })} icon={<Upload size={14} />}>Importar</Button></div></div></Dialog>;
}

function Dialog({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="nxd-modal-backdrop fixed inset-0 z-[120] grid place-items-center p-4" onClick={onClose}><section className={`nx-card nxd-modal w-full ${wide ? "max-w-6xl" : "max-w-xl"}`} onClick={(event) => event.stopPropagation()}><header className="flex items-start justify-between gap-3 border-b border-[var(--nx-border)] px-5 py-4"><div><h2 className="text-[16px] font-semibold">{title}</h2><p className="mt-1 text-[12.5px] text-[var(--nx-text-2)]">{subtitle}</p></div><Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar"><X size={17} /></Button></header><div className="max-h-[82dvh] overflow-y-auto p-5">{children}</div></section></div>;
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[12.5px] font-medium text-[var(--nx-text-2)]">{label}</span>{children}</label>;
}

function Metric({ label, value, icon: Icon, onClick, tone = "blue" }: { label: string; value: number; icon: typeof FileSignature; onClick?: () => void; tone?: string }) {
  return <button type="button" data-metric-tone={tone} onClick={onClick} className="nx-card nx-kpi nxd-kpi"><span className="nx-kpi-l"><Icon size={16} className="nx-faint" />{label}</span><strong className="nx-kpi-v">{value}</strong></button>;
}

function ViewTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`nx-tab ${active ? "is-active" : ""}`}>{label}<span className="nxw-tab-count">{count}</span></button>;
}

function StatusChip({ status }: { status: string }) {
  const tone = ["signed", "active", "approved", "completed", "ready"].includes(status)
    ? "is-green"
    : ["rejected", "cancelled", "failed", "error"].includes(status)
      ? "is-red"
      : ["in_review", "negotiating", "awaiting_signatures", "pending", "processing"].includes(status)
        ? "is-amber"
        : "is-blue";
  return <span className={`nx-badge ${tone}`}>{statusLabels[status] || status}</span>;
}

function templateTypeLabel(value: TemplateDocumentType) {
  const labels: Record<TemplateDocumentType, string> = {
    proposal: "Proposta", contract: "Contrato", term: "Termo", budget: "Orçamento", report: "Relatório",
    resume: "Currículo", letter: "Carta", invoice: "Fatura", receipt: "Recibo", plan: "Plano",
    policy: "Política", hr: "RH", certificate: "Certificado", meeting: "Reunião", project: "Projeto",
    marketing: "Marketing", academic: "Acadêmico", personal: "Pessoal", custom: "Documento",
  };
  return labels[value];
}


function DocumentCover({ label, primaryColor = "#1266f1", secondaryColor = "#22d3ee" }: { label: string; primaryColor?: string; secondaryColor?: string }) {
  return (
    <span className="relative grid aspect-[210/297] h-20 shrink-0 place-items-center overflow-hidden rounded border border-slate-300/25 bg-slate-100 text-center text-[5px] font-black uppercase leading-tight text-slate-700 shadow-lg">
      <span className="absolute left-0 top-0 h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${primaryColor}, ${secondaryColor})` }} />
      <span className="absolute bottom-1.5 left-1.5 h-7 w-1 rounded-full" style={{ background: secondaryColor }} />
      <span className="px-1">{label}</span>
    </span>
  );
}

function DocumentPreviewButton({
  title,
  label,
  primaryColor,
  onClick,
  className = "",
}: {
  title: string;
  label: string;
  primaryColor?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 text-left transition hover:border-blue-400/35 hover:bg-blue-500/5 ${className}`}
      aria-label={`Visualizar pre-visualizacao de ${title}`}
    >
      <DocumentCover label={label} primaryColor={primaryColor} />
      <span className="min-w-0">
        <strong className="block truncate text-xs font-medium">Pré-visualização</strong>
        <small className="mt-1 block truncate text-[var(--nx-text-3)]">Documento A4</small>
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--nx-primary-text)]"><Eye size={13} /> Visualizar</span>
      </span>
    </button>
  );
}

function LibraryView({
  title,
  description,
  icon: Icon,
  items,
  actionLabel,
  onAction,
  onItemClick,
}: {
  title: string;
  description: string;
  icon: typeof Palette;
  items: Array<{ id: string; title: string; description: string; template?: CommercialTemplate }>;
  actionLabel: string;
  onAction: () => void;
  onItemClick?: (id: string) => void;
}) {
  return <div className="min-h-[480px] p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-black">{title}</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{description}</p></div><Button onClick={onAction} icon={<Plus size={14} />}>{actionLabel}</Button></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article key={item.id} className="grid min-h-48 grid-cols-[72px_minmax(0,1fr)] gap-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"><button type="button" disabled={!onItemClick} onClick={() => onItemClick?.(item.id)} className="self-start disabled:cursor-default" aria-label={onItemClick ? `Pre-visualizar ${item.title}` : undefined}>{item.template ? <DocumentCover label={templateTypeLabel(item.template.documentType)} primaryColor={item.template.branding?.primaryColor} secondaryColor={item.template.branding?.secondaryColor} /> : <span className="grid h-12 w-12 place-items-center rounded-lg bg-blue-500/10 text-blue-400"><Icon size={18} /></span>}</button><div className="min-w-0"><strong className="block truncate text-[13.5px] font-medium">{item.title}</strong>{item.template?.paletteName && <small className="mt-1 block truncate text-[11px] font-bold text-cyan-300">{item.template.paletteName}</small>}<p className="mt-2 line-clamp-3 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{item.description}</p>{onItemClick && <Button size="sm" variant="secondary" className="mt-4" onClick={() => onItemClick(item.id)} icon={<Eye size={14} />}>Visualizar em A4</Button>}</div></article>)}</div>{!items.length && <EmptyState title="Nenhum modelo encontrado" description="Ajuste a busca ou salve um modelo personalizado." icon={Icon} className="mt-5 min-h-72" />}</div>;
}

function TemplatePreviewDialog({ template, busy, onClose, onUse, onEditExample, onRename, onDuplicate, onDelete }: { template: CommercialTemplate; busy: boolean; onClose: () => void; onUse: () => void; onEditExample: () => void; onRename: () => void; onDuplicate: () => void; onDelete?: () => void }) {
  return (
    <Dialog
      title={template.name}
      subtitle="Prévia A4 preenchida com dados fictícios editáveis. Substitua tudo antes de enviar ou publicar."
      onClose={onClose}
      wide
    >
      <div className="mb-5 flex flex-wrap justify-end gap-2"><Button onClick={onEditExample} disabled={busy} icon={<Pencil size={14} />}>Editar este exemplo</Button><Button variant="secondary" onClick={onUse} disabled={busy} icon={<Sparkles size={14} />}>Gerar com meus dados</Button><Button variant="secondary" onClick={onRename} disabled={busy || template.id.startsWith("standard_")} icon={<Pencil size={14} />}>Renomear</Button><Button variant="secondary" onClick={onDuplicate} loading={busy} icon={<Copy size={14} />}>Duplicar</Button>{onDelete && <Button variant="danger" onClick={onDelete} disabled={busy} icon={<Trash2 size={14} />}>Excluir</Button>}</div>
      <TemplateA4Preview template={template} />
    </Dialog>
  );
}

function TemplateA4Preview({ template, compact = false }: { template: CommercialTemplate; compact?: boolean }) {
  const [loaded, setLoaded] = useState<CommercialTemplate | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const deferred = template.contentDeferred || (!template.contentHtml && template.id.startsWith("standard_"));
  useEffect(() => {
    if (!deferred) return;
    const controller = new AbortController();
    loadCommercialTemplate(template.id, controller.signal).then(({ template: detail }) => {
      if (!controller.signal.aborted) { setLoaded(detail); setLoadError(""); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(messageFromError(error, "Não foi possível carregar o modelo completo."));
    });
    return () => controller.abort();
  }, [deferred, template.id, retry]);
  const fullTemplate = deferred ? (loaded?.id === template.id ? loaded : null) : template;
  if (!fullTemplate) return <div className="rounded-lg border border-[var(--border)] p-6" role="status">{loadError ? <><p>{loadError}</p><Button className="mt-3" onClick={() => { setLoadError(""); setRetry((value) => value + 1); }}>Tentar novamente</Button></> : "Carregando documento completo de várias páginas…"}</div>;
  const content = sanitizeTemplateHtml(
    fullTemplate.contentHtml.replace(
      "{{NORA_CONTENT}}",
      "<h2>Conteúdo detalhado pela Nora</h2><p>O briefing aprovado será desenvolvido nesta seção, mantendo escopo, entregáveis, responsabilidades, prazos e condições comerciais.</p>",
    ),
  );
  const kind = templateTypeLabel(template.documentType);
  const previewBranding = {
    ...brandingForTemplate(fullTemplate),
    headerHtml: `<strong>${kind}</strong> · ${template.name}`,
    footerHtml: "Norium · exemplo fictício completo · texto e imagens editáveis",
  };
  return (
    <div className={compact ? "max-h-[56dvh] space-y-5 overflow-auto pr-1" : "space-y-7"}>
      {(template.documentType === "proposal" || template.documentType === "contract") && <section className="mx-auto w-full max-w-[794px]">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Página 1 · Capa A4</p>
        <article className="commercial-template-a4 flex aspect-[210/297] flex-col overflow-hidden bg-white p-8 text-slate-900 shadow-xl">
          <div className="h-2 w-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400" />
          <p className="mt-auto text-xs font-bold uppercase tracking-[0.18em] text-blue-600">{kind}</p>
          <h3 className="mt-3 text-2xl font-black leading-tight">{template.name}</h3>
          <div className="mt-7 border-l-4 border-cyan-500 py-2 pl-4"><strong className="block text-sm">Aurora Café & Co.</strong><span className="mt-1 block text-xs text-slate-500">Documento demonstrativo · Estúdio Horizonte</span></div>
          <div className="mt-auto grid grid-cols-2 gap-4 border-t border-slate-200 pt-5 text-xs"><span>Emissão automática</span><span className="text-right">Identidade da empresa</span></div>
        </article>
      </section>}
      <A4ContentPages
        title={template.name}
        contentHtml={content}
        branding={previewBranding}
        layout={fullTemplate.layout}
        compact
      />
    </div>
  );
}

function sanitizeTemplateHtml(value: string) {
  const parsed = new DOMParser().parseFromString(value || "", "text/html");
  parsed.querySelectorAll("script, style, iframe, object, embed, form").forEach((node) => node.remove());
  parsed.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLocaleLowerCase("pt-BR");
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        return;
      }
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return parsed.body.innerHTML;
}

function FloatingMessage({ kind, message, onClose }: { kind: "error" | "success"; message: string; onClose: () => void }) {
  return createPortal(<div role={kind === "error" ? "alert" : "status"} className={`nxw-alert nxd-toast ${kind === "error" ? "is-error" : "is-success"}`}><span className="min-w-0 flex-1">{message}</span><button type="button" className="shrink-0 p-2" onClick={onClose} aria-label="Fechar aviso"><X size={15} /></button></div>, document.body);
}

function messageFromError(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return fallback;
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL" }).format(value || 0);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatFileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo selecionado."));
    reader.readAsDataURL(file);
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
