import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  BrainCircuit,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  DatabaseBackup,
  FileCheck2,
  FileStack,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
  XCircle,
} from "lucide-react";

import { apiBaseUrl, authToken } from "../../utils/api";
import { showConfirm } from "../shared/AppDialogProvider";
import Button from "../shared/Button";

type Summary = {
  pendingApprovals: number;
  activeTasks: number;
  overdueTasks: number;
  todayEvents: number;
  financialReminders: number;
  unhealthyIntegrations: number;
};

type Approval = {
  id: string;
  title: string;
  description: string;
  action: string;
  source: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "executed" | "failed";
  createdAt: string;
  requestedBy?: { name?: string };
};

type IntegrationHealth = {
  id: string;
  name: string;
  status: "online" | "attention" | "offline";
  connected: boolean;
  lastSync?: string | null;
  detail: string;
  permissions: string[];
  failures: number;
};

type OperationEntry = {
  id: string;
  action: string;
  title?: string;
  description: string;
  status: string;
  timestamp: string;
  actor?: { name?: string };
  entityType?: string | null;
  entityId?: string | null;
  undoAction?: string | null;
  metadata?: Record<string, unknown>;
};

type TaskItem = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
};

type CalendarItem = {
  id: string;
  title: string;
  description: string;
  timestamp: string;
};

type FinancialReminder = {
  id: string;
  title: string;
  amount: number;
  dueDate: string;
  daysUntil: number;
};

type OperationsOverview = {
  generatedAt: string;
  summary: Summary;
  myDay: {
    tasks: TaskItem[];
    calendar: CalendarItem[];
    financialReminders: FinancialReminder[];
    financeSummary: Record<string, number>;
  };
  approvals: Approval[];
  audit: OperationEntry[];
  receipts: OperationEntry[];
  integrations: IntegrationHealth[];
  briefing: {
    greeting: string;
    title: string;
    description: string;
    generatedAt: string;
    priority?: ProactiveAlert | null;
  };
  alerts: ProactiveAlert[];
  memory: NoraMemory[];
  templates: OperationTemplate[];
  followUps: FollowUp[];
  settings: OperationSettings;
};

type OperationTemplate = {
  id: string;
  name: string;
  kind: "email" | "task" | "calendar" | "finance" | "automation" | "message";
  description: string;
  tags: string[];
};

type FollowUp = {
  id: string;
  title: string;
  channel: string;
  status: "open" | "done" | "cancelled" | "snoozed";
  counterpart: string;
  dueAt?: string | null;
};

type OperationSettings = {
  autonomy: "confirm_all" | "balanced" | "autonomous";
  dailyBriefing: boolean;
  smartReminders: boolean;
  followUpHours: number;
};

type ProactiveAlert = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  description: string;
  tab: string;
};

type NoraMemory = {
  id: string;
  key: string;
  value: string;
  category: "communication" | "client" | "project" | "process" | "general";
  scope: "personal" | "team";
  updatedAt?: string;
};

type TimelineMode = "receipts" | "audit";

const API_URL = `${apiBaseUrl()}/api/operacao`;
const CACHE_KEY = "norium-operations-overview";

function cacheKey(userId: string) {
  return `${CACHE_KEY}:${userId}`;
}

function headers(): HeadersInit {
  const token = authToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function cachedOverview(userId: string): OperationsOverview | null {
  try {
    const payload = sessionStorage.getItem(cacheKey(userId));
    return payload ? (JSON.parse(payload) as OperationsOverview) : null;
  } catch {
    return null;
  }
}

function formatDate(value?: string | null, includeDate = true) {
  if (!value) return "Ainda nao sincronizado";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    ...(includeDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function entryTarget(entry: OperationEntry): string | null {
  const value = `${entry.entityType || ""} ${entry.action || ""}`.toLocaleLowerCase("pt-BR");
  if (/email|gmail/.test(value)) return "E-mails";
  if (/task|tarefa|kanban/.test(value)) return "Tarefas";
  if (/financ|lancamento|boleto|gasto/.test(value)) return "Gastos";
  if (/calendar|agenda|evento/.test(value)) return "Agenda";
  if (/automation|automacao/.test(value)) return "Automações";
  if (/team|equipe/.test(value)) return "Equipe";
  return null;
}

type OperationsDashboardProps = {
  onNavigate?: (tab: string) => void;
  userId: string;
};

export default function OperationsDashboard({ onNavigate, userId }: OperationsDashboardProps) {
  const [overview, setOverview] = useState<OperationsOverview | null>(() => cachedOverview(userId));
  const [loading, setLoading] = useState(!overview);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("receipts");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalTitle, setApprovalTitle] = useState("");
  const [approvalDescription, setApprovalDescription] = useState("");
  const [savingApproval, setSavingApproval] = useState(false);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [editingApproval, setEditingApproval] = useState<Approval | null>(null);
  const [checkingIntegrationId, setCheckingIntegrationId] = useState<string | null>(null);
  const [memoryKey, setMemoryKey] = useState("");
  const [memoryValue, setMemoryValue] = useState("");
  const [memoryScope, setMemoryScope] = useState<"personal" | "team">("personal");
  const [savingMemory, setSavingMemory] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [undoingReceiptId, setUndoingReceiptId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateKind, setTemplateKind] = useState<OperationTemplate["kind"]>("email");
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDueAt, setFollowUpDueAt] = useState("");

  const loadOverview = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`${API_URL}/resumo`, { headers: headers() });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao carregar o controle operacional.");
      const payload = (await response.json()) as OperationsOverview;
      setOverview(payload);
      sessionStorage.setItem(cacheKey(userId), JSON.stringify(payload));
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Controle operacional indisponivel.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadOverview(Boolean(sessionStorage.getItem(cacheKey(userId))));
    const timer = window.setInterval(() => void loadOverview(true), 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadOverview(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadOverview, userId]);

  const pendingApprovals = useMemo(
    () => (overview?.approvals || []).filter((approval) => approval.status === "pending"),
    [overview?.approvals],
  );
  const timeline = timelineMode === "receipts" ? overview?.receipts || [] : overview?.audit || [];
  const editingWhatsAppApproval = editingApproval?.source === "whatsapp" && editingApproval.action === "nora_whatsapp_execute";

  function closeApprovalDialog() {
    setApprovalOpen(false);
    setEditingApproval(null);
    setApprovalTitle("");
    setApprovalDescription("");
  }

  function openNewApproval() {
    setEditingApproval(null);
    setApprovalTitle("");
    setApprovalDescription("");
    setApprovalOpen(true);
  }

  function openApprovalEditor(approval: Approval) {
    setEditingApproval(approval);
    setApprovalTitle(approval.title);
    setApprovalDescription(approval.description || "");
    setApprovalOpen(true);
  }

  async function saveApproval() {
    if (!approvalTitle.trim()) {
      setError("Informe o que precisa ser aprovado.");
      return;
    }
    setSavingApproval(true);
    try {
      const response = await fetch(`${API_URL}/aprovacoes${editingApproval ? `/${editingApproval.id}` : ""}`, {
        method: editingApproval ? "PUT" : "POST",
        headers: headers(),
        body: JSON.stringify(editingApproval
          ? { title: approvalTitle.trim(), description: approvalDescription.trim() }
          : {
              title: approvalTitle.trim(),
              description: approvalDescription.trim(),
              action: "manual_review",
              source: "operacao",
              payload: {},
              metadata: { createdFrom: "operations_dashboard" },
            }),
      });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao solicitar aprovacao.");
      const wasEditing = Boolean(editingApproval);
      closeApprovalDialog();
      setNotice(wasEditing ? "Solicitacao atualizada antes da decisao." : "Aprovacao criada e enviada para o controle operacional.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao solicitar aprovacao.");
    } finally {
      setSavingApproval(false);
    }
  }

  async function decideApproval(approvalId: string, decision: "approved" | "rejected") {
    setDecisionId(approvalId);
    try {
      const response = await fetch(`${API_URL}/aprovacoes/${approvalId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ decision, note: "Decisao registrada pelo painel operacional." }),
      });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao registrar a decisao.");
      setNotice(decision === "approved" ? "Solicitacao aprovada." : "Solicitacao rejeitada.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao registrar a decisao.");
    } finally {
      setDecisionId(null);
    }
  }

  async function testIntegration(integrationId: string) {
    setCheckingIntegrationId(integrationId);
    try {
      const response = await fetch(`${API_URL}/integracoes/${integrationId}/testar`, {
        method: "POST",
        headers: headers(),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; detail?: string };
      if (!response.ok) throw new Error(payload.detail || "Falha ao testar a integracao.");
      setNotice(payload.ok ? "Integracao testada com sucesso." : "A integracao precisa ser reconectada.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao testar a integracao.");
    } finally {
      setCheckingIntegrationId(null);
    }
  }

  async function saveMemory() {
    if (!memoryKey.trim() || !memoryValue.trim()) {
      setError("Informe um nome e o conteudo da preferencia.");
      return;
    }
    setSavingMemory(true);
    try {
      const response = await fetch(`${API_URL}/memoria-nora`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          key: memoryKey.trim(),
          value: memoryValue.trim(),
          category: "general",
          scope: memoryScope,
        }),
      });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao salvar a preferencia.");
      setMemoryKey("");
      setMemoryValue("");
      setNotice("Preferencia salva na memoria controlada da Nora.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao salvar a preferencia.");
    } finally {
      setSavingMemory(false);
    }
  }

  async function deleteMemory(memoryId: string) {
    setDeletingMemoryId(memoryId);
    try {
      const response = await fetch(`${API_URL}/memoria-nora/${memoryId}`, { method: "DELETE", headers: headers() });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao remover a preferencia.");
      setNotice("Preferencia removida da memoria da Nora.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao remover a preferencia.");
    } finally {
      setDeletingMemoryId(null);
    }
  }

  async function exportAudit() {
    try {
      const response = await fetch(`${API_URL}/auditoria/exportar`, { headers: headers() });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao exportar a auditoria.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "norium-auditoria.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Auditoria exportada em CSV.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao exportar a auditoria.");
    }
  }

  async function undoOperation(receiptId: string) {
    const confirmed = await showConfirm({
      title: "Desfazer operação?",
      description: "O Norium tentará restaurar o estado anterior e registrará a reversão na auditoria.",
      confirmLabel: "Desfazer operação",
      tone: "warning",
    });
    if (!confirmed) return;
    setUndoingReceiptId(receiptId);
    try {
      const response = await fetch(`${API_URL}/comprovantes/${receiptId}/desfazer`, { method: "POST", headers: headers() });
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail || "Nao foi possivel desfazer a operacao.");
      setNotice("Operacao desfeita e estado anterior restaurado.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel desfazer a operacao.");
    } finally {
      setUndoingReceiptId(null);
    }
  }

  async function createTemplate() {
    if (!templateName.trim()) return;
    const response = await fetch(`${API_URL}/modelos`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: templateName.trim(), kind: templateKind, description: "", content: {}, tags: [] }),
    });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao criar o modelo.");
      return;
    }
    setTemplateName("");
    setNotice("Modelo operacional criado.");
    await loadOverview(true);
  }

  async function deleteTemplate(templateId: string) {
    const response = await fetch(`${API_URL}/modelos/${templateId}`, { method: "DELETE", headers: headers() });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao excluir o modelo.");
      return;
    }
    await loadOverview(true);
  }

  async function createFollowUp() {
    if (!followUpTitle.trim()) return;
    const response = await fetch(`${API_URL}/acompanhamentos`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: followUpTitle.trim(), channel: "other", dueAt: followUpDueAt || null, counterpart: "", description: "", metadata: {} }),
    });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao criar o acompanhamento.");
      return;
    }
    setFollowUpTitle("");
    setFollowUpDueAt("");
    setNotice("Acompanhamento adicionado.");
    await loadOverview(true);
  }

  async function updateFollowUp(followUpId: string, status: FollowUp["status"]) {
    const response = await fetch(`${API_URL}/acompanhamentos/${followUpId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao atualizar o acompanhamento.");
      return;
    }
    await loadOverview(true);
  }

  async function updateAutonomy(autonomy: OperationSettings["autonomy"]) {
    const response = await fetch(`${API_URL}/configuracoes`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ autonomy }),
    });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao atualizar a autonomia.");
      return;
    }
    setNotice("Nivel de autonomia atualizado.");
    await loadOverview(true);
  }

  async function downloadBackup() {
    const response = await fetch(`${API_URL}/backup`, { headers: headers() });
    if (!response.ok) {
      setError((await response.text()) || "Falha ao gerar o backup.");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "norium-backup.zip";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Backup do seu espaco gerado.");
  }

  if (loading && !overview) {
    return (
      <div className="grid h-full min-h-[560px] place-items-center bg-[var(--background)] text-[var(--text-secondary)]">
        <span className="flex items-center gap-3 text-sm font-bold"><LoaderCircle className="animate-spin" size={19} /> Preparando o controle operacional...</span>
      </div>
    );
  }

  const summary = overview?.summary || {
    pendingApprovals: 0,
    activeTasks: 0,
    overdueTasks: 0,
    todayEvents: 0,
    financialReminders: 0,
    unhealthyIntegrations: 0,
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--background)] p-4 text-[var(--text)] sm:p-6 xl:p-8">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="flex flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-blue-400"><ShieldCheck size={24} /></span>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-blue-400">Governanca em tempo real</p>
              <h1 className="mt-1 text-2xl font-black">Controle operacional</h1>
              <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">Aprovacoes, integracoes, auditoria e comprovantes em uma unica visao.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void loadOverview(true)}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} /> Atualizar
            </Button>
            <Button variant="primary" onClick={openNewApproval} className="bg-blue-600 hover:bg-blue-500">
              <Plus size={17} /> Nova aprovacao
            </Button>
          </div>
        </header>

        {(error || notice) && (
          <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-bold ${error ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
            <span>{error || notice}</span>
            <button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="Fechar aviso"><X size={16} /></button>
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <MetricCard icon={ClipboardCheck} label="Aprovacoes" value={summary.pendingApprovals} tone="amber" />
          <MetricCard icon={ListChecks} label="Tarefas ativas" value={summary.activeTasks} tone="blue" />
          <MetricCard icon={AlertTriangle} label="Tarefas vencidas" value={summary.overdueTasks} tone="rose" />
          <MetricCard icon={CalendarDays} label="Agenda hoje" value={summary.todayEvents} tone="violet" />
          <MetricCard icon={CircleDollarSign} label="Lembretes" value={summary.financialReminders} tone="emerald" />
          <MetricCard icon={Activity} label="Integracoes em atencao" value={summary.unhealthyIntegrations} tone="cyan" />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,.75fr)_minmax(0,1.25fr)]">
          <article className="rounded-lg border border-blue-500/25 bg-blue-500/8 p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/15 text-blue-300"><BrainCircuit size={20} /></span>
              <div>
                <p className="text-xs font-bold uppercase text-blue-300">Briefing da Nora</p>
                <h2 className="mt-1 font-black">{overview?.briefing?.greeting || "Resumo"}. {overview?.briefing?.title || "Seu painel esta atualizado"}</h2>
                <p className="mt-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{overview?.briefing?.description || "Os dados operacionais estao sendo consolidados."}</p>
                <p className="mt-3 text-xs font-bold uppercase text-[var(--text-secondary)]">Atualizado em {formatDate(overview?.briefing?.generatedAt || overview?.generatedAt)}</p>
              </div>
            </div>
          </article>
          <article className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <SectionHeader title="Alertas proativos" description="Pendencias calculadas com seus dados reais." icon={BellRing} action={`${overview?.alerts?.length || 0} alerta(s)`} />
            <div className="grid max-h-52 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
              {(overview?.alerts || []).length === 0 ? (
                <p className="col-span-full rounded-lg border border-dashed border-[var(--border)] p-5 text-center text-xs font-semibold text-[var(--text-secondary)]">Nenhum alerta operacional neste momento.</p>
              ) : (overview?.alerts || []).map((alert) => (
                <button key={alert.id} type="button" onClick={() => onNavigate?.(alert.tab)} className="flex min-w-0 items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-left hover:bg-[var(--surface-hover)]">
                  <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${alert.severity === "error" ? "bg-rose-400" : alert.severity === "warning" ? "bg-amber-400" : "bg-blue-400"}`} />
                  <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-bold">{alert.title}</strong><small className="mt-1 line-clamp-2 font-semibold leading-5 text-[var(--text-secondary)]">{alert.description}</small></span>
                  <ChevronRight className="mt-1 shrink-0 text-[var(--text-secondary)]" size={14} />
                </button>
              ))}
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <details className="group overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between p-4 hover:bg-[var(--surface-hover)]">
              <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-500/12 text-blue-300"><FileStack size={17} /></span><span><strong className="block text-sm font-bold">Modelos reutilizaveis</strong><small className="font-semibold text-[var(--text-secondary)]">{overview?.templates?.length || 0} modelo(s)</small></span></span>
              <ChevronRight className="transition group-open:rotate-90" size={16} />
            </summary>
            <div className="space-y-3 border-t border-[var(--border)] p-4">
              <div className="grid grid-cols-[1fr_120px_auto] gap-2">
                <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Nome do modelo" className="h-9 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none focus:border-blue-500" />
                <select value={templateKind} onChange={(event) => setTemplateKind(event.target.value as OperationTemplate["kind"])} className="h-9 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold"><option value="email">E-mail</option><option value="task">Tarefa</option><option value="calendar">Agenda</option><option value="finance">Financeiro</option><option value="automation">Automacao</option><option value="message">Mensagem</option></select>
                <Button variant="primary" size="sm" iconOnly onClick={() => void createTemplate()} disabled={!templateName.trim()} className="bg-blue-600" title="Criar modelo" aria-label="Criar modelo"><Plus size={15} /></Button>
              </div>
              <div className="max-h-40 space-y-2 overflow-y-auto">
                {(overview?.templates || []).map((template) => <article key={template.id} className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="min-w-0 flex-1"><strong className="block truncate text-xs font-bold">{template.name}</strong><small className="font-bold uppercase text-blue-300">{template.kind}</small></div><Button variant="danger" iconOnly onClick={() => void deleteTemplate(template.id)} className="h-7 w-7 text-rose-300 hover:bg-rose-500/10" title="Excluir modelo" aria-label="Excluir modelo"><Trash2 size={13} /></Button></article>)}
                {(overview?.templates || []).length === 0 && <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-xs font-semibold text-[var(--text-secondary)]">Crie respostas, tarefas e rotinas padronizadas.</p>}
              </div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between p-4 hover:bg-[var(--surface-hover)]">
              <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-500/12 text-cyan-300"><Send size={17} /></span><span><strong className="block text-sm font-bold">Aguardando resposta</strong><small className="font-semibold text-[var(--text-secondary)]">{(overview?.followUps || []).filter((item) => item.status === "open").length} aberto(s)</small></span></span>
              <ChevronRight className="transition group-open:rotate-90" size={16} />
            </summary>
            <div className="space-y-3 border-t border-[var(--border)] p-4">
              <input value={followUpTitle} onChange={(event) => setFollowUpTitle(event.target.value)} placeholder="O que precisa de retorno?" className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none focus:border-blue-500" />
              <div className="grid grid-cols-[1fr_auto] gap-2"><input type="datetime-local" value={followUpDueAt} onChange={(event) => setFollowUpDueAt(event.target.value)} className="h-9 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold" /><Button variant="ghost" size="sm" onClick={() => void createFollowUp()} disabled={!followUpTitle.trim()} className="bg-cyan-600">Adicionar</Button></div>
              <div className="max-h-32 space-y-2 overflow-y-auto">{(overview?.followUps || []).filter((item) => item.status === "open").map((item) => <article key={item.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"><div className="min-w-0 flex-1"><strong className="block truncate text-xs font-bold">{item.title}</strong><small className="font-semibold text-[var(--text-secondary)]">{item.dueAt ? formatDate(item.dueAt) : "Sem prazo"}</small></div><Button variant="primary" iconOnly onClick={() => void updateFollowUp(item.id, "done")} className="h-7 w-7 text-emerald-300 hover:bg-emerald-500/10" title="Marcar como concluido" aria-label="Marcar como concluido"><Check size={14} /></Button></article>)}</div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between p-4 hover:bg-[var(--surface-hover)]">
              <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/12 text-violet-300"><SlidersHorizontal size={17} /></span><span><strong className="block text-sm font-bold">Autonomia e dados</strong><small className="font-semibold text-[var(--text-secondary)]">Controle por usuario</small></span></span>
              <ChevronRight className="transition group-open:rotate-90" size={16} />
            </summary>
            <div className="space-y-3 border-t border-[var(--border)] p-4">
              <label className="block text-xs font-bold uppercase text-[var(--text-secondary)]">Nivel de autonomia<select value={overview?.settings?.autonomy || "balanced"} onChange={(event) => void updateAutonomy(event.target.value as OperationSettings["autonomy"])} className="mt-2 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold normal-case text-[var(--text)]"><option value="confirm_all">Confirmar todas as acoes</option><option value="balanced">Equilibrado</option><option value="autonomous">Autonomo em baixo risco</option></select></label>
              <p className="text-xs font-semibold leading-5 text-[var(--text-secondary)]">Envios, exclusoes e alteracoes sensiveis continuam protegidos pela Central de aprovacoes.</p>
              <button type="button" onClick={() => void downloadBackup()} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[var(--border)] text-xs font-bold hover:bg-[var(--surface-hover)]"><DatabaseBackup size={15} /> Baixar backup do meu espaco</button>
            </div>
          </details>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,.65fr)]">
          <div className="space-y-5">
            <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <SectionHeader title="Central de aprovacoes" description="Acoes sensiveis ficam visiveis antes da decisao." icon={ClipboardCheck} action={`${pendingApprovals.length} pendente(s)`} />
              <div className="divide-y divide-[var(--border)]">
                {pendingApprovals.length === 0 ? (
                  <EmptyState icon={CheckCircle2} title="Tudo aprovado por aqui" description="Novas solicitacoes aparecerao automaticamente." />
                ) : pendingApprovals.map((approval) => (
                  <article key={approval.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><strong className="truncate text-sm font-bold">{approval.title}</strong><span className="rounded-full bg-amber-500/12 px-2 py-1 text-xs font-bold uppercase text-amber-300">pendente</span></div>
                      <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{approval.description || `Acao: ${approval.action}`}</p>
                      <p className="mt-2 text-xs font-bold text-[var(--text-secondary)]">{approval.requestedBy?.name || "Operador"} · {formatDate(approval.createdAt)}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" disabled={decisionId === approval.id} onClick={() => openApprovalEditor(approval)}><Pencil size={14} /> Editar</Button>
                      <Button variant="danger" size="sm" disabled={decisionId === approval.id} onClick={() => void decideApproval(approval.id, "rejected")} className="border-rose-500/25 text-rose-300 hover:bg-rose-500/10"><XCircle size={15} /> Rejeitar</Button>
                      <Button variant="primary" size="sm" disabled={decisionId === approval.id} onClick={() => void decideApproval(approval.id, "approved")} className="bg-emerald-600 hover:bg-emerald-500">{decisionId === approval.id ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />} Aprovar</Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="font-black">Rastreabilidade</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Veja o que foi executado e por quem.</p></div>
                <div className="flex flex-wrap items-center gap-2"><div className="inline-flex rounded-lg border border-[var(--border)] p-1"><ModeButton active={timelineMode === "receipts"} onClick={() => setTimelineMode("receipts")}>Comprovantes</ModeButton><ModeButton active={timelineMode === "audit"} onClick={() => setTimelineMode("audit")}>Auditoria</ModeButton></div>{timelineMode === "audit" && <Button size="sm" onClick={() => void exportAudit()}><Download size={14} /> Exportar CSV</Button>}</div>
              </div>
              <div className="max-h-[390px] divide-y divide-[var(--border)] overflow-y-auto">
                {timeline.length === 0 ? (
                  <EmptyState icon={FileCheck2} title="Historico pronto para registrar" description="As proximas acoes concluidas aparecerao aqui." />
                ) : timeline.map((entry) => (
                  <article key={entry.id} className="flex items-start gap-3 px-5 py-4">
                    <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${entry.status === "failed" || entry.status === "error" ? "bg-rose-500/12 text-rose-300" : "bg-emerald-500/12 text-emerald-300"}`}>{entry.status === "failed" || entry.status === "error" ? <XCircle size={17} /> : <FileCheck2 size={17} />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-4"><strong className="truncate text-sm font-bold">{entry.title || entry.action}</strong><time className="shrink-0 text-xs font-bold text-[var(--text-secondary)]">{formatDate(entry.timestamp)}</time></div>
                      <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{entry.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <span className="inline-flex text-xs font-bold uppercase text-blue-400">{entry.actor?.name || "Norium"}</span>
                        {entry.entityId && <span className="truncate text-xs font-bold text-[var(--text-secondary)]">Registro: {entry.entityId}</span>}
                        {timelineMode === "receipts" && entryTarget(entry) && onNavigate && (
                          <button type="button" onClick={() => onNavigate(entryTarget(entry) as string)} className="inline-flex items-center gap-1 text-xs font-bold uppercase text-cyan-300 hover:text-cyan-200">
                            Abrir resultado <ExternalLink size={12} />
                          </button>
                        )}
                        {timelineMode === "receipts" && entry.undoAction && !entry.metadata?.undoneAt && (
                          <button type="button" disabled={undoingReceiptId === entry.id} onClick={() => void undoOperation(entry.id)} className="inline-flex items-center gap-1 text-xs font-bold uppercase text-amber-300 hover:text-amber-200 disabled:opacity-50">
                            {undoingReceiptId === entry.id ? <LoaderCircle className="animate-spin" size={12} /> : <Undo2 size={12} />} Desfazer
                          </button>
                        )}
                        {timelineMode === "receipts" && Boolean(entry.metadata?.undoneAt) && <span className="text-xs font-bold uppercase text-amber-300">Operacao desfeita</span>}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <SectionHeader title="Saude das integracoes" description="Estado local e ultima sincronizacao." icon={Activity} />
              <div className="divide-y divide-[var(--border)]">
                {(overview?.integrations || []).map((integration) => (
                  <article key={integration.id} className="flex items-start gap-3 px-4 py-4">
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${integration.status === "online" ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>{integration.status === "online" ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3"><strong className="truncate text-sm font-bold">{integration.name}</strong><span className={`text-xs font-bold uppercase ${integration.status === "online" ? "text-emerald-300" : "text-amber-300"}`}>{integration.status === "online" ? "online" : "atencao"}</span></div>
                      <p className="mt-1 truncate text-xs font-semibold text-[var(--text-secondary)]">{integration.detail}</p>
                      <p className="mt-1 text-xs font-bold text-[var(--text-secondary)]">Ultima sincronizacao: {formatDate(integration.lastSync)}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(integration.permissions || []).map((permission) => <span key={permission} className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-bold uppercase text-[var(--text-secondary)]">{permission}</span>)}
                        {integration.failures > 0 && <span className="rounded-full bg-rose-500/12 px-2 py-1 text-xs font-bold uppercase text-rose-300">{integration.failures} falha(s)</span>}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" disabled={checkingIntegrationId === integration.id} onClick={() => void testIntegration(integration.id)} className="uppercase">
                          {checkingIntegrationId === integration.id ? <LoaderCircle className="animate-spin" size={13} /> : <RefreshCw size={13} />} Testar
                        </Button>
                        {!integration.connected && onNavigate && (
                          <Button variant="primary" size="sm" onClick={() => onNavigate(integration.id === "gmail" ? "E-mails" : integration.id === "calendar" ? "Agenda" : integration.id === "whatsapp" ? "Chat" : "Mais")} className="bg-blue-600 uppercase hover:bg-blue-500">
                            Reconectar <ChevronRight size={13} />
                          </Button>
                        )}
                      </div>
                    </div>
                    {onNavigate && integration.connected && (
                      <Button size="sm" iconOnly
                       
                        onClick={() => onNavigate(integration.id === "gmail" ? "E-mails" : integration.id === "calendar" ? "Agenda" : integration.id === "whatsapp" ? "Chat" : "Mais")}
                        className="text-[var(--text-secondary)] hover:text-[var(--text)]"
                        aria-label={`Abrir ${integration.name}`}
                        title={`Abrir ${integration.name}`}
                      >
                        <ChevronRight size={15} />
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <details className="group overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 hover:bg-[var(--surface-hover)]">
                <span className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cyan-500/12 text-cyan-300"><BrainCircuit size={17} /></span><span className="min-w-0"><strong className="block truncate text-sm font-bold">Memoria controlada da Nora</strong><small className="block truncate font-semibold text-[var(--text-secondary)]">{overview?.memory?.length || 0} preferencia(s) salva(s)</small></span></span>
                <ChevronRight className="shrink-0 transition group-open:rotate-90" size={16} />
              </summary>
              <div className="space-y-3 border-t border-[var(--border)] p-4">
                <input value={memoryKey} onChange={(event) => setMemoryKey(event.target.value)} maxLength={120} placeholder="Nome da preferencia" className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs font-bold outline-none focus:border-blue-500" />
                <textarea value={memoryValue} onChange={(event) => setMemoryValue(event.target.value)} maxLength={1200} rows={3} placeholder="Ex.: prefiro respostas profissionais e objetivas." className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-semibold outline-none focus:border-blue-500" />
                <div className="flex gap-2">
                  <select value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as "personal" | "team")} className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-xs font-bold outline-none">
                    <option value="personal">Somente para mim</option><option value="team">Compartilhar com a equipe</option>
                  </select>
                  <Button variant="primary" size="sm" disabled={savingMemory} onClick={() => void saveMemory()} className="bg-blue-600 hover:bg-blue-500">{savingMemory ? <LoaderCircle className="animate-spin" size={14} /> : <Plus size={14} />} Salvar</Button>
                </div>
                <div className="max-h-52 space-y-2 overflow-y-auto">
                  {(overview?.memory || []).map((memory) => (
                    <article key={memory.id} className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                      <div className="min-w-0 flex-1"><div className="flex flex-wrap gap-1.5"><strong className="truncate text-xs font-bold">{memory.key}</strong><span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-xs font-bold uppercase text-blue-300">{memory.scope === "team" ? "equipe" : "pessoal"}</span></div><p className="mt-1 line-clamp-3 text-xs font-semibold leading-4 text-[var(--text-secondary)]">{memory.value}</p></div>
                      <Button variant="danger" size="sm" iconOnly disabled={deletingMemoryId === memory.id} onClick={() => void deleteMemory(memory.id)} className="text-rose-300 hover:bg-rose-500/10" aria-label={`Remover ${memory.key}`}>{deletingMemoryId === memory.id ? <LoaderCircle className="animate-spin" size={14} /> : <Trash2 size={14} />}</Button>
                    </article>
                  ))}
                  {(overview?.memory || []).length === 0 && <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-xs font-semibold text-[var(--text-secondary)]">Nenhuma preferencia salva. A Nora tambem aprende quando voce diz "lembre que...".</p>}
                </div>
              </div>
            </details>

            <section className="rounded-lg border border-blue-500/25 bg-blue-500/8 p-5">
              <div className="flex items-center gap-3 text-blue-300"><ShieldCheck size={21} /><h2 className="font-black">Politica de seguranca</h2></div>
              <p className="mt-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">Operacoes sensiveis podem passar por aprovacao e cada decisao gera um registro rastreavel por usuario.</p>
              <button type="button" onClick={openNewApproval} className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-blue-300 hover:text-blue-200">Solicitar revisao <ChevronRight size={15} /></button>
            </section>
          </aside>
        </div>
      </div>

      {approvalOpen && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/65 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
            <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <div><h2 className="font-black">{editingApproval ? "Editar solicitacao" : "Nova solicitacao de aprovacao"}</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{editingWhatsAppApproval ? "Revise a mensagem. O destinatario permanece protegido e nao pode ser alterado aqui." : editingApproval ? "Ajuste o plano antes de aprovar ou rejeitar." : "Registre a decisao antes de executar uma acao sensivel."}</p></div>
              <Button variant="ghost" size="sm" iconOnly onClick={closeApprovalDialog} aria-label="Fechar"><X size={18} /></Button>
            </header>
            <div className="space-y-4 p-5">
              <label className="block text-xs font-bold uppercase text-[var(--text-secondary)]">{editingWhatsAppApproval ? "Destinatario protegido" : "O que precisa ser aprovado?"}<input value={approvalTitle} onChange={(event) => { if (!editingWhatsAppApproval) setApprovalTitle(event.target.value); }} readOnly={editingWhatsAppApproval} aria-readonly={editingWhatsAppApproval} maxLength={180} className={`mt-2 h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-bold normal-case text-[var(--text)] outline-none ${editingWhatsAppApproval ? "cursor-not-allowed opacity-70" : "focus:border-blue-500"}`} placeholder="Ex.: autorizar envio para toda a base" /></label>
              <label className="block text-xs font-bold uppercase text-[var(--text-secondary)]">{editingWhatsAppApproval ? "Mensagem que sera enviada" : "Contexto"}<textarea value={approvalDescription} onChange={(event) => setApprovalDescription(event.target.value)} maxLength={1200} rows={4} className="mt-2 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-semibold normal-case text-[var(--text)] outline-none focus:border-blue-500" placeholder={editingWhatsAppApproval ? "Revise o texto exato antes de aprovar." : "Explique o impacto e o motivo da solicitacao."} /></label>
            </div>
            <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
              <Button onClick={closeApprovalDialog}>Cancelar</Button>
              <Button variant="primary" disabled={savingApproval} onClick={() => void saveApproval()} className="bg-blue-600 hover:bg-blue-500">{savingApproval ? <LoaderCircle className="animate-spin" size={16} /> : <ClipboardCheck size={16} />} {editingApproval ? "Salvar alteracoes" : "Solicitar aprovacao"}</Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: number; tone: "amber" | "blue" | "rose" | "violet" | "emerald" | "cyan" }) {
  const tones = { amber: "bg-amber-500/12 text-amber-300", blue: "bg-blue-500/12 text-blue-300", rose: "bg-rose-500/12 text-rose-300", violet: "bg-violet-500/12 text-violet-300", emerald: "bg-emerald-500/12 text-emerald-300", cyan: "bg-cyan-500/12 text-cyan-300" };
  return <article className="flex min-h-28 items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${tones[tone]}`}><Icon size={20} /></span><div className="min-w-0"><strong className="block text-2xl font-black">{value}</strong><span className="mt-1 block text-xs font-bold leading-4 text-[var(--text-secondary)]">{label}</span></div></article>;
}

function SectionHeader({ title, description, icon: Icon, action }: { title: string; description: string; icon: LucideIcon; action?: string }) {
  return <header className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-4"><div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-blue-300"><Icon size={17} /></span><div className="min-w-0"><h2 className="truncate font-black">{title}</h2><p className="truncate text-xs font-semibold text-[var(--text-secondary)]">{description}</p></div></div>{action && <span className="shrink-0 rounded-full bg-amber-500/12 px-3 py-1 text-xs font-bold uppercase text-amber-300">{action}</span>}</header>;
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded-md px-3 py-2 text-xs font-bold transition ${active ? "bg-blue-600 text-white" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`}>{children}</button>;
}

function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return <div className="grid min-h-44 place-items-center p-6 text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-emerald-500/10 text-emerald-300"><Icon size={22} /></span><strong className="mt-3 block text-sm font-bold">{title}</strong><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{description}</p></div></div>;
}
