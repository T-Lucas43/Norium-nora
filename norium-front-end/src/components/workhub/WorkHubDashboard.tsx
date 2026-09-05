import {
  ArchiveRestore,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  DatabaseBackup,
  FileUp,
  Focus,
  Inbox,
  LoaderCircle,
  MessageSquareReply,
  Mail,
  MessageCircle,
  RefreshCw,
  Sparkles,
  Target,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiBaseUrl, authToken } from "../../utils/api";
import { apiRequest } from "../../core/api/client";
import { useWorkHubData, type WorkHubTab } from "./useWorkHubData";
import { showConfirm, showPrompt } from "../shared/AppDialogProvider";

type DeepLink = {
  tab: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};

type PendingItem = {
  id: string;
  kind: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
  timestamp: string;
  deepLink: DeepLink;
};

type InboxItem = {
  id: string;
  source: string;
  title: string;
  description: string;
  counterpart: string;
  status: string;
  priority: string;
  assignedToId?: string | null;
  assignedToName?: string | null;
  dueAt?: string | null;
  internalNotes: Array<{ id: string; text: string; createdAt: string }>;
  deepLink: DeepLink;
  updatedAt: string;
};

type Goal = {
  id: string;
  title: string;
  metric: string;
  target: number;
  current: number;
  period: string;
  assigneeName?: string | null;
};

type TeamMember = { id: string; nome: string; email: string };

export type PendingData = { items: PendingItem[]; total: number; counts: Record<string, number>; inboxOpen?: number | null; complete?: boolean };

export type WorkHubData = {
  pending: PendingData;
  pendingActivity: PendingData;
  pendingTasks: PendingData;
  pendingFinance: PendingData;
  pendingMessages: PendingData;
  pendingIntegrations: PendingData;
  inbox: { items: InboxItem[]; total: number; statusCounts: Record<string, number> };
  goals: { items: Goal[] };
  productivity: {
    members: Array<{
      userId: string;
      name: string;
      completedTasks: number;
      pendingTasks: number;
      inProgressTasks: number;
      overdueTasks: number;
      messagesHandled: number;
      averageResponseMinutes: number;
    }>;
  };
  weekly: {
    headline: string;
    estimatedHoursSaved: number;
    actionsExecuted: number;
    eventsByChannel: Record<string, number>;
  };
  focus: { item: { enabled: boolean; objective: string; label: string; sources: string[] } };
  usage: {
    item: {
      noraActions: number;
      events: number;
      automations: number;
      automationExecutions: number;
      integrations: number;
      storageMb: number;
    };
  };
  backups: { items: Array<{ id: string; createdAt: string; sizeBytes: number; files: string[] }> };
  members: { members: TeamMember[] };
};

type TabId = WorkHubTab;

const tabs: Array<{ id: TabId; label: string; icon: typeof Inbox }> = [
  { id: "pending", label: "Pendências", icon: CircleAlert },
  { id: "inbox", label: "Caixa compartilhada", icon: Inbox },
  { id: "followups", label: "Follow-ups", icon: MessageSquareReply },
  { id: "team", label: "Metas e equipe", icon: UsersRound },
  { id: "data", label: "Dados e segurança", icon: DatabaseBackup },
];

function formatDate(value?: string | null) {
  if (!value) return "Sem prazo";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export default function WorkHubDashboard({
  onNavigate,
  onOpenDeepLink,
  onOpenNora,
}: {
  onNavigate: (tab: string) => void;
  onOpenDeepLink: (link: DeepLink) => void;
  onOpenNora: (prompt?: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("pending");
  const { data, loading, tabLoading, sources, errors: loadErrors, refresh: load } = useWorkHubData(activeTab);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inboxFilter, setInboxFilter] = useState("abertos");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalTarget, setGoalTarget] = useState("10");
  const [goalMetric, setGoalMetric] = useState("completedTasks");
  const [pendingPage, setPendingPage] = useState(1);
  const [pendingPageSize, setPendingPageSize] = useState(10);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const visibleInbox = useMemo(() => {
    const items = data.inbox?.items || [];
    if (inboxFilter === "todos") return items;
    if (inboxFilter === "meus") return items.filter((item) => item.assignedToId);
    return items.filter((item) => !["resolvido", "arquivado"].includes(item.status));
  }, [data.inbox?.items, inboxFilter]);

  const pendingPageCount = Math.max(1, Math.ceil((data.pending?.items.length || 0) / pendingPageSize));
  const visiblePending = useMemo(() => {
    const start = (pendingPage - 1) * pendingPageSize;
    return (data.pending?.items || []).slice(start, start + pendingPageSize);
  }, [data.pending?.items, pendingPage, pendingPageSize]);

  useEffect(() => {
    setPendingPage((current) => Math.min(current, pendingPageCount));
  }, [pendingPageCount]);

  async function mutate(label: string, task: () => Promise<unknown>, success: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
      setNotice(success);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "A operação não pôde ser concluída.");
    } finally {
      setBusy("");
    }
  }

  async function updateInbox(item: InboxItem, patch: Record<string, unknown>) {
    await mutate(
      `inbox:${item.id}`,
      () =>
        apiRequest(`/api/operacao/inbox-compartilhada/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      "Atendimento atualizado.",
    );
  }

  async function createGoal() {
    if (!goalTitle.trim() || Number(goalTarget) <= 0) return;
    await mutate(
      "goal",
      () =>
        apiRequest("/api/operacao/metas", {
          method: "POST",
          body: JSON.stringify({
            title: goalTitle.trim(),
            metric: goalMetric,
            target: Number(goalTarget),
            period: "weekly",
          }),
        }),
      "Meta criada para a equipe.",
    );
    setGoalTitle("");
  }

  async function toggleFocus() {
    const current = data.focus?.item;
    await mutate(
      "focus",
      () =>
        apiRequest("/api/operacao/foco", {
          method: "PATCH",
          body: JSON.stringify({
            enabled: !current?.enabled,
            objective: current?.objective || "pendencias",
            label: current?.label || "Resolver prioridades",
            sources: current?.sources || ["gmail", "whatsapp", "kanban", "calendar", "financeiro"],
          }),
        }),
      current?.enabled ? "Modo foco encerrado." : "Modo foco ativado.",
    );
  }

  async function enablePush() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setError("Este navegador não oferece suporte a notificações push.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setError("A permissão de notificações não foi concedida.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (!existing && !vapid) {
      new Notification("Norium", { body: "Notificações locais ativadas neste dispositivo." });
      setNotice("Notificações locais ativadas. Configure VITE_VAPID_PUBLIC_KEY para push com o Norium fechado.");
      return;
    }
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapid,
      }));
    const serialized = subscription.toJSON();
    await mutate(
      "push",
      () =>
        apiRequest("/api/operacao/push/inscricoes", {
          method: "POST",
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            keys: serialized.keys || {},
            deviceName: navigator.platform || "Navegador",
            userAgent: navigator.userAgent,
          }),
        }),
      "Dispositivo inscrito para receber notificações.",
    );
  }

  async function exportData(format: "json" | "csv") {
    setBusy(`export:${format}`);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/operacao/dados/exportar?format=${format}`, {
        headers: { Authorization: `Bearer ${authToken()}` },
      });
      if (!response.ok) throw new Error("Falha ao exportar os dados.");
      downloadBlob(await response.blob(), `norium-dados.${format}`);
      setNotice(`Exportação ${format.toUpperCase()} concluída.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao exportar.");
    } finally {
      setBusy("");
    }
  }

  async function importCsv(file: File) {
    const kind = await showPrompt({
      title: "Importar arquivo CSV",
      description: "Informe clientes, tarefas ou lancamentos para definir o destino dos registros.",
      defaultValue: "clientes",
      confirmLabel: "Validar arquivo",
      required: true,
    });
    if (!kind || !["clientes", "tarefas", "lancamentos"].includes(kind)) return;
    const content = await file.text();
    await mutate(
      "import",
      async () => {
        const preview = await fetch(
          `${apiBaseUrl}/api/operacao/dados/importar-csv?kind=${kind}&dry_run=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authToken()}`,
              "Content-Type": "text/csv",
            },
            body: content,
          },
        );
        const validation = (await preview.json()) as { valid: number; errors: unknown[] };
        if (!preview.ok || validation.errors?.length) {
          throw new Error(`Importação cancelada: ${validation.errors?.length || 1} linha(s) inválida(s).`);
        }
        const confirmed = await showConfirm({
          title: "Confirmar importação",
          description: `${validation.valid} registro(s) válidos foram encontrados e serão importados.`,
          confirmLabel: "Importar dados",
        });
        if (!confirmed) return;
        const response = await fetch(`${apiBaseUrl}/api/operacao/dados/importar-csv?kind=${kind}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken()}`,
            "Content-Type": "text/csv",
          },
          body: content,
        });
        if (!response.ok) throw new Error("O backend recusou a importação.");
      },
      "Dados importados com validação.",
    );
  }

  return (
    <main className="min-h-[calc(100dvh-74px)] bg-[var(--background)] p-4 text-[var(--text)] sm:p-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="flex flex-col gap-4 overflow-hidden rounded-2xl border border-blue-400/20 bg-[linear-gradient(125deg,rgba(37,99,235,.13),rgba(8,145,178,.06)_52%,var(--surface)_86%)] p-5 shadow-xl shadow-black/10 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.16em] text-cyan-400">Operação unificada</p>
            <h1 className="mt-1 text-2xl font-black">Central de trabalho</h1>
            <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
              Prioridades, atendimentos e próximos passos conectados em um só lugar.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onOpenNora("Analise a Central de trabalho, priorize o que exige atenção agora e proponha os próximos passos.")} className="workhub-button is-nora">
              <Sparkles size={16} /> Priorizar com a Nora
            </button>
            <button type="button" onClick={() => void toggleFocus()} disabled={!data.focus || busy === "focus"} className={`workhub-button ${data.focus?.item.enabled ? "is-active" : ""}`}>
              <Focus size={16} /> {data.focus?.item.enabled ? "Encerrar foco" : "Modo foco"}
            </button>
            <button type="button" onClick={() => void load()} className="workhub-icon-button" title="Atualizar" aria-label="Atualizar">
              <RefreshCw className={loading ? "animate-spin" : ""} size={17} />
            </button>
          </div>
        </header>

        <section className="workhub-kpis" aria-label="Resumo da Central">
          <Kpi label="Prioridades abertas" value={data.pending ? `${data.pending.total}${data.pending.complete ? "" : "+"}` : "—"} />
          <Kpi label="Atendimentos em aberto" value={data.pending?.inboxOpen ?? "—"} />
          <Kpi label="Ações nesta semana" value={data.weekly?.actionsExecuted ?? "—"} />
          <Kpi label="Horas economizadas" value={data.weekly ? `${data.weekly.estimatedHoursSaved} h` : "—"} />
        </section>

        {data.pending?.items[0] && <button type="button" className="workhub-recommendation" onClick={() => onOpenDeepLink(data.pending!.items[0].deepLink)}><span><strong>Próxima prioridade</strong><small>{data.pending.items[0].title} · {data.pending.items[0].description}</small></span><span>Abrir item <ChevronRight size={14} /></span></button>}

        <nav className="workhub-tabs" aria-label="Áreas da Central de trabalho">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={activeTab === tab.id ? "is-active" : ""}>
                <Icon size={16} /> {tab.label}
                {tab.id === "pending" && Boolean(data.pending?.total) && <span>{data.pending?.total}</span>}
              </button>
            );
          })}
        </nav>

        {(activeTab === "pending" || activeTab === "followups") && <div className="workhub-sources" aria-label="Fontes das pendências">
          {sources.map((source) => <span key={source.key} className={`workhub-source is-${source.status}`}>
            {source.status === "loading" ? <LoaderCircle size={13} className="animate-spin" /> : source.status === "ready" ? <Check size={13} /> : <CircleAlert size={13} />}
            {source.label}<small>{source.status === "loading" ? "Atualizando" : source.status === "error" ? "Atualização pendente" : "Atualizado"}</small>
          </span>)}
        </div>}
        {loadErrors.map((failure) => <div key={failure.key} className="workhub-feedback is-error" role="alert"><span>{failure.label}: {failure.message}</span><button type="button" className="workhub-button" onClick={() => void failure.retry()}>Tentar novamente</button></div>)}
        {tabLoading && <div className="workhub-feedback" role="status"><LoaderCircle className="animate-spin" size={18} /> Carregando {tabs.find((tab) => tab.id === activeTab)?.label.toLocaleLowerCase("pt-BR")}...</div>}
        {error && <div className="workhub-feedback is-error">{error}</div>}
        {notice && <div className="workhub-feedback is-success"><Check size={16} /> {notice}</div>}

        {activeTab === "pending" && data.pending && (
          <section className="workhub-panel">
            <div className="workhub-section-heading">
              <div><h2>Pendências consolidadas</h2><p>Aprovações, atrasos, falhas e mensagens sem resposta.</p></div>
              <strong>{data.pending.total} item(ns){!data.pending.complete && " · parcial"}</strong>
            </div>
            <div className="workhub-list">
              {visiblePending.map((item) => {
                const source = pendingSource(item);
                const SourceIcon = source.icon;
                return (
                <button key={item.id} type="button" className={`workhub-row severity-${item.severity}`} onClick={() => onOpenDeepLink(item.deepLink)}>
                  <span className="workhub-row-signal" />
                  <span className={`workhub-row-icon ${source.tone}`}><SourceIcon size={17} /></span>
                  <span className="workhub-row-copy"><span className="flex flex-wrap items-center gap-2"><strong>{item.title}</strong><em>{source.label}</em></span><small>{item.description}</small></span>
                  <time>{formatDate(item.timestamp)}</time>
                  <ChevronRight className="workhub-row-chevron" size={16} />
                </button>
                );
              })}
              {!data.pending.items.length && <div className="workhub-empty">{data.pending.complete ? <Check size={24} /> : <CircleAlert size={24} />}<strong>{data.pending.complete ? "Nenhuma pendência." : "Nenhum item nas fontes carregadas."}</strong>{!data.pending.complete && <span>O total será consolidado quando todas as fontes estiverem disponíveis.</span>}</div>}
            </div>
            {data.pending.items.length > 0 && (
              <footer className="workhub-pagination">
                <span>Exibindo {(pendingPage - 1) * pendingPageSize + 1}–{Math.min(pendingPage * pendingPageSize, data.pending.items.length)} de {data.pending.total} itens</span>
                <div>
                  <button type="button" disabled={pendingPage === 1} onClick={() => setPendingPage((page) => Math.max(1, page - 1))} aria-label="Pagina anterior"><ChevronLeft size={16} /></button>
                  {Array.from({ length: Math.min(5, pendingPageCount) }, (_, index) => {
                    const start = Math.max(1, Math.min(pendingPage - 2, pendingPageCount - 4));
                    const page = start + index;
                    return <button key={page} type="button" onClick={() => setPendingPage(page)} className={page === pendingPage ? "is-active" : ""}>{page}</button>;
                  })}
                  <button type="button" disabled={pendingPage === pendingPageCount} onClick={() => setPendingPage((page) => Math.min(pendingPageCount, page + 1))} aria-label="Proxima pagina"><ChevronRight size={16} /></button>
                </div>
                <select value={pendingPageSize} onChange={(event) => { setPendingPageSize(Number(event.target.value)); setPendingPage(1); }} aria-label="Itens por pagina">
                  <option value={10}>10 por página</option><option value={20}>20 por página</option><option value={50}>50 por página</option>
                </select>
              </footer>
            )}
          </section>
        )}

        {activeTab === "inbox" && data.inbox && (
          <section className="workhub-panel">
            <div className="workhub-section-heading">
              <div><h2>Caixa de entrada compartilhada</h2><p>Atribua responsável, status, prioridade e prazo de atendimento.</p></div>
              <select value={inboxFilter} onChange={(event) => setInboxFilter(event.target.value)}>
                <option value="abertos">Em aberto</option><option value="meus">Atribuídos</option><option value="todos">Todos</option>
              </select>
            </div>
            <div className="workhub-list">
              {visibleInbox.map((item) => (
                <article key={item.id} className="workhub-inbox-row">
                  <button type="button" className="workhub-inbox-open" onClick={() => onOpenDeepLink(item.deepLink)}>
                    <span className={`source-${item.source}`}>{item.source}</span>
                    <span><strong>{item.title}</strong><small>{item.counterpart || item.description}</small></span>
                  </button>
                  <select disabled={!data.members} value={item.assignedToId || ""} onChange={(event) => {
                    const member = (data.members?.members || []).find((candidate) => candidate.id === event.target.value);
                    void updateInbox(item, { assignedToId: member?.id || null, assignedToName: member?.nome || null });
                  }}>
                    <option value="">Sem responsável</option>
                    {(data.members?.members || []).map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}
                  </select>
                  <select value={item.status} onChange={(event) => void updateInbox(item, { status: event.target.value })}>
                    <option value="novo">Novo</option><option value="em_atendimento">Em atendimento</option><option value="aguardando">Aguardando</option><option value="resolvido">Resolvido</option><option value="arquivado">Arquivado</option>
                  </select>
                  <input type="datetime-local" value={item.dueAt?.slice(0, 16) || ""} onChange={(event) => void updateInbox(item, { dueAt: event.target.value || null })} aria-label="Prazo de atendimento" />
                </article>
              ))}
              {!visibleInbox.length && <div className="workhub-empty"><Inbox size={24} /><strong>Nenhuma conversa neste filtro.</strong></div>}
            </div>
          </section>
        )}

        {activeTab === "followups" && data.pending && (
          <section className="workhub-panel">
            <div className="workhub-section-heading">
              <div><h2>Follow-ups inteligentes</h2><p>A Nora detecta conversas paradas e prazos próximos sem executar nada sem sua decisão.</p></div>
              <button type="button" className="workhub-button" disabled={busy === "followups"} onClick={() => void mutate("followups", () => apiRequest("/api/operacao/acompanhamentos/detectar", { method: "POST" }), "Análise concluída.")}>
                {busy === "followups" ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />} Detectar agora
              </button>
            </div>
            <div className="workhub-list">
              {data.pending.items.filter((item) => item.kind === "followup").map((item) => (
                <button key={item.id} type="button" className="workhub-row severity-warning" onClick={() => onOpenDeepLink(item.deepLink)}>
                  <span className="workhub-row-signal" /><span className="workhub-row-copy"><strong>{item.title}</strong><small>{item.description}</small></span><time>{formatDate(item.timestamp)}</time>
                </button>
              ))}
              {!data.pending.items.some((item) => item.kind === "followup") && <div className="workhub-empty"><MessageSquareReply size={24} /><strong>{data.pendingActivity ? "Nenhum follow-up aberto." : "Aguardando os acompanhamentos."}</strong>{data.pendingActivity && <span>Execute a detecção para analisar canais e prazos.</span>}</div>}
            </div>
          </section>
        )}

        {activeTab === "team" && (
          <section className="workhub-panel">
            <div className="workhub-section-heading"><div><h2>Metas e indicadores da equipe</h2><p>Resultados úteis por responsável, sem pontuação artificial.</p></div></div>
            <div className="workhub-goal-form">
              <input value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} placeholder="Nome da meta" />
              <select value={goalMetric} onChange={(event) => setGoalMetric(event.target.value)}><option value="completedTasks">Tarefas concluídas</option><option value="messagesHandled">Mensagens atendidas</option><option value="completedFollowUps">Follow-ups concluídos</option><option value="automationExecutions">Automações executadas</option></select>
              <input type="number" min="1" value={goalTarget} onChange={(event) => setGoalTarget(event.target.value)} />
              <button type="button" className="workhub-button" onClick={() => void createGoal()}><Target size={16} /> Criar meta</button>
            </div>
            <div className="workhub-goals">
              {data.goals?.items.map((goal) => {
                const progress = Math.min(100, Math.round((Number(goal.current || 0) / Math.max(goal.target, 1)) * 100));
                return <article key={goal.id}><div><strong>{goal.title}</strong><small>{goal.current || 0} de {goal.target} · {goal.assigneeName || "Equipe"}</small></div><div className="workhub-progress"><span style={{ width: `${progress}%` }} /></div><b>{progress}%</b></article>;
              })}
            </div>
            <div className="workhub-team-table">
              <div className="workhub-team-head"><span>Membro</span><span>Concluídas</span><span>Pendentes</span><span>Em execução</span><span>Vencidas</span><span>Atendimentos</span></div>
              {data.productivity?.members.map((member) => <div key={member.userId}><strong>{member.name}</strong><span>{member.completedTasks}</span><span>{member.pendingTasks}</span><span>{member.inProgressTasks}</span><span>{member.overdueTasks}</span><span>{member.messagesHandled}</span></div>)}
            </div>
            {data.weekly && <div className="workhub-weekly"><strong>{data.weekly.headline}</strong><span>{data.weekly.estimatedHoursSaved} h estimadas economizadas · {data.weekly.actionsExecuted} ações comprovadas</span></div>}
          </section>
        )}

        {activeTab === "data" && (
          <section className="workhub-panel">
            <div className="workhub-section-heading"><div><h2>Dados, dispositivos e continuidade</h2><p>Importe, exporte, proteja e acompanhe o uso da conta.</p></div></div>
            <div className="workhub-data-actions">
              <button type="button" onClick={() => fileRef.current?.click()}><FileUp size={20} /><strong>Importar CSV</strong><small>Clientes, tarefas ou lançamentos, com pré-validação.</small></button>
              <button type="button" onClick={() => void exportData("csv")}><CloudDownload size={20} /><strong>Exportar CSV</strong><small>Dados legíveis para planilhas.</small></button>
              <button type="button" onClick={() => void exportData("json")}><CloudDownload size={20} /><strong>Exportar conta</strong><small>Arquivo completo e estruturado.</small></button>
              <button type="button" onClick={() => void enablePush()}><BellRing size={20} /><strong>Ativar push</strong><small>Alertas no computador e celular.</small></button>
              <button type="button" onClick={() => void mutate("backup", () => apiRequest("/api/operacao/backups", { method: "POST" }), "Backup criado.")}><DatabaseBackup size={20} /><strong>Criar backup</strong><small>Snapshot isolado desta conta.</small></button>
              <button type="button" onClick={() => onNavigate("Controle")}><Focus size={20} /><strong>Saúde das integrações</strong><small>Testes, reconexão e auditoria.</small></button>
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importCsv(file);
              event.currentTarget.value = "";
            }} />
            {data.usage && <div className="workhub-usage">
              <Kpi label="Ações da Nora" value={data.usage.item.noraActions} />
              <Kpi label="Eventos" value={data.usage.item.events} />
              <Kpi label="Automações" value={data.usage.item.automations} />
              <Kpi label="Execuções" value={data.usage.item.automationExecutions} />
              <Kpi label="Integrações" value={data.usage.item.integrations} />
              <Kpi label="Armazenamento MB" value={data.usage.item.storageMb} />
            </div>}
            {data.backups && <div className="workhub-backups">
              <h3>Backups disponíveis</h3>
              {data.backups.items.map((backup) => <article key={backup.id}><span><strong>{formatDate(backup.createdAt)}</strong><small>{backup.files.length} arquivo(s) · {(backup.sizeBytes / 1024).toFixed(1)} KB</small></span><button type="button" title="Restaurar backup" onClick={async () => {
                const confirmed = await showConfirm({
                  title: "Restaurar backup?",
                  description: "A restauração substituirá os dados atuais deste ambiente.",
                  confirmLabel: "Restaurar backup",
                  tone: "warning",
                });
                if (confirmed) void mutate(`restore:${backup.id}`, () => apiRequest(`/api/operacao/backups/${backup.id}/restaurar`, { method: "POST", body: JSON.stringify({ confirmation: "RESTAURAR" }) }), "Backup restaurado.");
              }} aria-label="Restaurar backup"><ArchiveRestore size={16} /></button></article>)}
              {!data.backups.items.length && <p>Nenhum backup manual criado.</p>}
            </div>}
          </section>
        )}
      </div>
    </main>
  );
}

function pendingSource(item: PendingItem) {
  const tab = `${item.deepLink?.tab || ""} ${item.kind || ""}`.toLocaleLowerCase("pt-BR");
  if (tab.includes("email")) return { label: "Externo", icon: Mail, tone: "is-email" };
  if (tab.includes("chat") || tab.includes("whatsapp")) return { label: item.severity === "warning" ? "Atenção" : "Não lida", icon: MessageCircle, tone: "is-whatsapp" };
  if (tab.includes("tarefa")) return { label: "Tarefa", icon: Check, tone: "is-task" };
  return { label: "Operação", icon: CircleAlert, tone: "is-default" };
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return <article className="workhub-kpi"><strong>{value}</strong><span>{label}</span></article>;
}
