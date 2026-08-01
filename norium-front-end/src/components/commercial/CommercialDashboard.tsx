import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  FileCheck2,
  FileClock,
  FilePlus2,
  FileSignature,
  Filter,
  ExternalLink,
  Link2,
  LayoutTemplate,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { apiRequest, ApiError } from "../../core/api/client";
import {
  analyzeProposal,
  createBrandProfile,
  createProposal,
  createTemplate,
  deleteProposal,
  decideProposal,
  decideSuggestion,
  generateContract,
  generateProposalDraft,
  instantiateContract,
  loadCommercialData,
  sendContractForSignature,
  shareCommercialDocument,
  signContract,
  submitProposal,
  updateContract,
  updateProposal,
  type DocumentUpdateInput,
} from "../../features/commercial/api";
import {
  defaultBranding,
  isProposal,
  type BrainstormOption,
  type ClientOption,
  type CommercialContract,
  type CommercialData,
  type CommercialDocument,
  type CommercialProposal,
  type CommercialTemplate,
  type ProposalBriefInput,
  type ProposalDraft,
  type SignatureLink,
} from "../../features/commercial/types";
import type { AuthSession } from "../../types/auth";
import Button from "../shared/Button";
import EmptyState from "../shared/EmptyState";
import LoadingState from "../shared/LoadingState";
import StatusBanner from "../shared/StatusBanner";
import { showConfirm, showPrompt } from "../shared/AppDialogProvider";
import A4ContentPages from "./A4ContentPages";
import CommercialEditor from "./CommercialEditor";

type View = "proposals" | "contracts" | "templates" | "brands";

type CommercialDashboardProps = {
  session: AuthSession;
  onOpenNora: (prompt?: string) => void;
};

const statusLabels: Record<string, string> = {
  draft: "Rascunho",
  in_review: "Em aprovacao",
  changes_requested: "Ajustes solicitados",
  approved: "Aprovada",
  rejected: "Rejeitada",
  sent: "Enviada",
  accepted: "Aceita",
  contracted: "Convertida",
  archived: "Arquivada",
  awaiting_signatures: "Aguardando assinaturas",
  signed: "Assinado",
  active: "Ativo",
  completed: "Concluido",
  cancelled: "Cancelado",
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

export default function CommercialDashboard({ session, onOpenNora }: CommercialDashboardProps) {
  const [data, setData] = useState<CommercialData | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [brainstorms, setBrainstorms] = useState<BrainstormOption[]>([]);
  const [view, setView] = useState<View>("proposals");
  const [selected, setSelected] = useState<CommercialDocument | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [instantiateOpen, setInstantiateOpen] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templatePreview, setTemplatePreview] = useState<CommercialTemplate | null>(null);
  const [contractProposal, setContractProposal] = useState<CommercialProposal | null>(null);
  const [signatureLinks, setSignatureLinks] = useState<SignatureLink[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const [commercial, clientResponse, brainstormResponse] = await Promise.all([
        loadCommercialData(signal),
        apiRequest<{ items: ClientOption[] }>("/api/clientes", { signal }).catch(() => ({ items: [] })),
        apiRequest<BrainstormOption[]>("/api/brainstorm/sessions", { signal }).catch(() => []),
      ]);
      setData(commercial);
      setClients(clientResponse.items || []);
      setBrainstorms(brainstormResponse || []);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError(messageFromError(requestError, "Nao foi possivel carregar propostas e contratos."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(""), 9000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const openFromBrainstorm = () => setCreateOpen(true);
    if (window.localStorage.getItem("norium:commercial-brainstorm-id")) {
      setCreateOpen(true);
    }
    window.addEventListener("norium:commercial-create", openFromBrainstorm);
    return () => window.removeEventListener("norium:commercial-create", openFromBrainstorm);
  }, []);

  const currentItems = useMemo<CommercialDocument[]>(() => {
    if (!data) return [];
    const source: CommercialDocument[] = view === "contracts" ? data.contracts : data.proposals;
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return source.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesQuery = !needle || `${item.title} ${item.client?.name || ""} ${item.client?.company || ""}`.toLocaleLowerCase("pt-BR").includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [data, query, statusFilter, view]);

  function replaceDocument(nextDocument: CommercialDocument) {
    setSelected(nextDocument);
    setData((current) => {
      if (!current) return current;
      if (isProposal(nextDocument)) {
        return { ...current, proposals: current.proposals.map((item) => item.id === nextDocument.id ? nextDocument : item) };
      }
      return { ...current, contracts: current.contracts.map((item) => item.id === nextDocument.id ? nextDocument : item) };
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
        proposals: current.proposals.map((item) => item.id === response.proposal.id ? response.proposal : item),
        contracts: [response.contract, ...current.contracts.filter((item) => item.id !== response.contract.id)],
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

  async function handleDeleteProposal(proposal: CommercialProposal) {
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

  if (selected) {
    return (
      <>
        <CommercialEditor
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
        />
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
            }, "Obrigacoes transformadas em tarefas e prazos.")}
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
    <main className="min-h-[calc(100dvh-74px)] bg-[var(--background)] p-4 text-[var(--text)] sm:p-6">
      <div className="mx-auto max-w-[1660px]">
        <header className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><FileSignature size={23} /></span>
            <div><h1 className="text-2xl font-black">Propostas e contratos</h1><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Do brainstorm ao documento assinado, com revisao da Nora e execucao das obrigacoes.</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load()} icon={<RefreshCw size={15} />}>Atualizar</Button>
            <Button variant="secondary" onClick={() => onOpenNora("Quero criar uma proposta comercial. Pergunte o cliente, origem no brainstorm, escopo, valor, validade, entregaveis e assinantes antes de abrir ou criar o documento.")} icon={<Sparkles size={15} />}>Pedir para Nora</Button>
            <Button onClick={() => setCreateOpen(true)} icon={<Plus size={16} />}>Nova proposta</Button>
          </div>
        </header>

        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        {notice && <StatusBanner tone="success">{notice}</StatusBanner>}

        {loading ? <LoadingState label="Carregando documentos comerciais..." /> : data && (
          <>
            <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Metric label="Propostas" value={data.summary.proposalCount} icon={FileSignature} />
              <Metric label="Rascunhos" value={data.summary.draftCount} icon={FileClock} />
              <Metric label="Em aprovacao" value={data.summary.reviewCount} icon={UsersRound} />
              <Metric label="Aprovadas" value={data.summary.approvedCount} icon={BadgeCheck} />
              <Metric label="Contratos" value={data.summary.contractCount} icon={FileCheck2} />
              <Metric label="Assinados" value={data.summary.signedCount} icon={FileCheck2} />
            </section>

            <section className="mt-5 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex flex-col gap-3 border-b border-[var(--border)] p-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex overflow-x-auto">
                  <ViewTab active={view === "proposals"} label="Propostas" count={data.proposals.length} onClick={() => { setView("proposals"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "contracts"} label="Contratos" count={data.contracts.length} onClick={() => { setView("contracts"); setStatusFilter("all"); }} />
                  <ViewTab active={view === "templates"} label="Modelos" count={data.templates.length} onClick={() => setView("templates")} />
                  <ViewTab active={view === "brands"} label="Marcas" count={data.brandProfiles.length} onClick={() => setView("brands")} />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3"><Search size={15} className="text-[var(--text-secondary)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por documento ou cliente" className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" /></label>
                  {(view === "proposals" || view === "contracts") && (
                    <label className="flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3"><Filter size={14} /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="commercial-status-select min-w-[150px] bg-transparent text-xs font-bold outline-none"><option value="all">Todos os status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  )}
                </div>
              </div>

              {(view === "proposals" || view === "contracts") && (
                <div className="min-h-[480px]">
                  {currentItems.map((item) => (
                    <article key={item.id} className="flex items-stretch border-b border-[var(--border)] transition hover:bg-[var(--surface-hover)]">
                      <button type="button" onClick={() => setSelected(item)} className="grid min-w-0 flex-1 gap-3 p-4 text-left md:grid-cols-[48px_minmax(0,1fr)_170px_150px_120px] md:items-center">
                        <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-500/10 text-blue-400">{isProposal(item) ? <FileSignature size={19} /> : <FileCheck2 size={19} />}</span>
                        <span className="min-w-0"><strong className="block truncate text-sm">{item.title}</strong><small className="mt-1 block truncate font-semibold text-[var(--text-secondary)]">{item.client?.name || "Cliente nao informado"} {item.brainstormId ? "- vinculado ao Brainstorm" : ""}</small></span>
                        <span className="text-xs font-bold">{formatMoney(item.amount, item.currency)}</span>
                        <span><StatusChip status={item.status} /></span>
                        <time className="text-xs font-bold text-[var(--text-secondary)]">{formatDate(item.updatedAt)}</time>
                      </button>
                      {isProposal(item) && !item.contractId && (
                        <Button variant="danger" iconOnly
                         
                          onClick={() => void handleDeleteProposal(item)}
                          className="m-3 self-center border-red-400/20 text-red-400 hover:bg-red-500/10"
                          aria-label={`Excluir proposta ${item.title}`}
                          title="Excluir proposta"
                        >
                          <Trash2 size={16} />
                        </Button>
                      )}
                    </article>
                  ))}
                  {!currentItems.length && <EmptyState title="Nenhum documento encontrado" description="Crie uma proposta ou ajuste os filtros." icon={FilePlus2} className="min-h-[430px] border-none" />}
                </div>
              )}

              {view === "templates" && (
                <LibraryView
                  title="Modelos inteligentes"
                  description="Reutilize estruturas comerciais pessoais ou compartilhadas pela empresa."
                  icon={LayoutTemplate}
                  items={data.templates.map((item) => ({ id: item.id, title: item.name, description: item.description || (item.shared ? "Modelo compartilhado" : "Modelo pessoal") }))}
                  actionLabel="Salvar modelo"
                  onAction={() => setTemplateOpen(true)}
                  onItemClick={(id) => setTemplatePreview(data.templates.find((item) => item.id === id) || null)}
                />
              )}

              {view === "brands" && (
                <LibraryView
                  title="Perfis de marca"
                  description={data.summary.planMode === "solo" ? "Seu plano permite um perfil de marca pessoal." : "Gerencie marcas e subsidiarias sem misturar identidades."}
                  icon={Palette}
                  items={data.brandProfiles.map((item) => ({ id: item.id, title: item.name, description: item.isDefault ? "Marca padrao" : item.branding.primaryColor }))}
                  actionLabel="Nova marca"
                  onAction={() => setBrandOpen(true)}
                />
              )}
            </section>
          </>
        )}
      </div>

      {createOpen && data && (
        <CreateProposalDialog
          clients={clients}
          brainstorms={brainstorms}
          templates={data.templates}
          brands={data.brandProfiles.map((item) => ({ id: item.id, name: item.name, branding: item.branding }))}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => void runAction(async () => {
            const response = await createProposal(input);
            setData((current) => current ? { ...current, proposals: [response.proposal, ...current.proposals], summary: { ...current.summary, proposalCount: current.summary.proposalCount + 1, draftCount: current.summary.draftCount + 1 } } : current);
            setCreateOpen(false);
            setSelected(response.proposal);
          }, "Proposta criada. O salvamento automatico esta ativo.")}
        />
      )}

      {brandOpen && <BrandProfileDialog busy={busy} onClose={() => setBrandOpen(false)} onSubmit={(name, isDefault) => void runAction(async () => {
        const response = await createBrandProfile(name, defaultBranding, isDefault);
        setData((current) => current ? { ...current, brandProfiles: [...current.brandProfiles, response.brandProfile] } : current);
        setBrandOpen(false);
      }, "Perfil de marca criado.")} />}

      {templateOpen && <TemplateDialog busy={busy} onClose={() => setTemplateOpen(false)} onSubmit={(name, description, shared) => void runAction(async () => {
        const response = await createTemplate(name, description, "<h1>Titulo da proposta</h1><p>Apresente o contexto, o escopo, os entregaveis e as condicoes comerciais.</p>", shared);
        setData((current) => current ? { ...current, templates: [...current.templates, response.template] } : current);
        setTemplateOpen(false);
      }, "Modelo salvo na biblioteca.")} />}
      {templatePreview && <TemplatePreviewDialog template={templatePreview} onClose={() => setTemplatePreview(null)} />}
    </main>
  );
}

function CreateProposalDialog({
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
  templates: CommercialTemplate[];
  brands: Array<{ id: string; name: string; branding: typeof defaultBranding }>;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: CreateInput) => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id || "");
  const [brainstormId, setBrainstormId] = useState(() => {
    const pending = window.localStorage.getItem("norium:commercial-brainstorm-id") || "";
    window.localStorage.removeItem("norium:commercial-brainstorm-id");
    return brainstorms.some((item) => item.id === pending) ? pending : "";
  });
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
    const templateHtml = selectedTemplate?.contentHtml || "";
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
      subtitle={draft ? "Nada foi salvo ainda. Confirme a prévia detalhada pela Nora." : "O Brainstorm é opcional e só será vinculado se você o selecionar."}
      onClose={onClose}
      wide
    >
      {!clients.length ? (
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
            <FormField label="Brainstorm de origem (opcional)"><select value={brainstormId} onChange={(event) => selectBrainstorm(event.target.value)} className="commercial-field"><option value="">Não vincular</option>{brainstorms.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField>
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
          <FormField label="Brainstorm de origem"><select value={brainstormId} onChange={(event) => setBrainstormId(event.target.value)} className="commercial-field"><option value="">Sem vinculo</option>{brainstorms.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField>
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

  return (
    <Dialog title="Registrar assinatura" subtitle="O aceite gera uma entrada na trilha de auditoria." onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Assinante"><select value={signerId} onChange={(event) => { const next = pending.find((item) => item.id === event.target.value); setSignerId(event.target.value); setName(next?.name || ""); setEmail(next?.email || ""); }} className="commercial-field">{pending.map((item) => <option key={item.id} value={item.id}>{item.order}. {item.name} · {item.email}</option>)}</select></FormField>
        <FormField label="Nome confirmado"><input value={name} onChange={(event) => setName(event.target.value)} className="commercial-field" /></FormField>
        <FormField label="E-mail confirmado"><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" className="commercial-field" /></FormField>
        <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-semibold leading-5"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1" /> Confirmo a identidade informada e concordo em registrar esta assinatura eletronicamente.</label>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!signerId || !name.trim() || !email.trim() || !consent} onClick={() => onSubmit(signerId, name.trim(), email.trim(), "")}>Assinar</Button></div>
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

function TemplateDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (name: string, description: string, shared: boolean) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState(false);
  return <Dialog title="Salvar novo modelo" subtitle="Crie uma estrutura reutilizavel para futuras propostas." onClose={onClose}><div className="space-y-4"><FormField label="Nome"><input value={name} onChange={(event) => setName(event.target.value)} className="commercial-field" /></FormField><FormField label="Descricao"><textarea value={description} onChange={(event) => setDescription(event.target.value)} className="commercial-field min-h-20 resize-y" /></FormField><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /> Compartilhar com a empresa</label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!name.trim()} onClick={() => onSubmit(name.trim(), description.trim(), shared)}>Salvar modelo</Button></div></div></Dialog>;
}

function Dialog({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="fixed inset-0 z-[120] grid place-items-center bg-black/65 p-4" onClick={onClose}><section className={`w-full ${wide ? "max-w-6xl" : "max-w-xl"} rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl`} onClick={(event) => event.stopPropagation()}><header className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-5"><div><h2 className="text-lg font-black">{title}</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{subtitle}</p></div><Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar"><X size={17} /></Button></header><div className="max-h-[82dvh] overflow-y-auto p-5">{children}</div></section></div>;
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase text-[var(--text-secondary)]">{label}</span>{children}</label>;
}

function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: typeof FileSignature }) {
  return <article className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"><span><small className="font-black uppercase text-[var(--text-secondary)]">{label}</small><strong className="mt-2 block text-2xl">{value}</strong></span><span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-500/10 text-blue-400"><Icon size={18} /></span></article>;
}

function ViewTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex h-10 items-center gap-2 whitespace-nowrap border-b-2 px-4 text-xs font-bold ${active ? "border-blue-500 text-blue-400" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text)]"}`}>{label}<span className="rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-xs">{count}</span></button>;
}

function StatusChip({ status }: { status: string }) {
  return <span className="inline-flex rounded-full border border-blue-400/20 bg-blue-500/10 px-2.5 py-1 text-xs font-bold uppercase text-blue-300">{statusLabels[status] || status}</span>;
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
  items: Array<{ id: string; title: string; description: string }>;
  actionLabel: string;
  onAction: () => void;
  onItemClick?: (id: string) => void;
}) {
  return <div className="min-h-[480px] p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-black">{title}</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{description}</p></div><Button onClick={onAction} icon={<Plus size={14} />}>{actionLabel}</Button></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"><span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-500/10 text-blue-400"><Icon size={18} /></span><strong className="mt-4 block text-sm">{item.title}</strong><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{item.description}</p>{onItemClick && <Button size="sm" variant="secondary" className="mt-4" onClick={() => onItemClick(item.id)}>Visualizar em A4</Button>}</article>)}</div>{!items.length && <EmptyState title="Biblioteca vazia" description={`Use "${actionLabel}" para criar o primeiro item.`} icon={Icon} className="mt-5 min-h-72" />}</div>;
}

function TemplatePreviewDialog({ template, onClose }: { template: CommercialTemplate; onClose: () => void }) {
  return (
    <Dialog
      title={template.name}
      subtitle="Prévia do modelo com capa automática e conteúdo dividido em folhas A4."
      onClose={onClose}
      wide
    >
      <TemplateA4Preview template={template} />
    </Dialog>
  );
}

function TemplateA4Preview({ template, compact = false }: { template: CommercialTemplate; compact?: boolean }) {
  const content = sanitizeTemplateHtml(
    template.contentHtml.replace(
      "{{NORA_CONTENT}}",
      "<h2>Conteúdo detalhado pela Nora</h2><p>O briefing aprovado será desenvolvido nesta seção, mantendo escopo, entregáveis, responsabilidades, prazos e condições comerciais.</p>",
    ),
  );
  const kind = template.documentType === "contract" ? "Contrato comercial" : "Proposta comercial";
  const previewBranding = {
    ...defaultBranding,
    headerHtml: `<strong>${kind}</strong> · ${template.name}`,
    footerHtml: "Documento gerado no Norium · conteúdo adaptado ao briefing aprovado",
  };
  return (
    <div className={compact ? "max-h-[56dvh] space-y-5 overflow-auto pr-1" : "space-y-7"}>
      <section className="mx-auto w-full max-w-[794px]">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Página 1 · Capa A4</p>
        <article className="commercial-template-a4 flex aspect-[210/297] flex-col overflow-hidden bg-white p-8 text-slate-900 shadow-xl">
          <div className="h-2 w-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400" />
          <p className="mt-auto text-xs font-bold uppercase tracking-[0.18em] text-blue-600">{kind}</p>
          <h3 className="mt-3 text-2xl font-black leading-tight">{template.name}</h3>
          <div className="mt-7 border-l-4 border-cyan-500 py-2 pl-4"><strong className="block text-sm">Cliente / Empresa</strong><span className="mt-1 block text-xs text-slate-500">Dados preenchidos ao gerar o documento</span></div>
          <div className="mt-auto grid grid-cols-2 gap-4 border-t border-slate-200 pt-5 text-xs"><span>Emissão automática</span><span className="text-right">Identidade da empresa</span></div>
        </article>
      </section>
      <A4ContentPages
        title={template.name}
        contentHtml={content}
        branding={previewBranding}
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
  return <div className={`fixed bottom-5 left-1/2 z-[130] flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-3 text-sm font-bold shadow-2xl ${kind === "error" ? "border-rose-500/40 bg-rose-950 text-rose-100" : "border-emerald-500/40 bg-emerald-950 text-emerald-100"}`}><span>{message}</span><button type="button" onClick={onClose} aria-label="Fechar"><X size={15} /></button></div>;
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
