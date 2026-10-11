import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, BrainCircuit, Check, Clock3, Eye, ListChecks, Loader2, Paperclip, Pause, Play, RefreshCcw, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { ApiError, apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import "./noraBrainJobs.css";

type BrainStep = {
  id: string;
  tool: string;
  status: string;
  prepared?: { digest: string; policy: string; prepared: Record<string, unknown> };
  approval?: { id: string; digest: string; expiresAt: number; approvedAt?: number };
  result?: { data?: Record<string, unknown>; evidence?: Record<string, unknown> };
};

type BrainJob = {
  id: string;
  message: string;
  profile: "routine" | "document" | "complex";
  status: string;
  result: string;
  updatedAt: number;
  steps: BrainStep[];
  budget: { tokens: number; calls: number; tools: number; seconds: number };
};

const activeStates = new Set(["queued", "running"]);
const stateLabels: Record<string, string> = {
  queued: "Na fila", running: "Em execução", awaiting_approval: "Aguardando sua revisão",
  needs_information: "Aguardando informação", unknown: "Resultado a verificar",
  budget_paused: "Pausado por limite", blocked: "Bloqueado", completed: "Concluído",
  cancelled: "Cancelado", failed: "Falhou",
};
const profileLabels = { routine: "Rotina", document: "Documento profissional", complex: "Complexo" };
const stepLabels: Record<string, string> = {
  planned: "Planejada", preparing: "Preparando", awaiting_approval: "Em revisão",
  executing: "Executando", succeeded: "Confirmada", rejected: "Não aplicada",
  unknown: "A verificar", failed: "Falhou", cancelled: "Cancelada",
};

function jobSignals(job: BrainJob) {
  const withEvidence = job.steps.filter((step) => Object.keys(step.result?.evidence || {}).length > 0).length;
  const reviewed = job.steps.filter((step) => step.approval?.approvedAt || step.status === "awaiting_approval").length;
  return { withEvidence, reviewed };
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Falha ao ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function asText(value: unknown) {
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") : "Nenhum";
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return String(value ?? "—");
}

function reviewFields(step: BrainStep) {
  const prepared = step.prepared?.prepared || {};
  const preferred: Record<string, string[]> = {
    email_send: ["sender", "to", "cc", "bcc", "subject", "body", "attachments"],
    whatsapp_send: ["sender", "recipient", "text", "attachments"],
    calendar_create: ["calendar", "title", "start", "end", "timezone", "participants", "location"],
    tasks_change: ["id", "title", "action", "changes"],
  };
  const labels: Record<string, string> = {
    sender: "Remetente", to: "Para", cc: "Cc", bcc: "Cco", subject: "Assunto", body: "Mensagem",
    attachments: "Anexos", recipient: "Destinatário", text: "Texto", calendar: "Agenda", title: "Título",
    start: "Início", end: "Fim", timezone: "Fuso", participants: "Participantes", location: "Local",
    id: "Alvo", action: "Ação", changes: "Alterações",
  };
  const keys = preferred[step.tool] || Object.keys(prepared).filter((key) => !["effects", "version"].includes(key));
  return keys.filter((key) => key in prepared).map((key) => ({ label: labels[key] || key, value: asText(prepared[key]) }));
}

function errorText(error: unknown) {
  if (error instanceof ApiError) {
    const payload = error.payload as { detail?: { code?: string } } | null;
    return payload?.detail?.code ? `Não foi possível concluir: ${payload.detail.code}.` : error.message;
  }
  return error instanceof Error ? error.message : "Não foi possível concluir a operação.";
}

export default function NoraBrainJobs({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<BrainJob[]>([]);
  const [message, setMessage] = useState("");
  const [profile, setProfile] = useState<BrainJob["profile"]>("routine");
  const [complexApproved, setComplexApproved] = useState(false);
  const [information, setInformation] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; size: number }>>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await apiRequest<{ items: BrainJob[] }>("/api/nora/brain/jobs");
      setJobs(response.items);
      setError("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasRunning = useMemo(() => jobs.some((job) => activeStates.has(job.status)), [jobs]);
  const hasReview = useMemo(() => jobs.some((job) => job.status === "awaiting_approval"), [jobs]);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [hasRunning, refresh]);
  useEffect(() => {
    if (!hasReview || hasRunning) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [hasReview, hasRunning, refresh]);

  async function submit() {
    const value = message.trim();
    if (!value || (profile === "complex" && !complexApproved)) return;
    const requestId = crypto.randomUUID();
    setActing("submit");
    try {
      const response = await apiRequest<{ job: BrainJob }>("/api/nora/brain/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ requestId, message: value, category: profile, complexBudgetApproved: profile === "complex" && complexApproved, attachmentIds: attachments.map((file) => file.id) }),
      });
      setJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
      setMessage("");
      setAttachments([]);
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setActing(""); }
  }

  async function upload(selected: FileList | null) {
    const files = Array.from(selected || []).slice(0, Math.max(0, 8 - attachments.length));
    if (!files.length) return;
    setUploading(true);
    try {
      const next: Array<{ id: string; name: string; size: number }> = [];
      for (const file of files) {
        if (file.size > 24 * 1024 * 1024) throw new Error(`${file.name} ultrapassa o limite de 24 MB.`);
        const response = await apiRequest<{ file: { id: string; name: string; size: number } }>("/api/nora/files", {
          method: "POST", timeoutMs: 90_000,
          body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", dataBase64: await fileBase64(file) }),
        });
        next.push(response.file);
      }
      setAttachments((current) => [...current, ...next].slice(0, 8));
    } catch (reason) { setError(errorText(reason)); }
    finally { setUploading(false); }
  }

  async function mutate(key: string, path: string, body?: unknown) {
    setActing(key);
    try {
      const response = await apiRequest<{ job: BrainJob }>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      setJobs((current) => current.map((job) => job.id === response.job.id ? response.job : job));
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setActing(""); }
  }

  return <div className="nora-brain-shell" role="dialog" aria-modal="true" aria-label="Trabalhos da Nora">
    <header className="nora-brain-header">
      <span><BrainCircuit size={20} /><span><strong>Trabalhos da Nora</strong><small>Execução persistente, revisão e evidências</small></span></span>
      <Button variant="ghost" iconOnly onClick={onClose} aria-label="Fechar trabalhos"><X size={18} /></Button>
    </header>
    <section className="nora-brain-controls" aria-label="Controles de engenharia dos agentes">
      <span><ListChecks size={15} /><strong>Plano por etapas</strong><small>Uma ferramenta por decisão</small></span>
      <span><BrainCircuit size={15} /><strong>Contexto limitado</strong><small>Orçamento por perfil</small></span>
      <span><ShieldCheck size={15} /><strong>Supervisão humana</strong><small>Ações sensíveis revisadas</small></span>
      <span><Eye size={15} /><strong>Evidências</strong><small>Resultado confirmado ou incerto</small></span>
    </section>
    <section className="nora-brain-compose" aria-label="Novo trabalho">
      <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} placeholder="Descreva o resultado que você precisa..." />
      {attachments.length > 0 && <div className="nora-brain-attachments">{attachments.map((file) => <span key={file.id}><Paperclip size={12} /> {file.name}<button type="button" aria-label={`Remover ${file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}><Trash2 size={12} /></button></span>)}</div>}
      <div>
        <label>Perfil<select value={profile} onChange={(event) => { setProfile(event.target.value as BrainJob["profile"]); setComplexApproved(false); }}><option value="routine">Rotina</option><option value="document">Documento profissional</option><option value="complex">Complexo</option></select></label>
        {profile === "complex" && <label className="nora-brain-budget"><input type="checkbox" checked={complexApproved} onChange={(event) => setComplexApproved(event.target.checked)} /> Autorizo o orçamento ampliado deste trabalho</label>}
        <label className="nora-brain-file"><Paperclip size={15} /> {uploading ? "Enviando..." : "Anexar"}<input type="file" multiple disabled={uploading || attachments.length >= 8} accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.json" onChange={(event) => void upload(event.target.files)} /></label>
        <Button variant="primary" onClick={() => void submit()} disabled={!message.trim() || acting === "submit" || uploading || (profile === "complex" && !complexApproved)}>{acting === "submit" ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />} Iniciar</Button>
      </div>
    </section>
    {error && <p className="nora-brain-error" role="alert"><AlertTriangle size={15} /> {error}</p>}
    <div className="nora-brain-list">
      {loading ? <p className="nora-brain-empty"><Loader2 className="animate-spin" /> Carregando trabalhos...</p> : jobs.length === 0 ? <p className="nora-brain-empty"><BrainCircuit /> Nenhum trabalho persistente iniciado.</p> : jobs.map((job) => {
        const review = job.steps.find((step) => step.status === "awaiting_approval" && step.approval && step.prepared);
        const signals = jobSignals(job);
        return <article key={job.id} className={`nora-brain-job state-${job.status}`}>
          <div className="nora-brain-job-title"><span className="nora-brain-state">{activeStates.has(job.status) ? <Loader2 className="animate-spin" size={14} /> : job.status === "completed" ? <Check size={14} /> : job.status === "unknown" ? <AlertTriangle size={14} /> : <Clock3 size={14} />} {stateLabels[job.status] || job.status}</span><small>{profileLabels[job.profile]}</small></div>
          <h3>{job.message || "Conteúdo temporário expirado"}</h3>
          {job.result && <p className="nora-brain-result">{job.result}</p>}
          <div className="nora-brain-signals" aria-label="Sinais de qualidade do trabalho">
            <span><Activity size={13} /> {job.steps.length} etapa(s)</span>
            <span><Eye size={13} /> {signals.withEvidence}/{job.steps.length || 0} com evidência</span>
            <span><ShieldCheck size={13} /> {signals.reviewed} revisão(ões)</span>
            <span><Clock3 size={13} /> {Math.round(job.budget.seconds)}s contabilizados</span>
          </div>
          {job.steps.length > 0 && <details className="nora-brain-trace">
            <summary><ListChecks size={14} /> Plano e trilha de execução <span>{job.steps.length}</span></summary>
            <ol>{job.steps.map((step, index) => {
              const evidenceKeys = Object.keys(step.result?.evidence || {});
              return <li key={step.id} className={`state-${step.status}`}><i>{index + 1}</i><span><strong>{step.tool.replaceAll("_", " ")}</strong><small>{evidenceKeys.length ? `Evidências: ${evidenceKeys.join(", ")}` : "Nenhuma evidência registrada nesta etapa"}</small></span><em>{stepLabels[step.status] || step.status}</em></li>;
            })}</ol>
          </details>}
          {review && <section className="nora-brain-review" aria-label="Operação aguardando revisão">
            <strong><ShieldCheck size={16} /> Revise a operação exata</strong>
            <dl>{reviewFields(review).map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
            <p>A revisão vale somente para esta versão e expira em {new Date((review.approval?.expiresAt || 0) * 1000).toLocaleString("pt-BR")}.</p>
            <div className="nora-brain-review-actions">
              <Button variant="primary" disabled={acting === review.id} onClick={() => void mutate(review.id, `/api/nora/brain/jobs/${job.id}/approval`, { approvalId: review.approval?.id, digest: review.approval?.digest })}>{acting === review.id ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />} Aprovar esta versão</Button>
              <Button variant="ghost" disabled={acting === review.id} onClick={() => void mutate(review.id, `/api/nora/brain/jobs/${job.id}/approval/reject`, { approvalId: review.approval?.id, digest: review.approval?.digest })}><X size={15} /> Não aprovar</Button>
            </div>
          </section>}
          {job.status === "needs_information" && <div className="nora-brain-information"><textarea aria-label="Informação para a Nora" value={information[job.id] || ""} onChange={(event) => setInformation((current) => ({ ...current, [job.id]: event.target.value }))} placeholder="Responda à pendência acima..." /><Button variant="primary" disabled={!information[job.id]?.trim() || acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/information`, { message: information[job.id].trim() })}><Play size={15} /> Retomar</Button></div>}
          {job.status === "budget_paused" && job.profile !== "complex" && <div className="nora-brain-budget-action"><p>O consumo anterior será mantido. A ampliação autoriza apenas o novo teto deste mesmo trabalho.</p><Button variant="secondary" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/budget`, { profile: job.profile === "routine" ? "document" : "complex", acknowledged: true })}><Play size={15} /> {job.profile === "routine" ? "Ampliar para documento" : "Autorizar perfil complexo"}</Button></div>}
          <footer><span>{job.budget.calls} chamada(s) · {job.budget.tokens.toLocaleString("pt-BR")} tokens · {job.budget.tools} ferramenta(s)</span><span>{job.status === "unknown" && <Button variant="ghost" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/reconcile`)}><RefreshCcw size={14} /> Verificar resultado</Button>}{!["completed", "cancelled", "failed"].includes(job.status) && <Button variant="ghost" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/cancel`)}><Pause size={14} /> Cancelar futuras etapas</Button>}</span></footer>
        </article>;
      })}
    </div>
  </div>;
}
