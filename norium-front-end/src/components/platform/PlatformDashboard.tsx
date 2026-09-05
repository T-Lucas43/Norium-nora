import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileScan,
  FileSignature,
  FileUp,
  FormInput,
  Gauge,
  KeyRound,
  LoaderCircle,
  Mic2,
  Minus,
  Plus,
  RefreshCw,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Trash2,
  UserRoundCog,
  UsersRound,
  WalletCards,
} from "lucide-react";

import { apiRequest } from "../../core/api/client";
import type { AuthSession, NoriumUser } from "../../types/auth";
import { normalizePermissions, ownerPermissions, defaultMemberPermissions, permissionGroups, permissionLabels } from "../../types/auth";
import { showAlert, showConfirm } from "../shared/AppDialogProvider";
import { downloadWithAuth, openWithAuth } from "../../utils/download";

type PlatformArea = "overview" | "companies" | "service" | "knowledge" | "security";
type JsonItem = Record<string, unknown> & { id: string; name?: string; title?: string };

type PlatformSummary = {
  workspaces: number;
  activeAbsences: number;
  portalClients: number;
  forms: number;
  knowledgeDocuments: number;
  pendingSignatures: number;
  approvalRules: number;
  slaCases: number;
  captures: number;
  meetings: number;
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
  { id: "overview", label: "Visao geral", icon: Gauge },
  { id: "companies", label: "Ambientes", icon: Building2 },
  { id: "service", label: "Atendimento", icon: TimerReset },
  { id: "knowledge", label: "IA e documentos", icon: BookOpen },
  { id: "security", label: "Seguranca", icon: ShieldCheck },
];

const initialSummary: PlatformSummary = {
  workspaces: 0,
  activeAbsences: 0,
  portalClients: 0,
  forms: 0,
  knowledgeDocuments: 0,
  pendingSignatures: 0,
  approvalRules: 0,
  slaCases: 0,
  captures: 0,
  meetings: 0,
};

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Nao foi possivel ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export default function PlatformDashboard({ session, onNavigate }: PlatformDashboardProps) {
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
      } else if (area === "service") {
        const [absences, forms, sla, members] = await Promise.all([
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/ausencias"),
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/formularios"),
          apiRequest<{ policies: JsonItem[] }>("/api/plataforma/sla"),
          apiRequest<{ users: NoriumUser[] }>("/api/auth/users"),
        ]);
        if (version !== requestVersion.current) return;
        setUsers(members.users);
        setData((current) => ({ ...current, absences: absences.items, forms: forms.items, policies: sla.policies }));
      } else if (area === "knowledge") {
        const [knowledge, signatures] = await Promise.all([
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/conhecimento"),
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/assinaturas"),
        ]);
        if (version !== requestVersion.current) return;
        setData((current) => ({ ...current, knowledge: knowledge.items, signatures: signatures.items }));
      } else {
        const [rules, vault, members, audit] = await Promise.all([
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/regras-aprovacao"),
          apiRequest<{ items: JsonItem[] }>("/api/plataforma/cofre"),
          apiRequest<{ users: NoriumUser[] }>("/api/auth/users"),
          apiRequest<{ items: AuditEntry[] }>("/api/operacao/auditoria?limit=5"),
        ]);
        if (version !== requestVersion.current) return;
        setUsers(members.users);
        setAuditPreview(audit.items);
        setData((current) => ({ ...current, rules: rules.items, vault: vault.items }));
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
    <div className="min-h-full bg-[var(--background)] p-4 text-[var(--text)] sm:p-6">
      <div className="mx-auto w-full max-w-[1500px] space-y-4">
        <header className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-400">
              <ShieldCheck size={22} />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-blue-400">Operacao e governanca</p>
              <h1 className="text-2xl font-black">Plataforma Norium</h1>
              <p className="text-sm text-[var(--text-secondary)]">
                Ambientes, atendimento, documentos, dados e seguranca em um unico controle.
              </p>
            </div>
          </div>
          <button className="norium-platform-button" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Atualizar
          </button>
        </header>

        <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Areas da plataforma">
          {areas.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setArea(item.id)}
                className={`norium-platform-tab ${area === item.id ? "is-active" : ""}`}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
        {loading ? (
          <div className="grid min-h-[420px] place-items-center">
            <LoaderCircle className="animate-spin text-blue-400" size={28} />
          </div>
        ) : (
          <>
            {area === "overview" && (
              <OverviewArea summary={summary} mutate={mutate} busy={busy} />
            )}
            {area === "companies" && (
              <CompaniesArea
                companies={(data.companies as Workspace[]) || []}
                mutate={mutate}
                busy={busy}
              />
            )}
            {area === "service" && (
              <ServiceArea
                users={users}
                absences={(data.absences as JsonItem[]) || []}
                forms={(data.forms as JsonItem[]) || []}
                policies={(data.policies as JsonItem[]) || []}
                mutate={mutate}
                busy={busy}
              />
            )}
            {area === "knowledge" && (
              <KnowledgeArea
                documents={(data.knowledge as JsonItem[]) || []}
                signatures={(data.signatures as JsonItem[]) || []}
                mutate={mutate}
                busy={busy}
              />
            )}
            {area === "security" && (
              <SecurityArea
                session={session}
                users={users}
                rules={(data.rules as JsonItem[]) || []}
                credentials={(data.vault as JsonItem[]) || []}
                auditPreview={auditPreview}
                mutate={mutate}
                busy={busy}
                onNavigate={onNavigate}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function OverviewArea({
  summary,
  mutate,
  busy,
}: {
  summary: PlatformSummary;
  mutate: MutationRunner;
  busy: string;
}) {
  const [capture, setCapture] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [scan, setScan] = useState<Record<string, unknown> | null>(null);
  const metrics = [
    ["Ambientes", summary.workspaces, Building2],
    ["Portais", summary.portalClients, UsersRound],
    ["Documentos", summary.knowledgeDocuments, BookOpen],
    ["Assinaturas pendentes", summary.pendingSignatures, FileSignature],
    ["Regras ativas", summary.approvalRules, ShieldCheck],
    ["Casos de SLA", summary.slaCases, TimerReset],
  ] as const;

  async function inspect(path: string) {
    const payload = await apiRequest<Record<string, unknown>>(path);
    setScan(payload);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {metrics.map(([label, value, Icon]) => (
          <article key={label} className="norium-platform-card min-h-28">
            <Icon size={18} className="text-blue-400" />
            <strong className="mt-5 block text-2xl">{value}</strong>
            <span className="text-xs text-[var(--text-secondary)]">{label}</span>
          </article>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Panel title="Captura rapida universal" subtitle="Registre uma ideia e confirme o destino sugerido pela Nora." icon={Sparkles}>
          <textarea
            className="norium-platform-input min-h-28 resize-y"
            value={capture}
            onChange={(event) => setCapture(event.target.value)}
            placeholder="Ex.: Paguei R$ 89,90 no Pix pelo material do escritorio."
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="norium-platform-button is-primary"
              disabled={!capture.trim() || busy === "capture"}
              onClick={() =>
                void mutate(
                  "capture",
                  () =>
                    apiRequest("/api/plataforma/captura", {
                      method: "POST",
                      body: JSON.stringify({ content: capture, kind: "text", destination: "auto", confirm: false }),
                    }),
                  "Captura analisada e salva para confirmacao.",
                )
              }
            >
              <ScanSearch size={16} /> Analisar captura
            </button>
          </div>
        </Panel>

        <Panel title="Diagnostico de dados" subtitle="Encontre inconsistencias antes que virem retrabalho." icon={ClipboardCheck}>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="norium-platform-action" onClick={() => void inspect("/api/plataforma/qualidade")}>
              <CheckCircle2 size={17} /> Verificar qualidade
            </button>
            <button type="button" className="norium-platform-action" onClick={() => void inspect("/api/plataforma/conflitos")}>
              <AlertTriangle size={17} /> Detectar conflitos
            </button>
            <button type="button" className="norium-platform-action" onClick={() => void inspect("/api/system/diagnostics")}>
              <Gauge size={17} /> Latencia das integracoes
            </button>
            <button
              type="button"
              className="norium-platform-action"
              onClick={() =>
                void mutate(
                  "handoff",
                  () => apiRequest("/api/plataforma/passagens-turno", { method: "POST", body: JSON.stringify({ note: "" }) }),
                  "Resumo de passagem de turno criado.",
                )
              }
            >
              <UsersRound size={17} /> Gerar passagem de turno
            </button>
          </div>
          {scan && <JsonPreview value={scan} />}
        </Panel>
      </div>

      <Panel title="OCR e conciliacao financeira" subtitle="Cole o texto reconhecido do comprovante ou nota para conferir valores e duplicidades." icon={FileScan}>
        <textarea
          className="norium-platform-input min-h-32 resize-y"
          value={ocrText}
          onChange={(event) => setOcrText(event.target.value)}
          placeholder={"NOTA FISCAL\nMercado Exemplo\nValor total R$ 129,90\nVencimento 30/07/2026"}
        />
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={!ocrText.trim() || busy === "ocr"}
          onClick={() =>
            void mutate(
              "ocr",
              async () => {
                const result = await apiRequest<Record<string, unknown>>("/api/plataforma/ocr", {
                  method: "POST",
                  body: JSON.stringify({ recognizedText: ocrText, createTransaction: false }),
                });
                setScan(result);
              },
              "Documento analisado. Confira a conciliacao abaixo.",
            )
          }
        >
          <FileScan size={16} /> Reconhecer e conciliar
        </button>
      </Panel>
    </div>
  );
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
      <Panel title="Ambientes de trabalho" subtitle="Cada ambiente possui dados, integracoes e permissoes isolados." icon={Building2}>
        <div className="grid gap-3 md:grid-cols-2">
          {companies.map((company) => (
            <article key={company.id} className={`norium-platform-card ${activeId === company.id ? "is-selected" : ""}`}>
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
                <button type="button" className="norium-platform-button" onClick={() => switchCompany(company.id)}>
                  {activeId === company.id ? "Em uso" : "Acessar"}
                </button>
                {company.id !== "primary" && (
                  <button
                    type="button"
                    className="norium-platform-icon-button is-danger"
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
        <label className="norium-platform-label">
          Nome do ambiente
          <input className="norium-platform-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          type="button"
          className="norium-platform-button is-primary mt-4 w-full justify-center"
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

function ServiceArea({
  users,
  absences,
  forms,
  policies,
  mutate,
  busy,
}: {
  users: NoriumUser[];
  absences: JsonItem[];
  forms: JsonItem[];
  policies: JsonItem[];
  mutate: MutationRunner;
  busy: string;
}) {
  const [formName, setFormName] = useState("");
  const [portalEmail, setPortalEmail] = useState("");
  const [slaName, setSlaName] = useState("");
  const [absenceMember, setAbsenceMember] = useState(users[0]?.id || "");
  const [substitute, setSubstitute] = useState(users[1]?.id || users[0]?.id || "");

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Portal externo do cliente" subtitle="Envie uma area segura para documentos, solicitacoes e aprovacoes." icon={UsersRound}>
        <div className="flex gap-2">
          <input
            className="norium-platform-input"
            type="email"
            value={portalEmail}
            onChange={(event) => setPortalEmail(event.target.value)}
            placeholder="cliente@empresa.com"
          />
          <button
            type="button"
            className="norium-platform-button is-primary shrink-0"
            disabled={!portalEmail.includes("@") || busy === "portal"}
            onClick={() =>
              void mutate(
                "portal",
                async () => {
                  const result = await apiRequest<{ publicPath: string }>("/api/plataforma/portal/convites", {
                    method: "POST",
                    body: JSON.stringify({ clientName: portalEmail.split("@")[0], email: portalEmail, expiresInDays: 14 }),
                  });
                  await navigator.clipboard?.writeText(`${window.location.origin}#${result.publicPath}`);
                  setPortalEmail("");
                },
                "Portal criado e link copiado.",
              )
            }
          >
            <Send size={16} /> Convidar
          </button>
        </div>
      </Panel>

      <Panel title="Formularios publicos inteligentes" subtitle="Transforme respostas em clientes, tarefas, eventos ou oportunidades." icon={FormInput}>
        <div className="flex gap-2">
          <input
            className="norium-platform-input"
            value={formName}
            onChange={(event) => setFormName(event.target.value)}
            placeholder="Solicitacao de atendimento"
          />
          <button
            type="button"
            className="norium-platform-button is-primary shrink-0"
            disabled={formName.trim().length < 2 || busy === "form"}
            onClick={() =>
              void mutate(
                "form",
                async () => {
                  await apiRequest("/api/plataforma/formularios", {
                    method: "POST",
                    body: JSON.stringify({
                      title: formName,
                      description: "Formulario criado no Norium.",
                      destination: "client",
                      fields: [
                        { id: "name", label: "Nome", type: "text", required: true },
                        { id: "email", label: "E-mail", type: "email", required: true },
                        { id: "message", label: "Solicitacao", type: "textarea", required: true },
                      ],
                      successMessage: "Recebemos sua solicitacao.",
                      active: true,
                    }),
                  });
                  setFormName("");
                },
                "Formulario publico criado.",
              )
            }
          >
            <Plus size={16} /> Criar
          </button>
        </div>
        <CompactList items={forms} empty="Nenhum formulario criado." />
      </Panel>

      <Panel title="SLA de atendimento" subtitle="Defina prazo de resposta e escalonamento por canal." icon={TimerReset}>
        <div className="flex gap-2">
          <input className="norium-platform-input" value={slaName} onChange={(event) => setSlaName(event.target.value)} placeholder="Urgencias em 30 min" />
          <button
            type="button"
            className="norium-platform-button is-primary shrink-0"
            disabled={slaName.trim().length < 2 || busy === "sla"}
            onClick={() =>
              void mutate(
                "sla",
                async () => {
                  await apiRequest("/api/plataforma/sla/politicas", {
                    method: "POST",
                    body: JSON.stringify({
                      name: slaName,
                      channel: "all",
                      priority: "urgent",
                      responseMinutes: 30,
                      escalateTo: users.slice(0, 1).map((item) => item.id),
                      active: true,
                    }),
                  });
                  setSlaName("");
                },
                "Politica de SLA criada.",
              )
            }
          >
            <Plus size={16} /> Adicionar
          </button>
        </div>
        <CompactList items={policies} empty="Nenhuma politica de SLA." />
      </Panel>

      <Panel title="Ausencia e substituicao" subtitle="Redirecione tarefas, mensagens e aprovacoes durante afastamentos." icon={UserRoundCog}>
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="norium-platform-input" value={absenceMember} onChange={(event) => setAbsenceMember(event.target.value)}>
            <option value="">Membro ausente</option>
            {users.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select>
          <select className="norium-platform-input" value={substitute} onChange={(event) => setSubstitute(event.target.value)}>
            <option value="">Substituto</option>
            {users.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select>
        </div>
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={!absenceMember || !substitute || absenceMember === substitute || busy === "absence"}
          onClick={() =>
            void mutate(
              "absence",
              () =>
                apiRequest("/api/plataforma/ausencias", {
                  method: "POST",
                  body: JSON.stringify({
                    memberId: absenceMember,
                    substituteId: substitute,
                    startsAt: new Date().toISOString(),
                    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                    reason: "Ausencia programada",
                    redirectTasks: true,
                    redirectMessages: true,
                    redirectApprovals: true,
                  }),
                }),
              "Substituicao programada por sete dias.",
            )
          }
        >
          <UserRoundCog size={16} /> Programar substituicao
        </button>
        <CompactList items={absences} empty="Nenhuma ausencia ativa." />
      </Panel>
    </div>
  );
}

function KnowledgeArea({
  documents,
  signatures,
  mutate,
  busy,
}: {
  documents: JsonItem[];
  signatures: JsonItem[];
  mutate: MutationRunner;
  busy: string;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [transcript, setTranscript] = useState("");
  const [signatureTitle, setSignatureTitle] = useState("");
  const [signatureProvider, setSignatureProvider] = useState<"manual" | "clicksign" | "docusign" | "zapsign">("manual");
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Base de conhecimento" subtitle="A Nora responde somente com fontes autorizadas deste workspace." icon={BookOpen}>
        <div className="grid gap-2">
          <input className="norium-platform-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Titulo do documento" />
          <textarea className="norium-platform-input min-h-28 resize-y" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Cole politica, manual, contrato ou procedimento." />
          <button
            type="button"
            className="norium-platform-button is-primary"
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
          <label className="norium-platform-file">
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
            className="norium-platform-button"
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
                      className="norium-platform-icon-button"
                      title="Abrir PDF"
                      aria-label={`Abrir ${String(document.title || "PDF")}`}
                      onClick={() => void openWithAuth(String(document.sourceUrl))}
                    >
                      <FileUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="norium-platform-icon-button"
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
                  className="norium-platform-icon-button text-rose-300"
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
          <input className="norium-platform-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Qual e a politica de reembolso?" />
          <button
            type="button"
            className="norium-platform-button is-primary shrink-0"
            disabled={query.trim().length < 2}
            onClick={async () => {
              const result = await apiRequest<{ answer: string }>("/api/plataforma/conhecimento/consultar", {
                method: "POST",
                body: JSON.stringify({ query, limit: 5 }),
              });
              setAnswer(result.answer);
            }}
          >
            Consultar
          </button>
        </div>
        {answer && <p className="mt-3 rounded-lg border border-[var(--border)] bg-black/10 p-3 text-sm leading-6">{answer}</p>}
      </Panel>

      <Panel title="Transcricao inteligente de reunioes" subtitle="Extraia resumo, decisoes e pendencias antes de criar tarefas." icon={Mic2}>
        <textarea
          className="norium-platform-input min-h-36 resize-y"
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Cole a transcricao da reuniao. O envio de audio pode ser conectado a um provedor no Cofre."
        />
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={transcript.trim().length < 2 || busy === "meeting"}
          onClick={() =>
            void mutate(
              "meeting",
              async () => {
                await apiRequest("/api/plataforma/reunioes/transcrever", {
                  method: "POST",
                  body: JSON.stringify({ title: "Reuniao capturada", transcript, participants: [], createTasks: false }),
                });
                setTranscript("");
              },
              "Reuniao analisada; tarefas aguardam confirmacao.",
            )
          }
        >
          <Mic2 size={16} /> Analisar reuniao
        </button>
      </Panel>

      <Panel title="Assinatura eletronica" subtitle="Acompanhe o ciclo do documento; o status e sempre atualizado manualmente por aqui." icon={FileSignature}>
        <div className="grid gap-2 sm:grid-cols-[1fr_170px]">
          <input className="norium-platform-input" value={signatureTitle} onChange={(event) => setSignatureTitle(event.target.value)} placeholder="Contrato comercial" />
          <select
            className="norium-platform-input"
            value={signatureProvider}
            onChange={(event) => setSignatureProvider(event.target.value as typeof signatureProvider)}
          >
            <option value="manual">Manual</option>
            <option value="clicksign">ClickSign</option>
            <option value="docusign">DocuSign</option>
            <option value="zapsign">ZapSign</option>
          </select>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
          {signatureProvider === "manual"
            ? "Voce mesmo atualiza o status conforme o documento e assinado fora do Norium."
            : `Ainda nao ha integracao automatica com ${signatureProvider === "clicksign" ? "ClickSign" : signatureProvider === "docusign" ? "DocuSign" : "ZapSign"}. O envelope fica registrado aqui, mas voce precisa atualizar o status manualmente ate a integracao ser conectada.`}
        </p>
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={signatureTitle.trim().length < 2 || busy === "signature"}
          onClick={() =>
            void mutate(
              "signature",
              async () => {
                await apiRequest("/api/plataforma/assinaturas", {
                  method: "POST",
                  body: JSON.stringify({
                    title: signatureTitle,
                    provider: signatureProvider,
                    documentUrl: "documento-pendente",
                    signers: [{ name: "Signatario", email: "pendente@norium.local" }],
                    message: "",
                  }),
                });
                setSignatureTitle("");
              },
              "Envelope criado para acompanhamento.",
            )
          }
        >
          <FileSignature size={16} /> Criar envelope
        </button>
        <CompactList items={signatures} empty="Nenhum documento em assinatura." />
      </Panel>
    </div>
  );
}

function SecurityArea({
  session,
  users,
  rules,
  credentials,
  auditPreview,
  mutate,
  busy,
  onNavigate,
}: {
  session: AuthSession;
  users: NoriumUser[];
  rules: JsonItem[];
  credentials: JsonItem[];
  auditPreview: AuditEntry[];
  mutate: MutationRunner;
  busy: string;
  onNavigate?: (tab: string) => void;
}) {
  const [ruleName, setRuleName] = useState("");
  const [amount, setAmount] = useState("1000");
  const [integration, setIntegration] = useState("clicksign");
  const [secret, setSecret] = useState("");
  const members = useMemo(() => users.filter((item) => item.id !== session.user.id), [session.user.id, users]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Trilha de auditoria" subtitle="Registro de acoes sensiveis do sistema, consolidado no Controle operacional." icon={ScanSearch}>
        {auditPreview.length === 0 ? (
          <EmptyState text="Nenhum evento de auditoria registrado ainda." />
        ) : (
          <div className="mt-1 space-y-2">
            {auditPreview.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-[var(--border)] bg-black/10 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-bold">{entry.description || entry.action || "Acao registrada"}</span>
                  <span className="shrink-0 text-xs font-bold uppercase text-[var(--text-secondary)]">{entry.status || ""}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {entry.actor?.name || "Sistema"} - {entry.source || "geral"}
                </p>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="norium-platform-button mt-3 w-full justify-center"
          onClick={() => onNavigate?.("Controle")}
        >
          <ScanSearch size={16} /> Ver auditoria completa no Controle
        </button>
      </Panel>

      <Panel title="Matriz de permissoes" subtitle="Quem tem acesso a cada tela e integracao, de relance." icon={UserRoundCog} className="xl:col-span-2">
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

      <Panel title="Regras de aprovacao" subtitle="Bloqueie gastos, envios em massa e exclusoes ate um responsavel aprovar." icon={ShieldCheck}>
        <div className="grid gap-2 sm:grid-cols-[1fr_130px]">
          <input className="norium-platform-input" value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="Gastos de alto valor" />
          <input className="norium-platform-input" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </div>
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={ruleName.trim().length < 2 || users.length === 0 || busy === "rule"}
          onClick={() =>
            void mutate(
              "rule",
              async () => {
                await apiRequest("/api/plataforma/regras-aprovacao", {
                  method: "POST",
                  body: JSON.stringify({
                    name: ruleName,
                    resource: "finance",
                    condition: { amountAbove: Number(amount) },
                    approverIds: [session.user.id],
                    active: true,
                  }),
                });
                setRuleName("");
              },
              "Regra de aprovacao ativada.",
            )
          }
        >
          <Plus size={16} /> Criar regra
        </button>
        <CompactList items={rules} empty="Nenhuma regra configurada." />
      </Panel>

      <Panel title="Cofre de integracoes" subtitle="Segredos sao criptografados e nunca voltam para a interface." icon={KeyRound}>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="norium-platform-input" value={integration} onChange={(event) => setIntegration(event.target.value)} placeholder="Integracao" />
          <input className="norium-platform-input" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Token ou chave" />
        </div>
        <button
          type="button"
          className="norium-platform-button is-primary mt-3"
          disabled={integration.trim().length < 2 || secret.length < 4 || busy === "vault"}
          onClick={() =>
            void mutate(
              "vault",
              async () => {
                await apiRequest("/api/plataforma/cofre", {
                  method: "POST",
                  body: JSON.stringify({ integration, label: `${integration} principal`, secret, scopes: [] }),
                });
                setSecret("");
              },
              "Credencial criptografada no cofre.",
            )
          }
        >
          <KeyRound size={16} /> Armazenar
        </button>
        <CompactList items={credentials} empty="Nenhuma credencial armazenada." />
      </Panel>

      <Panel title="Simulacao de permissoes" subtitle="Veja exatamente o que um membro enxerga, sem conhecer a senha dele." icon={UserRoundCog}>
        {members.length === 0 ? (
          <EmptyState text="Crie um membro da equipe para simular o acesso." />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                className="norium-platform-action justify-between"
                onClick={async () => {
                  const simulated = await apiRequest<{ user: NoriumUser }>(`/api/plataforma/permissoes/simular/${member.id}`, { method: "POST" });
                  const allowed = Object.entries(normalizePermissions(simulated.user.permissions))
                    .filter(([, enabled]) => enabled)
                    .map(([key]) => permissionLabels[key as keyof typeof permissionLabels]);
                  await showAlert({
                    title: `Permissoes de ${simulated.user.nome}`,
                    description: allowed.length ? allowed.join(", ") : "Nenhum modulo liberado.",
                  });
                }}
              >
                <span className="min-w-0 text-left">
                  <strong className="block truncate">{member.nome}</strong>
                  <small className="block truncate text-[var(--text-secondary)]">{member.email}</small>
                </span>
                <BriefcaseBusiness size={16} />
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Outbox e idempotencia" subtitle="Confira operacoes protegidas contra duplicidade e repeticao por timeout." icon={WalletCards}>
        <button
          type="button"
          className="norium-platform-button"
          onClick={async () => {
            const payload = await apiRequest<{ pending: number; failed: number }>("/api/system/outbox");
            await showAlert({
              title: "Diagnóstico da fila",
              description: `Operações pendentes: ${payload.pending}\nOperações com falha: ${payload.failed}`,
            });
          }}
        >
          <ScanSearch size={16} /> Abrir diagnostico
        </button>
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
    <section className={`norium-platform-card ${className}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-400">
          <Icon size={18} />
        </span>
        <div>
          <h2 className="font-black">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function CompactList({ items, empty }: { items: JsonItem[]; empty: string }) {
  if (!items.length) return <EmptyState text={empty} />;
  return (
    <div className="mt-4 max-h-52 space-y-2 overflow-y-auto pr-1">
      {items.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-black/10 px-3 py-2">
          <span className="min-w-0 truncate text-sm font-bold">{String(item.name || item.title || item.id)}</span>
          <span className="shrink-0 text-xs font-bold uppercase text-[var(--text-secondary)]">
            {String(item.status || (item.active === false ? "inativo" : "ativo"))}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--text-secondary)]">{text}</p>;
}

function JsonPreview({ value }: { value: Record<string, unknown> }) {
  return (
    <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-black/20 p-3 text-xs leading-5 text-[var(--text-secondary)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function StatusBanner({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 text-sm font-bold ${
        tone === "error" ? "border-red-500/35 bg-red-500/10 text-red-300" : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
      }`}
    >
      {children}
    </div>
  );
}
