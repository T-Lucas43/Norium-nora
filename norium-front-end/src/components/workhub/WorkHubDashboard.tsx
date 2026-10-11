import "../../styles/screens/trabalho-comum.css";
import "../../styles/screens/central.css";
import {
  Crosshair,
  SquareCheck,
  type LucideIcon,
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
    <main className="nx-page nxw-screen nxc-page">
      <header className="nx-ph">
        <div>
          <h1>Central de trabalho</h1>
          <p>Tudo que está pendente na operação, em um lugar</p>
        </div>
        <div className="nx-ph-actions">
          <button type="button" onClick={() => void load()} className="nxw-icon-btn" title="Atualizar" aria-label="Atualizar">
            <RefreshCw className={loading ? "nxw-spin" : ""} size={16} />
          </button>
          <button type="button" onClick={() => void toggleFocus()} disabled={!data.focus || busy === "focus"} className={`nx-btn ${data.focus?.item.enabled ? "is-on" : ""}`}>
            <Crosshair size={16} /> {data.focus?.item.enabled ? "Encerrar foco" : "Modo foco"}
          </button>
          <button type="button" onClick={() => onOpenNora("Analise a Central de trabalho, priorize o que exige atenção agora e proponha os próximos passos.")} className="nx-btn is-primary">
            <Sparkles size={16} /> Priorizar com a Nora
          </button>
        </div>
      </header>

      <section className="nx-kpis" aria-label="Resumo da Central">
        <Kpi label="Prioridades abertas" value={data.pending ? `${data.pending.total}${data.pending.complete ? "" : "+"}` : "—"} sub={data.pending ? `${data.pending.items.filter((item) => item.severity === "error").length} com prioridade alta` : undefined} />
        <Kpi label="Atendimentos em aberto" value={data.pending?.inboxOpen ?? "—"} sub="na caixa compartilhada" />
        <Kpi label="Ações nesta semana" value={data.weekly?.actionsExecuted ?? "—"} sub="ações comprovadas" />
        <Kpi label="Horas economizadas" value={data.weekly ? `${data.weekly.estimatedHoursSaved} h` : "—"} sub="pela Nora e automações" />
      </section>

      {data.pending?.items[0] && <button type="button" className="nx-card nxc-next" onClick={() => onOpenDeepLink(data.pending!.items[0].deepLink)}>
        <span className="nxw-icon is-sm"><Target size={16} /></span>
        <span className="nx-grow"><span className="nxw-row-t" style={{ display: "block", fontWeight: 600 }}>Próxima prioridade</span><span className="nxw-row-sub" style={{ display: "block" }}>{data.pending.items[0].title} · {data.pending.items[0].description}</span></span>
        <span className="nxc-next-go">Abrir item <ChevronRight size={14} /></span>
      </button>}

      <nav className="nx-tabs" aria-label="Áreas da Central de trabalho">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} aria-pressed={activeTab === tab.id} className={`nx-tab ${activeTab === tab.id ? "is-active" : ""}`}>
            {tab.label}
            {tab.id === "pending" && Boolean(data.pending?.total) && <span className="nxw-tab-count">{data.pending?.total}</span>}
          </button>
        ))}
      </nav>

      {(activeTab === "pending" || activeTab === "followups") && <div className="nxc-sources" aria-label="Fontes das pendências">
        {sources.map((source) => <span key={source.key} className={`nx-badge nxc-source is-${source.status}`}>
          {source.status === "loading" ? <LoaderCircle size={13} className="nxw-spin" /> : source.status === "ready" ? <Check size={13} /> : <CircleAlert size={13} />}
          {source.label}<small>{source.status === "loading" ? "Atualizando" : source.status === "error" ? "Atualização pendente" : "Atualizado"}</small>
        </span>)}
      </div>}
      {loadErrors.map((failure) => <div key={failure.key} className="nxw-alert is-error" role="alert"><span>{failure.label}: {failure.message}</span><button type="button" className="nx-btn is-sm" onClick={() => void failure.retry()}>Tentar novamente</button></div>)}
      {tabLoading && <div className="nxw-alert" role="status"><LoaderCircle className="nxw-spin" size={16} /> Carregando {tabs.find((tab) => tab.id === activeTab)?.label.toLocaleLowerCase("pt-BR")}...</div>}
      {error && <div className="nxw-alert is-error">{error}</div>}
      {notice && <div className="nxw-alert is-success"><Check size={16} /> {notice}</div>}

      {activeTab === "pending" && data.pending && (
        <section className="nx-card">
          <div className="nx-card-h nxc-card-h">
            <div><h2>Pendências consolidadas</h2><p>Aprovações, atrasos, falhas e mensagens sem resposta.</p></div>
            <strong className="nxc-card-h-meta">{data.pending.total} item(ns){!data.pending.complete && " · parcial"}</strong>
          </div>
          <div>
            {visiblePending.map((item) => {
              const source = pendingSource(item);
              const SourceIcon = source.icon;
              const severity = severityBadge(item.severity);
              return (
                <button key={item.id} type="button" className="nxw-row" onClick={() => onOpenDeepLink(item.deepLink)}>
                  <span className={`nxw-icon ${source.tone}`}><SourceIcon size={16} /></span>
                  <span className="nx-grow"><span className="nxw-row-t" style={{ display: "block" }}>{item.title}</span><span className="nxw-row-sub" style={{ display: "block" }}>{item.description} · {source.label} · <time>{formatDate(item.timestamp)}</time></span></span>
                  <span className="nxc-row-meta">
                    <span className={`nx-badge ${severity.tone}`}>{severity.label}</span>
                    <span className="nx-btn is-sm nxc-row-go">Abrir <ChevronRight size={14} /></span>
                  </span>
                </button>
              );
            })}
            {!data.pending.items.length && <div className="nxw-empty">{data.pending.complete ? <Check size={24} /> : <CircleAlert size={24} />}<strong>{data.pending.complete ? "Nenhuma pendência." : "Nenhum item nas fontes carregadas."}</strong>{!data.pending.complete && <span>O total será consolidado quando todas as fontes estiverem disponíveis.</span>}</div>}
          </div>
          {data.pending.items.length > 0 && (
            <footer className="nxc-pagination">
              <span>Exibindo {(pendingPage - 1) * pendingPageSize + 1}–{Math.min(pendingPage * pendingPageSize, data.pending.items.length)} de {data.pending.total} itens</span>
              <div>
                <button type="button" className="nxw-icon-btn is-sm" disabled={pendingPage === 1} onClick={() => setPendingPage((page) => Math.max(1, page - 1))} aria-label="Pagina anterior"><ChevronLeft size={16} /></button>
                {Array.from({ length: Math.min(5, pendingPageCount) }, (_, index) => {
                  const start = Math.max(1, Math.min(pendingPage - 2, pendingPageCount - 4));
                  const page = start + index;
                  return <button key={page} type="button" onClick={() => setPendingPage(page)} className={`nx-btn is-sm nxc-page-btn ${page === pendingPage ? "is-current" : ""}`}>{page}</button>;
                })}
                <button type="button" className="nxw-icon-btn is-sm" disabled={pendingPage === pendingPageCount} onClick={() => setPendingPage((page) => Math.min(pendingPageCount, page + 1))} aria-label="Proxima pagina"><ChevronRight size={16} /></button>
              </div>
              <select className="nxw-field" value={pendingPageSize} onChange={(event) => { setPendingPageSize(Number(event.target.value)); setPendingPage(1); }} aria-label="Itens por pagina">
                <option value={10}>10 por página</option><option value={20}>20 por página</option><option value={50}>50 por página</option>
              </select>
            </footer>
          )}
        </section>
      )}

      {activeTab === "inbox" && data.inbox && (
        <section className="nx-card">
          <div className="nx-card-h nxc-card-h">
            <div><h2>Caixa de entrada compartilhada</h2><p>Atribua responsável, status, prioridade e prazo de atendimento.</p></div>
            <select className="nxw-field" style={{ marginLeft: "auto" }} value={inboxFilter} onChange={(event) => setInboxFilter(event.target.value)}>
              <option value="abertos">Em aberto</option><option value="meus">Atribuídos</option><option value="todos">Todos</option>
            </select>
          </div>
          <div>
            {visibleInbox.map((item) => (
              <article key={item.id} className="nxc-inbox-row">
                <button type="button" className="nxc-inbox-open" onClick={() => onOpenDeepLink(item.deepLink)}>
                  <span className={`nx-badge ${item.source === "gmail" ? "is-red" : item.source === "whatsapp" ? "is-green" : ""}`}>{item.source}</span>
                  <span className="nx-grow"><span className="nxw-row-t nx-ell" style={{ display: "block" }}>{item.title}</span><span className="nxw-row-sub nx-ell" style={{ display: "block" }}>{item.counterpart || item.description}</span></span>
                </button>
                <select className="nxw-field" disabled={!data.members} value={item.assignedToId || ""} onChange={(event) => {
                  const member = (data.members?.members || []).find((candidate) => candidate.id === event.target.value);
                  void updateInbox(item, { assignedToId: member?.id || null, assignedToName: member?.nome || null });
                }}>
                  <option value="">Sem responsável</option>
                  {(data.members?.members || []).map((member) => <option key={member.id} value={member.id}>{member.nome}</option>)}
                </select>
                <select className="nxw-field" value={item.status} onChange={(event) => void updateInbox(item, { status: event.target.value })}>
                  <option value="novo">Novo</option><option value="em_atendimento">Em atendimento</option><option value="aguardando">Aguardando</option><option value="resolvido">Resolvido</option><option value="arquivado">Arquivado</option>
                </select>
                <input className="nxw-field" type="datetime-local" value={item.dueAt?.slice(0, 16) || ""} onChange={(event) => void updateInbox(item, { dueAt: event.target.value || null })} aria-label="Prazo de atendimento" />
              </article>
            ))}
            {!visibleInbox.length && <div className="nxw-empty"><Inbox size={24} /><strong>Nenhuma conversa neste filtro.</strong></div>}
          </div>
        </section>
      )}

      {activeTab === "followups" && data.pending && (
        <section className="nx-card">
          <div className="nx-card-h nxc-card-h">
            <div><h2>Follow-ups inteligentes</h2><p>A Nora detecta conversas paradas e prazos próximos sem executar nada sem sua decisão.</p></div>
            <button type="button" className="nx-btn" style={{ marginLeft: "auto" }} disabled={busy === "followups"} onClick={() => void mutate("followups", () => apiRequest("/api/operacao/acompanhamentos/detectar", { method: "POST" }), "Análise concluída.")}>
              {busy === "followups" ? <LoaderCircle className="nxw-spin" size={16} /> : <RefreshCw size={16} />} Detectar agora
            </button>
          </div>
          <div>
            {data.pending.items.filter((item) => item.kind === "followup").map((item) => (
              <button key={item.id} type="button" className="nxw-row" onClick={() => onOpenDeepLink(item.deepLink)}>
                <span className="nxw-icon is-amber"><MessageSquareReply size={16} /></span>
                <span className="nx-grow"><span className="nxw-row-t" style={{ display: "block" }}>{item.title}</span><span className="nxw-row-sub" style={{ display: "block" }}>{item.description}</span></span>
                <time className="nx-faint nx-small">{formatDate(item.timestamp)}</time>
              </button>
            ))}
            {!data.pending.items.some((item) => item.kind === "followup") && <div className="nxw-empty"><MessageSquareReply size={24} /><strong>{data.pendingActivity ? "Nenhum follow-up aberto." : "Aguardando os acompanhamentos."}</strong>{data.pendingActivity && <span>Execute a detecção para analisar canais e prazos.</span>}</div>}
          </div>
        </section>
      )}

      {activeTab === "team" && (
        <section className="nx-card">
          <div className="nx-card-h nxc-card-h"><div><h2>Metas e indicadores da equipe</h2><p>Resultados úteis por responsável, sem pontuação artificial.</p></div></div>
          <div className="nxc-goal-form">
            <input className="nxw-field" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} placeholder="Nome da meta" />
            <select className="nxw-field" value={goalMetric} onChange={(event) => setGoalMetric(event.target.value)}><option value="completedTasks">Tarefas concluídas</option><option value="messagesHandled">Mensagens atendidas</option><option value="completedFollowUps">Follow-ups concluídos</option><option value="automationExecutions">Automações executadas</option></select>
            <input className="nxw-field" type="number" min="1" value={goalTarget} onChange={(event) => setGoalTarget(event.target.value)} />
            <button type="button" className="nx-btn is-primary" onClick={() => void createGoal()}><Target size={16} /> Criar meta</button>
          </div>
          {Boolean(data.goals?.items.length) && <div className="nxc-goals">
            {data.goals?.items.map((goal) => {
              const progress = Math.min(100, Math.round((Number(goal.current || 0) / Math.max(goal.target, 1)) * 100));
              return <article key={goal.id} className="nxc-goal"><div className="nx-grow"><div className="nxw-row-t">{goal.title}</div><div className="nxw-row-sub">{goal.current || 0} de {goal.target} · {goal.assigneeName || "Equipe"}</div></div><div className="nx-bar"><i style={{ width: `${progress}%` }} /></div><b style={{ fontWeight: 600 }}>{progress}%</b></article>;
            })}
          </div>}
          <div className="nxw-scroll-x" style={{ borderTop: "1px solid var(--nx-border)" }}>
            <table className="nx-table nxc-team-table">
              <thead><tr><th>Membro</th><th>Concluídas</th><th>Pendentes</th><th>Em execução</th><th>Vencidas</th><th>Atendimentos</th></tr></thead>
              <tbody>
                {data.productivity?.members.map((member) => <tr key={member.userId}><td style={{ fontWeight: 500 }}>{member.name}</td><td>{member.completedTasks}</td><td>{member.pendingTasks}</td><td>{member.inProgressTasks}</td><td>{member.overdueTasks}</td><td>{member.messagesHandled}</td></tr>)}
              </tbody>
            </table>
          </div>
          {data.weekly && <div className="nxc-weekly"><div className="nxw-row-t" style={{ fontWeight: 600 }}>{data.weekly.headline}</div><div className="nxw-row-sub">{data.weekly.estimatedHoursSaved} h estimadas economizadas · {data.weekly.actionsExecuted} ações comprovadas</div></div>}
        </section>
      )}

      {activeTab === "data" && (
        <section className="nx-card">
          <div className="nx-card-h nxc-card-h"><div><h2>Dados, dispositivos e continuidade</h2><p>Importe, exporte, proteja e acompanhe o uso da conta.</p></div></div>
          <div className="nxc-data-actions">
            <DataAction icon={FileUp} title="Importar CSV" text="Clientes, tarefas ou lançamentos, com pré-validação." onClick={() => fileRef.current?.click()} />
            <DataAction icon={CloudDownload} title="Exportar CSV" text="Dados legíveis para planilhas." onClick={() => void exportData("csv")} />
            <DataAction icon={CloudDownload} title="Exportar conta" text="Arquivo completo e estruturado." onClick={() => void exportData("json")} />
            <DataAction icon={BellRing} title="Ativar push" text="Alertas no computador e celular." onClick={() => void enablePush()} />
            <DataAction icon={DatabaseBackup} title="Criar backup" text="Snapshot isolado desta conta." onClick={() => void mutate("backup", () => apiRequest("/api/operacao/backups", { method: "POST" }), "Backup criado.")} />
            <DataAction icon={Focus} title="Saúde das integrações" text="Testes, reconexão e auditoria." onClick={() => onNavigate("Controle")} />
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importCsv(file);
            event.currentTarget.value = "";
          }} />
          {data.usage && <div className="nxc-usage">
            <Kpi label="Ações da Nora" value={data.usage.item.noraActions} />
            <Kpi label="Eventos" value={data.usage.item.events} />
            <Kpi label="Automações" value={data.usage.item.automations} />
            <Kpi label="Execuções" value={data.usage.item.automationExecutions} />
            <Kpi label="Integrações" value={data.usage.item.integrations} />
            <Kpi label="Armazenamento MB" value={data.usage.item.storageMb} />
          </div>}
          {data.backups && <div style={{ borderTop: "1px solid var(--nx-border)" }}>
            <div className="nx-card-h"><h3>Backups disponíveis</h3></div>
            {data.backups.items.map((backup) => <article key={backup.id} className="nxw-row"><span className="nxw-icon is-gray is-sm"><DatabaseBackup size={16} /></span><span className="nx-grow"><span className="nxw-row-t" style={{ display: "block" }}>{formatDate(backup.createdAt)}</span><span className="nxw-row-sub" style={{ display: "block" }}>{backup.files.length} arquivo(s) · {(backup.sizeBytes / 1024).toFixed(1).replace(".", ",")} KB</span></span><button type="button" className="nxw-icon-btn is-sm" title="Restaurar backup" onClick={async () => {
              const confirmed = await showConfirm({
                title: "Restaurar backup?",
                description: "A restauração substituirá os dados atuais deste ambiente.",
                confirmLabel: "Restaurar backup",
                tone: "warning",
              });
              if (confirmed) void mutate(`restore:${backup.id}`, () => apiRequest(`/api/operacao/backups/${backup.id}/restaurar`, { method: "POST", body: JSON.stringify({ confirmation: "RESTAURAR" }) }), "Backup restaurado.");
            }} aria-label="Restaurar backup"><ArchiveRestore size={16} /></button></article>)}
            {!data.backups.items.length && <p className="nx-faint nx-small" style={{ margin: 0, padding: "0 18px 16px" }}>Nenhum backup manual criado.</p>}
          </div>}
        </section>
      )}
    </main>
  );
}

function pendingSource(item: PendingItem) {
  const tab = `${item.deepLink?.tab || ""} ${item.kind || ""}`.toLocaleLowerCase("pt-BR");
  if (tab.includes("email")) return { label: "Externo", icon: Mail, tone: "is-red" };
  if (tab.includes("chat") || tab.includes("whatsapp")) return { label: item.severity === "warning" ? "Atenção" : "Não lida", icon: MessageCircle, tone: "is-green" };
  if (tab.includes("tarefa")) return { label: "Tarefa", icon: SquareCheck, tone: "is-amber" };
  return { label: "Operação", icon: CircleAlert, tone: "" };
}

function severityBadge(severity: PendingItem["severity"]) {
  if (severity === "error") return { label: "Alta", tone: "is-red" };
  if (severity === "warning") return { label: "Média", tone: "is-amber" };
  return { label: "Baixa", tone: "" };
}

function Kpi({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return <article className="nx-card nx-kpi"><div className="nx-kpi-l">{label}</div><div className="nx-kpi-v">{value}</div>{sub && <div className="nx-kpi-s">{sub}</div>}</article>;
}

function DataAction({ icon: Icon, title, text, onClick }: { icon: LucideIcon; title: string; text: string; onClick: () => void }) {
  return <button type="button" className="nx-card nxc-data-action" onClick={onClick}><span className="nxw-icon is-sm"><Icon size={16} /></span><span className="nx-grow"><span className="nxw-row-t" style={{ display: "block" }}>{title}</span><span className="nxw-row-sub" style={{ display: "block" }}>{text}</span></span></button>;
}
