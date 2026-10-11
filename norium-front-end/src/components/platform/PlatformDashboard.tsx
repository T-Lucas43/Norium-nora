import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Check,
  Download,
  FileScan,
  FileUp,
  Gauge,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Trash2,
  UserRoundCog,
} from "lucide-react";

import { apiRequest } from "../../core/api/client";
import type { AuthSession, NoriumUser } from "../../types/auth";
import { normalizePermissions, ownerPermissions, defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { showAlert, showConfirm } from "../shared/AppDialogProvider";
import { downloadWithAuth, openWithAuth } from "../../utils/download";
import "../../styles/screens/inteligencia-equipe-conta.css";

type PlatformArea = "overview" | "companies" | "knowledge" | "security";
type JsonItem = Record<string, unknown> & { id: string; name?: string; title?: string };

type PlatformSummary = {
  workspaces: number;
  knowledgeDocuments: number;
};

type Workspace = JsonItem & {
  name: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
};

type PlatformDashboardProps = {
  session: AuthSession;
  onNavigate?: (tab: string) => void;
};

type AuditEntry = JsonItem & {
  timestamp?: string;
  action?: string;
  source?: string;
  status?: string;
  description?: string;
  actor?: { name?: string; email?: string };
};

const areas: Array<{ id: PlatformArea; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "Visão executiva", icon: Gauge },
  { id: "companies", label: "Estrutura", icon: Building2 },
  { id: "knowledge", label: "Conhecimento", icon: BookOpen },
  { id: "security", label: "Riscos e controles", icon: ShieldCheck },
];

const initialSummary: PlatformSummary = {
  workspaces: 0,
  knowledgeDocuments: 0,
};

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Nao foi possivel ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export default function PlatformDashboard({ onNavigate }: PlatformDashboardProps) {
  const [area, setArea] = useState<PlatformArea>("overview");
  const [summary, setSummary] = useState(initialSummary);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [users, setUsers] = useState<NoriumUser[]>([]);
  const [auditPreview, setAuditPreview] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadedAreas = useRef(new Set<PlatformArea>());
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(!loadedAreas.current.has(area));
    setError("");
    try {
      if (area === "overview") {
        const payload = await apiRequest<PlatformSummary>("/api/plataforma/resumo");
        if (version !== requestVersion.current) return;
        setSummary(payload);
      } else if (area === "companies") {
        const payload = await apiRequest<{ items: Workspace[] }>("/api/plataforma/empresas");
        if (version !== requestVersion.current) return;
        setData((current) => ({ ...current, companies: payload.items }));
      } else if (area === "knowledge") {
        const knowledge = await apiRequest<{ items: JsonItem[] }>("/api/plataforma/conhecimento");
        if (version !== requestVersion.current) return;
        setData((current) => ({ ...current, knowledge: knowledge.items }));
      } else {
        const [members, audit] = await Promise.all([
          apiRequest<{ users: NoriumUser[] }>("/api/auth/users"),
          apiRequest<{ items: AuditEntry[] }>("/api/operacao/auditoria?limit=5"),
        ]);
        if (version !== requestVersion.current) return;
        setUsers(members.users);
        setAuditPreview(audit.items);
      }
      loadedAreas.current.add(area);
    } catch (requestError) {
      if (version === requestVersion.current) setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar esta área.");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [area]);

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; };
  }, [load]);

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>, success: string) => {
      setBusy(key);
      setError("");
      setNotice("");
      try {
        await action();
        setNotice(success);
        await load();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "A operacao nao foi concluida.");
      } finally {
        setBusy("");
      }
    },
    [load],
  );

  return (
    <div className="nx-page nxi-screen norium-governance">
        <header className="nx-ph">
          <div>
            <h1>Governança</h1>
            <p>Controles, riscos e trilha de auditoria · direção, informação confiável e prestação de contas com os recursos reais do Norium</p>
          </div>
          <div className="nx-ph-actions">
            <button className="nx-btn" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              Atualizar
            </button>
          </div>
        </header>

        <nav className="nx-tabs" aria-label="Áreas da plataforma">
          {areas.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={area === item.id ? "page" : undefined}
                onClick={() => { setNotice(""); setArea(item.id); }}
                className={`nx-tab ${area === item.id ? "is-active" : ""}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
        {loading ? (
          <div className="nxi-empty" style={{ minHeight: 360 }} role="status" aria-label="Carregando">
            <LoaderCircle className="animate-spin" size={26} style={{ color: "var(--nx-primary)" }} />
          </div>
        ) : !loadedAreas.current.has(area) ? null : (
          <>
            {area === "overview" && (
              <OverviewArea summary={summary} onSelect={setArea} />
            )}
            {area === "companies" && (
              <CompaniesArea
                companies={(data.companies as Workspace[]) || []}
                mutate={mutate}
                busy={busy}
              />
            )}
            {area === "knowledge" && (
              <KnowledgeArea
                documents={(data.knowledge as JsonItem[]) || []}
                mutate={mutate}
                busy={busy}
              />
            )}
            {area === "security" && (
              <SecurityArea
                users={users}
                auditPreview={auditPreview}
                onNavigate={onNavigate}
              />
            )}
          </>
        )}
    </div>
  );
}

function OverviewArea({ summary, onSelect }: { summary: PlatformSummary; onSelect: (area: PlatformArea) => void }) {
  const principles = ["Integridade", "Transparência", "Equidade", "Responsabilização", "Sustentabilidade"];
  const cycle = [
    { area: "companies" as PlatformArea, icon: Building2, title: "Estruturar", text: "Ambientes e responsabilidades da operação." },
    { area: "knowledge" as PlatformArea, icon: BookOpen, title: "Informar", text: "Fontes verificáveis para decisões e para a Nora." },
    { area: "security" as PlatformArea, icon: ShieldCheck, title: "Controlar", text: "Permissões, riscos e controles proporcionais." },
    { area: "security" as PlatformArea, icon: ScanSearch, title: "Evidenciar", text: "Auditoria e rastreabilidade das ações sensíveis." },
  ];
  return <div className="nxi-stack">
    <div className="nxi-cards">
      <Panel title="Ambientes de trabalho" subtitle="Estruturas operacionais separadas e identificáveis." icon={Building2}>
        <p className="nx-kpi-v" style={{ margin: 0 }}>{summary.workspaces ?? 0}</p><p className="nx-kpi-s" style={{ margin: "2px 0 14px" }}>ambientes cadastrados</p>
        <button className="nx-btn is-sm" onClick={() => onSelect("companies")}>Gerenciar estrutura</button>
      </Panel>
      <Panel title="Fontes de conhecimento" subtitle="Textos e PDFs pesquisáveis com consulta por fonte." icon={BookOpen}>
        <p className="nx-kpi-v" style={{ margin: 0 }}>{summary.knowledgeDocuments ?? 0}</p><p className="nx-kpi-s" style={{ margin: "2px 0 14px" }}>fontes disponíveis</p>
        <button className="nx-btn is-sm" onClick={() => onSelect("knowledge")}>Consultar conhecimento</button>
      </Panel>
      <Panel title="Riscos e prestação de contas" subtitle="Acesse a matriz de permissões e as evidências da operação." icon={ShieldCheck}>
        <p className="nx-muted nx-small" style={{ margin: "0 0 14px", lineHeight: 1.5 }}>A situação é apresentada com dados registrados; o painel não inventa indicadores ausentes.</p>
        <button className="nx-btn is-sm" onClick={() => onSelect("security")}>Revisar controles</button>
      </Panel>
    </div>

    <section className="nx-card" aria-labelledby="governance-principles-title">
      <div className="nx-card-h"><h2 id="governance-principles-title">Governar é direcionar, monitorar e prestar contas</h2><span className="nx-faint nx-small">Princípios de referência</span></div>
      <div className="nx-card-b nxi-chips">{principles.map((principle, index) => <span key={principle} className="nx-badge is-blue" style={{ height: 28, padding: "0 12px" }}><b style={{ fontWeight: 600 }}>{String(index + 1).padStart(2, "0")}</b> {principle}</span>)}</div>
    </section>

    <section className="nxi-cards is-4" aria-label="Ciclo de governança no Norium">
      {cycle.map((step, index) => { const Icon = step.icon; return <button key={step.title} type="button" className="nxi-topic-card" onClick={() => onSelect(step.area)}><span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span className="nxi-tile is-sm is-blue"><Icon size={18} /></span><span className="nx-faint nx-small">{String(index + 1).padStart(2, "0")}</span></span><strong>{step.title}</strong><small>{step.text}</small></button>; })}
    </section>

    <section className="nx-card">
      <div className="nx-card-h"><h2>Referências usadas nesta estrutura</h2><span className="nx-faint nx-small">Metodologia</span></div>
      <div className="nx-card-b" style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px" }}><a className="nxi-link" href="https://complianceenforcement.com.br/glossario/o-que-e-sistema-de-governanca/" target="_blank" rel="noreferrer">Sistema de governança · Compliance Enforcement</a><a className="nxi-link" href="https://www3.ibgc.org.br/conhecimento" target="_blank" rel="noreferrer">Princípios de governança · IBGC</a><a className="nxi-link" href="https://www.gov.br/cgu/pt-br/acesso-a-informacao/governanca/gestao-de-riscos" target="_blank" rel="noreferrer">Gestão de riscos · CGU</a></div>
    </section>
  </div>;
}

function CompaniesArea({
  companies,
  mutate,
  busy,
}: {
  companies: Workspace[];
  mutate: MutationRunner;
  busy: string;
}) {
  const [name, setName] = useState("");
  const activeId = localStorage.getItem("norium-workspace-id") || "primary";

  function switchCompany(id: string) {
    localStorage.setItem("norium-workspace-id", id);
    window.location.reload();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="xl:col-span-2 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs font-semibold text-[var(--text-secondary)]">
        <BriefcaseBusiness size={15} className="mt-0.5 shrink-0 text-[var(--primary)]" />
        <span>
          Aqui voce gerencia <strong className="text-[var(--text)]">ambientes de trabalho</strong> (instancias isoladas do Norium, com dados e integracoes proprios) —
          diferente de <strong className="text-[var(--text)]">Clientes</strong>, que e o seu CRM de relacionamento comercial.
        </span>
      </div>
      <Panel title="Ambientes de trabalho" subtitle="Cada ambiente possui dados separados. Os acessos são gerenciados pela equipe." icon={Building2}>
        <div className="grid gap-3 md:grid-cols-2">
          {companies.map((company) => (
            <article key={company.id} className="nx-card" style={{ padding: 16, borderColor: activeId === company.id ? "var(--nx-primary)" : undefined }}>
              <div className="flex items-center gap-3">
                <span
                  className="grid h-10 w-10 place-items-center rounded-lg font-black"
                  style={{ backgroundColor: `${company.primaryColor || "#1677ff"}22`, color: company.primaryColor || "#1677ff" }}
                >
                  {company.logoUrl ? <img src={company.logoUrl} className="h-8 w-8 object-contain" alt="" /> : company.name[0]}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate">{company.name}</strong>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {company.id === "primary" ? "Ambiente principal" : "Ambiente isolado"}
                  </span>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" className="nx-btn" disabled={activeId === company.id} onClick={() => switchCompany(company.id)}>
                  {activeId === company.id ? "Em uso" : "Acessar"}
                </button>
                {company.id !== "primary" && (
                  <button
                    type="button"
                    className="nxi-icon-btn is-danger"
                    title="Excluir ambiente"
                    aria-label={`Excluir ${company.name}`}
                    onClick={async () => {
                      const confirmed = await showConfirm({
                        title: "Excluir ambiente?",
                        description: `${company.name} e seus dados isolados deixarão de ser acessíveis.`,
                        confirmLabel: "Excluir ambiente",
                        tone: "danger",
                      });
                      if (!confirmed) return;
                      void mutate(
                        `delete-${company.id}`,
                        () => apiRequest(`/api/plataforma/empresas/${company.id}`, { method: "DELETE" }),
                        "Ambiente excluido.",
                      );
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Novo ambiente" subtitle="Crie um workspace com identidade propria." icon={Plus}>
        <label className="nxi-label">
          Nome do ambiente
          <input className="nxi-field" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          type="button"
          className="nx-btn is-primary mt-4 w-full justify-center"
          disabled={name.trim().length < 2 || busy === "company"}
          onClick={() =>
            void mutate(
              "company",
              async () => {
                await apiRequest("/api/plataforma/empresas", {
                  method: "POST",
                  body: JSON.stringify({
                    name,
                    legalName: "",
                    document: "",
                    domain: "",
                    logoUrl: "",
                    primaryColor: "#1677ff",
                    accentColor: "#22d3ee",
                    emailSignature: "",
                    reportFooter: "",
                  }),
                });
                setName("");
              },
              "Ambiente criado com isolamento proprio.",
            )
          }
        >
          <Plus size={16} /> Criar ambiente
        </button>
      </Panel>
    </div>
  );
}

function KnowledgeArea({
  documents,
  mutate,
  busy,
}: {
  documents: JsonItem[];
  mutate: MutationRunner;
  busy: string;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Base de conhecimento" subtitle="A Nora responde somente com fontes autorizadas deste workspace." icon={BookOpen}>
        <div className="grid gap-2">
          <input className="nxi-field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Titulo do documento" />
          <textarea className="nxi-field min-h-28 resize-y" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Cole politica, manual, contrato ou procedimento." />
          <button
            type="button"
            className="nx-btn is-primary"
            disabled={title.trim().length < 2 || content.trim().length < 2 || busy === "knowledge"}
            onClick={() =>
              void mutate(
                "knowledge",
                async () => {
                  await apiRequest("/api/plataforma/conhecimento", {
                    method: "POST",
                    body: JSON.stringify({ title, content, tags: [], visibility: "workspace", sourceUrl: "" }),
                  });
                  setTitle("");
                  setContent("");
                },
                "Documento adicionado a base.",
              )
            }
          >
            <Plus size={16} /> Adicionar fonte
          </button>
          <div className="my-1 flex items-center gap-3 text-xs font-bold uppercase text-[var(--text-secondary)]">
            <span className="h-px flex-1 bg-[var(--border)]" /> ou envie um PDF <span className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <label className="nxi-file">
            <FileUp size={18} />
            <span className="min-w-0">
              <strong className="block truncate">{pdfFile?.name || "Selecionar PDF pesquisavel"}</strong>
              <small className="block text-[var(--text-secondary)]">Ate 12 MB e 200 paginas</small>
            </span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => setPdfFile(event.target.files?.[0] || null)}
            />
          </label>
          <button
            type="button"
            className="nx-btn"
            disabled={!pdfFile || busy === "knowledge-pdf"}
            onClick={async () => {
              if (!pdfFile) return;
              if (pdfFile.size > 12 * 1024 * 1024) {
                await showAlert({
                  title: "Arquivo acima do limite",
                  description: "O PDF deve ter no máximo 12 MB.",
                  tone: "warning",
                });
                return;
              }
              void mutate(
                "knowledge-pdf",
                async () => {
                  await apiRequest("/api/plataforma/conhecimento/pdf", {
                    method: "POST",
                    body: JSON.stringify({
                      fileName: pdfFile.name,
                      dataUrl: await readFileAsDataUrl(pdfFile),
                      title: title.trim(),
                      tags: [],
                      visibility: "workspace",
                    }),
                  });
                  setPdfFile(null);
                  setTitle("");
                },
                "PDF indexado e disponivel para a Nora.",
              );
            }}
          >
            <FileScan size={16} /> Extrair texto e indexar PDF
          </button>
        </div>
        {documents.length === 0 ? (
          <EmptyState text="A base ainda nao possui documentos." />
        ) : (
          <div className="mt-4 max-h-60 space-y-2 overflow-y-auto pr-1">
            {documents.map((document) => (
              <article key={document.id} className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-black/10 px-3 py-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-300">
                  {document.sourceType === "pdf" ? <FileScan size={17} /> : <BookOpen size={17} />}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">{String(document.title || document.id)}</strong>
                  <small className="text-[var(--text-secondary)]">
                    {document.sourceType === "pdf"
                      ? `${Number(document.pageCount || 0)} pagina(s) indexadas`
                      : "Fonte em texto"}
                  </small>
                </span>
                {document.sourceType === "pdf" && Boolean(document.sourceUrl) && (
                  <>
                    <button
                      type="button"
                      className="nxi-icon-btn"
                      title="Abrir PDF"
                      aria-label={`Abrir ${String(document.title || "PDF")}`}
                      onClick={() => void openWithAuth(String(document.sourceUrl))}
                    >
                      <FileUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="nxi-icon-btn"
                      title="Baixar PDF"
                      aria-label={`Baixar ${String(document.title || "PDF")}`}
                      onClick={() => void downloadWithAuth(String(document.sourceUrl), String(document.fileName || "documento.pdf"))}
                    >
                      <Download size={15} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="nxi-icon-btn is-danger"
                  title="Excluir fonte"
                  aria-label={`Excluir ${String(document.title || "documento")}`}
                  disabled={busy === `knowledge-delete-${document.id}`}
                  onClick={async () => {
                    const documentTitle = String(document.title || "este documento");
                    const confirmed = await showConfirm({
                      title: "Excluir fonte de conhecimento?",
                      description: `"${documentTitle}" deixará de estar disponível para consultas da Nora.`,
                      confirmLabel: "Excluir fonte",
                      tone: "danger",
                    });
                    if (!confirmed) return;
                    void mutate(
                      `knowledge-delete-${document.id}`,
                      () => apiRequest(`/api/plataforma/conhecimento/${document.id}`, { method: "DELETE" }),
                      "Fonte removida da base de conhecimento.",
                    );
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Consulta com citacoes" subtitle="Confira a resposta e a fonte utilizada." icon={ScanSearch}>
        <div className="flex gap-2">
          <input className="nxi-field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Qual e a politica de reembolso?" />
          <button
            type="button"
            className="nx-btn is-primary shrink-0"
            disabled={query.trim().length < 2 || busy === "query"}
            onClick={() => void mutate("query", async () => {
              const result = await apiRequest<{ answer: string; citations?: { title: string; excerpt: string }[] }>("/api/plataforma/conhecimento/consultar", {
                method: "POST",
                body: JSON.stringify({ query, limit: 5 }),
              });
              setAnswer([result.answer, ...(result.citations || []).map((source) => `Fonte: ${source.title} — ${source.excerpt}`)].join("\n\n"));
            }, "Consulta concluída.")}
          >
            Consultar
          </button>
        </div>
        {answer && <p className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-black/10 p-3 text-sm leading-6">{answer}</p>}
      </Panel>

    </div>
  );
}

function SecurityArea({
  users,
  auditPreview,
  onNavigate,
}: {
  users: NoriumUser[];
  auditPreview: AuditEntry[];
  onNavigate?: (tab: string) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Mapa de riscos e controles" subtitle="Relação entre riscos relevantes e mecanismos que já existem no sistema." icon={ShieldCheck} className="xl:col-span-2">
        <div className="nxi-table-wrap" style={{ margin: "0 -18px -16px" }}><table className="nx-table" aria-label="Riscos e controles do sistema">
          <thead><tr><th>Risco</th><th>Controle existente</th><th>Evidência ou destino</th></tr></thead>
          <tbody>
            <tr><td style={{ fontWeight: 500 }}>Acesso além da responsabilidade</td><td className="nx-muted">Permissões por usuário e função</td><td><button className="nxi-link" type="button" onClick={() => document.querySelector<HTMLElement>("[data-governance-permissions]")?.scrollIntoView({ behavior: "smooth" })}>Matriz abaixo</button></td></tr>
            <tr><td style={{ fontWeight: 500 }}>Ação sensível sem rastreabilidade</td><td className="nx-muted">Trilha de auditoria operacional</td><td><button className="nxi-link" type="button" disabled={!onNavigate} onClick={() => onNavigate?.("Controle")}>Abrir Controle</button></td></tr>
            <tr><td style={{ fontWeight: 500 }}>Resposta de IA sem base verificável</td><td className="nx-muted">Conhecimento com consulta e citações</td><td><span className="nx-badge is-green">Aba Conhecimento</span></td></tr>
          </tbody>
        </table></div>
      </Panel>
      <Panel title="Trilha de auditoria" subtitle="Registro de acoes sensiveis do sistema, consolidado no Controle operacional." icon={ScanSearch}>
        {auditPreview.length === 0 ? (
          <EmptyState text="Nenhum evento de auditoria registrado ainda." />
        ) : (
          <div className="mt-1">
            {auditPreview.map((entry) => (
              <div key={entry.id} className="nx-row">
                <div className="nx-grow">
                  <span className="nx-row-t">{entry.actor?.name || "Sistema"}</span> <span className="nx-muted nx-small">{entry.description || entry.action || "Ação registrada"}</span>
                  <div className="nx-row-sub">{entry.source || "geral"}{entry.status ? ` · ${entry.status}` : ""}</div>
                </div>
                <span className="nx-faint nx-small" style={{ whiteSpace: "nowrap" }}>{auditTime(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="nx-btn mt-3 w-full justify-center"
          disabled={!onNavigate}
          onClick={() => onNavigate?.("Controle")}
        >
          <ScanSearch size={16} /> Ver auditoria completa no Controle
        </button>
      </Panel>

      <Panel title="Matriz de permissões" subtitle="Quem tem acesso a cada tela e integração, de relance." icon={UserRoundCog} className="xl:col-span-2">
        <span data-governance-permissions className="sr-only">Início da matriz de permissões</span>
        {users.length === 0 ? (
          <EmptyState text="Nenhum usuario encontrado." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr>
                  <th className="p-2 text-left font-black text-[var(--text-secondary)]">Permissao</th>
                  {users.map((member) => (
                    <th key={member.id} className="p-2 text-center font-black text-[var(--text-secondary)]" title={member.email}>
                      {member.nome.split(" ")[0]}
                      {member.systemAdmin && <ShieldCheck size={11} className="ml-1 inline text-amber-400" />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {permissionGroups.map((group) => (
                  <Fragment key={group.title}>
                    <tr>
                      <td colSpan={users.length + 1} className="pb-1 pt-3 text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                        {group.title}
                      </td>
                    </tr>
                    {group.keys.map((key) => (
                      <tr key={key} className="border-t border-[var(--border)]">
                        <td className="p-2 font-semibold">{permissionLabels[key]}</td>
                        {users.map((member) => {
                          const perms = normalizePermissions(member.permissions, member.role === "owner" ? ownerPermissions : defaultMemberPermissions);
                          const has = member.systemAdmin || perms[key];
                          return (
                            <td key={member.id} className="p-2 text-center">
                              {has ? (
                                <Check size={14} className="inline text-emerald-400" aria-label="Permitido" />
                              ) : (
                                <Minus size={14} className="inline text-[var(--text-secondary)] opacity-40" aria-label="Sem acesso" />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

    </div>
  );
}

type MutationRunner = (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;

function Panel({
  title,
  subtitle,
  icon: Icon,
  children,
  className = "",
}: {
  title: string;
  subtitle: string;
  icon: typeof Gauge;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`nx-card min-w-0 ${className}`} style={{ padding: "16px 18px" }}>
      <div className="mb-4 flex items-start gap-3">
        <span className="nxi-tile is-sm is-blue">
          <Icon size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="nxi-card-title" style={{ fontSize: 15 }}>{title}</h2>
          <p className="nxi-card-sub">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function auditTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("pt-BR");
}

function EmptyState({ text }: { text: string }) {
  return <p className="nxi-empty is-dashed mt-4" style={{ minHeight: 80 }}>{text}</p>;
}

function StatusBanner({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`nxi-alert ${tone === "error" ? "is-error" : "is-success"}`}
    >
      {children}
    </div>
  );
}
