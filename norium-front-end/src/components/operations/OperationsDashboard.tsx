import "../../styles/screens/trabalho-comum.css";
import "../../styles/screens/controle.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest } from "../../core/api/client";
import { workspaceScope } from "../../core/api/sessionScope";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BrainCircuit,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileCheck2,
  ExternalLink,
  LoaderCircle,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SquareCheck,
  Trash2,
  Undo2,
  Wallet,
  X,
  XCircle,
} from "lucide-react";

import { apiBaseUrl, authToken } from "../../utils/api";
import { useOperationsData, type OperationSection } from "./useOperationsData";
import { showConfirm } from "../shared/AppDialogProvider";

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
  digest?: string | null;
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
  actor?: { id?: string; name?: string };
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

export type OperationsOverview = {
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
function headers(): HeadersInit {
  const token = authToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function formatDate(value?: string | null, includeDate = true) {
  if (!value) return "Ainda não sincronizado";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    ...(includeDate ? { day: "2-digit", month: "2-digit", year: "numeric" } : {}),
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
  onOpenNora?: (prompt?: string) => void;
  userId: string;
};

export default function OperationsDashboard({ onNavigate, onOpenNora, userId }: OperationsDashboardProps) {
  const { overview, ready, errors: sectionErrors, refreshing, refresh: loadOverview, loadSection } = useOperationsData(userId);
  const sectionStatus = (section: OperationSection, label: string) => (
    <div role={sectionErrors[section] ? "alert" : "status"} className="nxo-status">
      {sectionErrors[section] ? <><AlertTriangle size={16} /><span>{label} indisponíveis no momento.</span><button type="button" className="nx-btn is-sm" onClick={() => void loadSection(section, true)}>Tentar novamente</button></> : <><LoaderCircle size={16} className="nxw-spin" /><span>Carregando {label.toLocaleLowerCase("pt-BR")}...</span></>}
    </div>
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("receipts");
  const [auditPage, setAuditPage] = useState<{ items: OperationEntry[]; total: number; nextOffset: number | null } | null>(null);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const activeWorkspace = workspaceScope();
  useEffect(() => { setAuditOffset(0); setAuditPage(null); }, [userId, activeWorkspace]);
  useEffect(() => {
    if (timelineMode !== "audit") return;
    const controller = new AbortController();
    setAuditLoading(true); setAuditError("");
    void apiRequest<{ items: OperationEntry[]; total: number; nextOffset: number | null }>(`/api/operacao/auditoria?limit=50&offset=${auditOffset}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setAuditPage(result); })
      .catch(reason => { if (!controller.signal.aborted) setAuditError(reason instanceof Error ? reason.message : "Não foi possível carregar a auditoria."); })
      .finally(() => { if (!controller.signal.aborted) setAuditLoading(false); });
    return () => controller.abort();
  }, [timelineMode, auditOffset, userId, activeWorkspace]);
  const [activeSection, setActiveSection] = useState("operations-approvals");
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

  const pendingApprovals = useMemo(
    () => (overview?.approvals || []).filter((approval) => approval.status === "pending"),
    [overview?.approvals],
  );
  const timeline = timelineMode === "receipts" ? overview?.receipts || [] : auditPage?.items || overview?.audit || [];
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
      if (!response.ok) throw new Error((await response.text()) || "Falha ao solicitar aprovação.");
      const wasEditing = Boolean(editingApproval);
      closeApprovalDialog();
      setNotice(wasEditing ? "Solicitação atualizada antes da decisão." : "Aprovação criada e enviada para o controle operacional.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao solicitar aprovação.");
    } finally {
      setSavingApproval(false);
    }
  }

  async function decideApproval(approvalId: string, decision: "approved" | "rejected", expectedDigest?: string | null) {
    setDecisionId(approvalId);
    try {
      const response = await fetch(`${API_URL}/aprovacoes/${approvalId}`, {
        method: "PATCH",
        headers: headers(),
        // Aprovações exatas só executam o conteúdo mostrado nesta tela.
        body: JSON.stringify({ decision, note: "Decisao registrada pelo painel operacional.", expectedDigest: expectedDigest ?? undefined }),
      });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao registrar a decisão.");
      setNotice(decision === "approved" ? "Solicitação aprovada." : "Solicitação rejeitada.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao registrar a decisão.");
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
      if (!response.ok) throw new Error(payload.detail || "Falha ao testar a integração.");
      setNotice(payload.ok ? "Integração testada com sucesso." : "A integração precisa ser reconectada.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao testar a integração.");
    } finally {
      setCheckingIntegrationId(null);
    }
  }

  async function saveMemory() {
    if (!memoryKey.trim() || !memoryValue.trim()) {
      setError("Informe um nome e o conteúdo da preferência.");
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
      if (!response.ok) throw new Error((await response.text()) || "Falha ao salvar a preferência.");
      setMemoryKey("");
      setMemoryValue("");
      setNotice("Preferência salva na memória controlada da Nora.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao salvar a preferência.");
    } finally {
      setSavingMemory(false);
    }
  }

  async function deleteMemory(memoryId: string) {
    setDeletingMemoryId(memoryId);
    try {
      const response = await fetch(`${API_URL}/memoria-nora/${memoryId}`, { method: "DELETE", headers: headers() });
      if (!response.ok) throw new Error((await response.text()) || "Falha ao remover a preferência.");
      setNotice("Preferência removida da memória da Nora.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao remover a preferência.");
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
      if (!response.ok) throw new Error(payload.detail || "Não foi possível desfazer a operação.");
      setNotice("Operação desfeita e estado anterior restaurado.");
      await loadOverview(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível desfazer a operação.");
    } finally {
      setUndoingReceiptId(null);
    }
  }

  const summary = overview.summary || {};
  const alertsReady = ready.summary && ready.history && ready.integrations;
  const sections: Array<[string, string]> = [["operations-briefing", "Briefing da Nora"], ["operations-approvals", "Aprovações"], ["operations-history", "Histórico"], ["operations-integrations", "Integrações"]];
  const integrationTab = (id: string) => id === "gmail" ? "E-mails" : id === "calendar" ? "Agenda" : id === "whatsapp" ? "Chat" : "Mais";

  return (
    <div className="nx-page nxw-screen nxo-page h-full overflow-y-auto">
      <header className="nx-ph">
        <div>
          <h1>Controle operacional</h1>
          <p>Aprovações, histórico do que foi feito e saúde das integrações</p>
        </div>
        <div className="nx-ph-actions">
          <button type="button" className="nx-btn" onClick={() => void loadOverview(true)} aria-label="Atualizar" title="Atualizar"><RefreshCw className={refreshing ? "nxw-spin" : ""} size={16} />Atualizar</button>
          <button type="button" className="nx-btn" onClick={() => onOpenNora?.("Analise o Controle operacional, explique os alertas e recomende os próximos passos.")}><Sparkles size={16} />Consultar Nora</button>
          <button type="button" className="nx-btn is-primary" onClick={openNewApproval}><Plus size={16} />Nova aprovação</button>
        </div>
      </header>

      {(error || notice) && (
        <div className={`nxw-alert ${error ? "is-error" : "is-success"}`}>
          <span>{error || notice}</span>
          <button type="button" className="nxw-icon-btn is-sm is-plain" onClick={() => { setError(""); setNotice(""); }} aria-label="Fechar aviso"><X size={16} /></button>
        </div>
      )}

      {Object.values(sectionErrors).some(Boolean) && <div role="alert" className="nxw-alert is-warning"><span>Algumas seções não puderam ser atualizadas. Os dados já carregados continuam disponíveis. Use Atualizar para tentar novamente.</span></div>}

      <section className="nx-kpis" aria-label="Resumo operacional">
        <MetricCard label="Aprovações pendentes" value={ready.approvals ? summary.pendingApprovals : undefined} />
        <MetricCard label="Tarefas vencidas" value={ready.summary ? summary.overdueTasks : undefined} />
        <MetricCard label="Agenda hoje" value={ready.summary ? summary.todayEvents : undefined} />
        <MetricCard label="Integrações em atenção" value={ready.integrations ? summary.unhealthyIntegrations : undefined} />
      </section>

      <nav className="nx-tabs" aria-label="Seções do controle operacional">
        {sections.map(([id, label]) => (
          <button key={id} type="button" className={`nx-tab ${activeSection === id ? "is-active" : ""}`} onClick={() => { setActiveSection(id); document.getElementById(id)?.scrollIntoView({ block: "start" }); }}>{label}</button>
        ))}
      </nav>

      <section className="nxo-top">
        <article id="operations-briefing" className="nx-card nxo-briefing">
          <div className="nxo-briefing-in">
            <span className="nxw-icon"><BrainCircuit size={16} /></span>
            <div className="nx-grow">
              <div className="nxo-eyebrow">Briefing da Nora</div>
              <h2 className="nxo-h2">{ready.summary ? `${overview.briefing?.greeting}. ${overview.briefing?.title}` : "Seu resumo operacional"}</h2>
              {ready.summary ? <p className="nxo-text">{overview.briefing?.description}</p> : sectionStatus("summary", "Indicadores")}
              {ready.summary && <p className="nx-faint nx-small" style={{ margin: "10px 0 0" }}>Atualizado em {formatDate(overview.briefing?.generatedAt || overview.generatedAt)}</p>}
            </div>
          </div>
        </article>
        <article className="nx-card">
          <SectionHeader title="Alertas proativos" description="Pendências calculadas com seus dados reais." action={alertsReady ? `${overview.alerts?.length || 0} alerta(s)` : "Verificando fontes"} />
          <div className="nxo-alerts">
            {(overview?.alerts || []).length === 0 ? (
              <p className="nxo-dashed">{alertsReady ? "Nenhum alerta operacional neste momento." : "Aguardando os dados para verificar os alertas."}</p>
            ) : (overview?.alerts || []).map((alert) => (
              <button key={alert.id} type="button" onClick={() => onNavigate?.(alert.tab)} className="nxo-alert">
                <span className={`nxo-dot ${alert.severity === "error" ? "is-red" : alert.severity === "warning" ? "is-amber" : ""}`} />
                <span className="nx-grow"><span className="nxw-row-t nx-ell" style={{ display: "block" }}>{alert.title}</span><span className="nxw-row-sub nxo-clamp">{alert.description}</span></span>
                <ChevronRight className="nx-faint" size={14} />
              </button>
            ))}
          </div>
        </article>
      </section>

      <div className="nxo-grid">
        <div className="nxo-col">
          <section id="operations-approvals" className="nx-card">
            <SectionHeader title="Aprovações pendentes" description="Ações sensíveis ficam visíveis antes da decisão." action={ready.approvals ? `${pendingApprovals.length} pendente(s)` : undefined} />
            <div>
              {!ready.approvals ? sectionStatus("approvals", "Aprovações") : pendingApprovals.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="Tudo aprovado por aqui" description="Novas solicitações aparecerão automaticamente." />
              ) : pendingApprovals.map((approval) => {
                const tone = approvalTone(approval);
                const ToneIcon = tone.icon;
                return (
                  <article key={approval.id} className="nxo-approval">
                    <div className="nxo-approval-head">
                      <span className={`nxw-icon ${tone.className}`}><ToneIcon size={16} /></span>
                      <div className="nx-grow">
                        <div className="nxo-approval-title"><strong>{approval.title}</strong><span className="nx-badge is-amber">Pendente</span></div>
                        <div className="nxw-row-sub nxo-clamp">{approval.description || `Ação: ${approval.action}`}</div>
                        <div className="nx-faint nx-small" style={{ marginTop: 2 }}>{approval.requestedBy?.name || "Operador"} · {formatDate(approval.createdAt)}</div>
                      </div>
                    </div>
                    <div className="nxo-approval-actions">
                      <button type="button" className="nx-btn is-sm is-primary" disabled={decisionId === approval.id} onClick={() => void decideApproval(approval.id, "approved", approval.digest)}>{decisionId === approval.id ? <LoaderCircle className="nxw-spin" size={14} /> : <Check size={14} />} Aprovar</button>
                      <button type="button" className="nx-btn is-sm" disabled={decisionId === approval.id} onClick={() => openApprovalEditor(approval)}><Pencil size={14} /> Editar</button>
                      <button type="button" className="nx-btn is-sm is-ghost nxo-reject" disabled={decisionId === approval.id} onClick={() => void decideApproval(approval.id, "rejected")}><XCircle size={14} /> Rejeitar</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section id="operations-history" className="nx-card">
            <div className="nx-card-h nxo-card-h">
              <div className="nx-grow"><h2>Rastreabilidade</h2><p>Veja o que foi executado e por quem.</p></div>
              <div className="nxo-history-tools">
                <div className="nx-seg"><ModeButton active={timelineMode === "receipts"} onClick={() => setTimelineMode("receipts")}>Comprovantes</ModeButton><ModeButton active={timelineMode === "audit"} onClick={() => setTimelineMode("audit")}>Auditoria</ModeButton></div>
                {timelineMode === "audit" && <button type="button" className="nx-btn is-sm" onClick={() => void exportAudit()}><Download size={14} /> Exportar CSV</button>}
              </div>
            </div>
            <div className="nxo-history">
              {timelineMode === "audit" && auditError && <p role="alert" className="nxo-status">{auditError}</p>}
              {timelineMode === "audit" && auditLoading && <p role="status" className="nxo-status">Carregando auditoria…</p>}
              {!ready.history ? sectionStatus("history", "Registros") : timeline.length === 0 ? (
                <EmptyState icon={FileCheck2} title="Histórico pronto para registrar" description="As próximas ações concluídas aparecerão aqui." />
              ) : timeline.map((entry) => (
                <article key={entry.id} className="nxw-row" style={{ alignItems: "flex-start" }}>
                  <span className={`nxw-icon is-sm ${entry.status === "failed" || entry.status === "error" ? "is-red" : "is-green"}`}>{entry.status === "failed" || entry.status === "error" ? <XCircle size={16} /> : <FileCheck2 size={16} />}</span>
                  <div className="nx-grow">
                    <div className="nxo-entry-head"><strong className="nxw-row-t nx-ell">{entry.title || entry.action}</strong><time className="nx-faint nx-small">{formatDate(entry.timestamp)}</time></div>
                    <p className="nxw-row-sub nxo-clamp" style={{ margin: "2px 0 0" }}>{entry.description}</p>
                    <div className="nxo-entry-meta">
                      <span className="nx-badge is-blue">{entry.actor?.name || entry.actor?.id || "Norium"}</span>
                      {entry.entityId && <span className="nx-faint nx-small nx-ell">Registro: {entry.entityId}</span>}
                      {timelineMode === "receipts" && entryTarget(entry) && onNavigate && (
                        <button type="button" onClick={() => onNavigate(entryTarget(entry) as string)} className="nxo-link">
                          Abrir resultado <ExternalLink size={12} />
                        </button>
                      )}
                      {timelineMode === "receipts" && entry.undoAction && !entry.metadata?.undoneAt && (
                        <button type="button" disabled={undoingReceiptId === entry.id} onClick={() => void undoOperation(entry.id)} className="nxo-link is-amber">
                          {undoingReceiptId === entry.id ? <LoaderCircle className="nxw-spin" size={12} /> : <Undo2 size={12} />} Desfazer
                        </button>
                      )}
                      {timelineMode === "receipts" && Boolean(entry.metadata?.undoneAt) && <span className="nx-badge is-amber">Operação desfeita</span>}
                    </div>
                  </div>
                </article>
              ))}
              {timelineMode === "audit" && auditPage && <nav aria-label="Páginas da auditoria" className="flex flex-wrap items-center justify-between gap-3 p-3">
                <button type="button" className="nx-btn is-sm" disabled={auditLoading || auditOffset === 0} onClick={() => setAuditOffset(value => Math.max(0, value - 50))}>Anterior</button>
                <span className="nx-small">{auditPage.total === 0 ? 0 : auditOffset + 1}–{Math.min(auditOffset + auditPage.items.length, auditPage.total)} de {auditPage.total}</span>
                <button type="button" className="nx-btn is-sm" disabled={auditLoading || auditPage.nextOffset === null} onClick={() => setAuditOffset(auditPage.nextOffset ?? auditOffset)}>Próxima</button>
              </nav>}
            </div>
          </section>
        </div>

        <aside className="nxo-col">
          <details className="nx-card nxo-memory">
            <summary>
              <span className="nxo-memory-sum">
                <strong>Memória controlada da Nora</strong>
                <span className="nx-muted nx-small">{ready.memory ? `${overview.memory?.length || 0} preferência(s) salva(s)` : "Preferências ainda não consultadas"}</span>
                {overview.memory?.[0] && <span className="nx-muted nx-small nxo-clamp">“{overview.memory[0].value}” · {overview.memory[0].scope === "team" ? "compartilhada com a equipe" : "somente para você"}</span>}
              </span>
              <span className="nx-btn is-sm nxo-memory-toggle">Gerenciar memórias <ChevronRight size={14} /></span>
            </summary>
            <div className="nxo-memory-body">
              <input value={memoryKey} onChange={(event) => setMemoryKey(event.target.value)} maxLength={120} placeholder="Nome da preferência" className="nxw-field" style={{ width: "100%" }} />
              <textarea value={memoryValue} onChange={(event) => setMemoryValue(event.target.value)} maxLength={1200} rows={3} placeholder="Ex.: prefiro respostas profissionais e objetivas." className="nxw-field" style={{ width: "100%" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <select value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as "personal" | "team")} className="nxw-field" style={{ flex: 1 }}>
                  <option value="personal">Somente para mim</option><option value="team">Compartilhar com a equipe</option>
                </select>
                <button type="button" className="nx-btn is-primary" disabled={savingMemory} onClick={() => void saveMemory()}>{savingMemory ? <LoaderCircle className="nxw-spin" size={14} /> : <Plus size={14} />} Salvar</button>
              </div>
              <div className="nxo-memory-list">
                {(overview?.memory || []).map((memory) => (
                  <article key={memory.id} className="nxw-action nxo-memory-item">
                    <div className="nx-grow"><div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}><strong className="nxw-row-t nx-ell">{memory.key}</strong><span className="nx-badge is-blue">{memory.scope === "team" ? "Equipe" : "Pessoal"}</span></div><p className="nx-muted nx-small nxo-clamp" style={{ margin: "4px 0 0" }}>{memory.value}</p></div>
                    <button type="button" className="nxw-icon-btn is-sm is-plain nxo-reject" disabled={deletingMemoryId === memory.id} onClick={() => void deleteMemory(memory.id)} aria-label={`Remover ${memory.key}`}>{deletingMemoryId === memory.id ? <LoaderCircle className="nxw-spin" size={14} /> : <Trash2 size={14} />}</button>
                  </article>
                ))}
                {!ready.memory && sectionStatus("memory", "Preferências")}
                {ready.memory && (overview?.memory || []).length === 0 && <p className="nxo-dashed">Nenhuma preferência salva. A Nora também aprende quando você diz "lembre que...".</p>}
              </div>
            </div>
          </details>

          <section className="nx-card nxo-policy">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><ShieldCheck size={16} className="nx-muted" /><strong>Política de segurança</strong></div>
            <p className="nx-muted nx-small" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>Operações sensíveis podem passar por aprovação e cada decisão gera um registro rastreável por usuário.</p>
            <button type="button" onClick={openNewApproval} className="nx-btn is-sm" style={{ marginTop: 10 }}>Solicitar revisão <ChevronRight size={14} /></button>
          </section>

          <section id="operations-integrations" className="nx-card">
            <SectionHeader title="Saúde das integrações" description="Estado local e última sincronização." />
            <div>
              {!ready.integrations && sectionStatus("integrations", "Integrações")}
              {(overview?.integrations || []).map((integration) => (
                <article key={integration.id} className="nxw-row" style={{ alignItems: "flex-start" }}>
                  <span className={`nxw-icon is-sm ${integration.status === "online" ? "is-green" : "is-amber"}`}>{integration.status === "online" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span>
                  <div className="nx-grow">
                    <div className="nxo-entry-head"><strong className="nxw-row-t nx-ell">{integration.name}</strong><span className={`nx-badge ${integration.status === "online" ? "is-green" : "is-amber"}`}>{integration.status === "online" ? "Online" : "Atenção"}</span></div>
                    <p className="nxw-row-sub nx-ell" style={{ margin: "2px 0 0" }}>{integration.detail}</p>
                    <p className="nx-faint nx-small" style={{ margin: "2px 0 0" }}>Última sincronização: {formatDate(integration.lastSync)}</p>
                    <div className="nxo-entry-meta">
                      {(integration.permissions || []).map((permission) => <span key={permission} className="nx-badge">{permission}</span>)}
                      {integration.failures > 0 && <span className="nx-badge is-red">{integration.failures} falha(s)</span>}
                    </div>
                    <div className="nxo-entry-meta">
                      <button type="button" className="nx-btn is-sm" disabled={checkingIntegrationId === integration.id} onClick={() => void testIntegration(integration.id)}>
                        {checkingIntegrationId === integration.id ? <LoaderCircle className="nxw-spin" size={13} /> : <RefreshCw size={13} />} Testar
                      </button>
                      {!integration.connected && onNavigate && (
                        <button type="button" className="nx-btn is-sm is-primary" onClick={() => onNavigate(integrationTab(integration.id))}>
                          Reconectar <ChevronRight size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {onNavigate && integration.connected && (
                    <button type="button" className="nxw-icon-btn is-sm is-plain" onClick={() => onNavigate(integrationTab(integration.id))} aria-label={`Abrir ${integration.name}`} title={`Abrir ${integration.name}`}>
                      <ChevronRight size={15} />
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {approvalOpen && (
        <div className="nxo-modal-backdrop">
          <div className="nx-card nxo-modal" role="dialog" aria-modal="true" aria-label={editingApproval ? "Editar solicitação" : "Nova solicitação de aprovação"}>
            <header className="nxo-modal-h">
              <div className="nx-grow"><h2 className="nxo-h2" style={{ margin: 0 }}>{editingApproval ? "Editar solicitação" : "Nova solicitação de aprovação"}</h2><p className="nx-muted nx-small" style={{ margin: "4px 0 0" }}>{editingWhatsAppApproval ? "Revise a mensagem. O destinatário permanece protegido e não pode ser alterado aqui." : editingApproval ? "Ajuste o plano antes de aprovar ou rejeitar." : "Registre a decisão antes de executar uma ação sensível."}</p></div>
              <button type="button" className="nxw-icon-btn is-sm is-plain" onClick={closeApprovalDialog} aria-label="Fechar"><X size={18} /></button>
            </header>
            <div className="nxo-modal-b">
              <label className="nxw-label">{editingWhatsAppApproval ? "Destinatário protegido" : "O que precisa ser aprovado?"}<input value={approvalTitle} onChange={(event) => { if (!editingWhatsAppApproval) setApprovalTitle(event.target.value); }} readOnly={editingWhatsAppApproval} aria-readonly={editingWhatsAppApproval} maxLength={180} className="nxw-field" style={editingWhatsAppApproval ? { cursor: "not-allowed", opacity: 0.7 } : undefined} placeholder="Ex.: autorizar envio para toda a base" /></label>
              <label className="nxw-label">{editingWhatsAppApproval ? "Mensagem que será enviada" : "Contexto"}<textarea value={approvalDescription} onChange={(event) => setApprovalDescription(event.target.value)} maxLength={1200} rows={4} className="nxw-field" placeholder={editingWhatsAppApproval ? "Revise o texto exato antes de aprovar." : "Explique o impacto e o motivo da solicitação."} /></label>
            </div>
            <footer className="nxo-modal-f">
              <button type="button" className="nx-btn" onClick={closeApprovalDialog}>Cancelar</button>
              <button type="button" className="nx-btn is-primary" disabled={savingApproval} onClick={() => void saveApproval()}>{savingApproval ? <LoaderCircle className="nxw-spin" size={16} /> : <ClipboardCheck size={16} />} {editingApproval ? "Salvar alterações" : "Solicitar aprovação"}</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function approvalTone(approval: Approval): { icon: LucideIcon; className: string } {
  const value = `${approval.source || ""} ${approval.action || ""}`.toLocaleLowerCase("pt-BR");
  if (/whatsapp|chat/.test(value)) return { icon: MessageCircle, className: "is-green" };
  if (/email|gmail/.test(value)) return { icon: Mail, className: "is-red" };
  if (/financ|lancamento|boleto|gasto/.test(value)) return { icon: Wallet, className: "is-cyan" };
  if (/calendar|agenda/.test(value)) return { icon: CalendarDays, className: "" };
  if (/task|tarefa/.test(value)) return { icon: SquareCheck, className: "is-amber" };
  return { icon: ClipboardCheck, className: "" };
}

function MetricCard({ label, value }: { label: string; value?: number }) {
  return <article className="nx-card nx-kpi"><div className="nx-kpi-l">{label}</div><div className="nx-kpi-v">{value ?? "—"}</div></article>;
}

function SectionHeader({ title, description, action }: { title: string; description: string; action?: string }) {
  return <header className="nx-card-h nxo-card-h"><div className="nx-grow"><h2>{title}</h2><p>{description}</p></div>{action && <span className="nx-badge is-amber">{action}</span>}</header>;
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={active ? "is-active" : ""}>{children}</button>;
}

function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return <div className="nxw-empty"><span className="nxw-icon is-green"><Icon size={18} /></span><strong>{title}</strong><span>{description}</span></div>;
}
