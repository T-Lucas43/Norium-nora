import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, BrainCircuit, Check, Circle, CircleCheck, Clock3, Eye, ListChecks, Loader2, Paperclip, Pause, Play, Plus, RefreshCcw, Send, ShieldCheck, Trash2, X } from "lucide-react";
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

const attentionStates = new Set(["awaiting_approval", "needs_information", "unknown", "budget_paused"]);
const compactNumber = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

function stateTone(status: string) {
  if (status === "completed") return "is-green";
  if (status === "running") return "is-blue";
  if (["awaiting_approval", "needs_information", "unknown"].includes(status)) return "is-amber";
  if (["budget_paused", "blocked", "failed"].includes(status)) return "is-red";
  return "";
}

function stepsDone(job: BrainJob) {
  return job.steps.filter((step) => step.status === "succeeded").length;
}

function StepIcon({ status }: { status: string }) {
  if (status === "succeeded") return <CircleCheck size={16} className="is-done" />;
  if (["preparing", "executing"].includes(status)) return <Loader2 size={16} className="animate-spin is-running" />;
  if (["failed", "unknown"].includes(status)) return <AlertTriangle size={16} className="is-warning" />;
  return <Circle size={16} />;
}

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

export default function NoraBrainJobs({ onClose, onOpenLibrary }: { onClose: () => void; onOpenLibrary?: () => void }) {
  const [jobs, setJobs] = useState<BrainJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const composeRef = useRef<HTMLTextAreaElement>(null);
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

  // Mestre-detalhe do layout aprovado: sem escolha explícita, abre primeiro o trabalho que pede atenção.
  const selected = jobs.find((job) => job.id === selectedId) ?? jobs.find((job) => attentionStates.has(job.status)) ?? jobs[0];

  function renderJob(job: BrainJob) {
    const review = job.steps.find((step) => step.status === "awaiting_approval" && step.approval && step.prepared);
    const signals = jobSignals(job);
    const done = stepsDone(job);
    const progress = job.steps.length ? Math.round((done / job.steps.length) * 100) : job.status === "completed" ? 100 : 0;
    return <article key={job.id} className={`nx-card nora-brain-job state-${job.status}`} aria-label={`Detalhes do trabalho: ${job.message || "Conteúdo temporário expirado"}`}>
      <div className="nora-brain-job-title"><span className={`nx-badge ${stateTone(job.status)} nora-brain-state`}>{activeStates.has(job.status) ? <Loader2 className="animate-spin" size={12} /> : job.status === "completed" ? <Check size={12} /> : job.status === "unknown" ? <AlertTriangle size={12} /> : <Clock3 size={12} />} {stateLabels[job.status] || job.status}</span><small>{profileLabels[job.profile]}</small></div>
      <h3>{job.message || "Conteúdo temporário expirado"}</h3>
      <div className="nx-bar nora-brain-progress" role="progressbar" aria-label="Etapas concluídas" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
      {job.result && <p className="nora-brain-result">{job.result}</p>}
      {job.steps.length > 0 && <section className="nora-brain-trace" aria-label="Plano e trilha de execução">
        <p className="nora-brain-trace-title"><ListChecks size={14} /> Plano e trilha de execução <span>{job.steps.length}</span></p>
        <ol>{job.steps.map((step) => {
          const evidenceKeys = Object.keys(step.result?.evidence || {});
          return <li key={step.id} className={`state-${step.status}`}><StepIcon status={step.status} /><span><strong>{step.tool.replaceAll("_", " ")}</strong><small>{evidenceKeys.length ? `Evidências: ${evidenceKeys.join(", ")}` : "Nenhuma evidência registrada nesta etapa"}</small></span><em className={`nx-badge ${step.status === "awaiting_approval" ? "is-amber" : step.status === "succeeded" ? "is-green" : ["failed", "unknown"].includes(step.status) ? "is-red" : ""}`}>{stepLabels[step.status] || step.status}</em></li>;
        })}</ol>
      </section>}
      <div className="nora-brain-signals" aria-label="Sinais de qualidade do trabalho">
        <span><Activity size={13} /> {job.steps.length} etapa(s)</span>
        <span><Eye size={13} /> {signals.withEvidence}/{job.steps.length || 0} com evidência</span>
        <span><ShieldCheck size={13} /> {signals.reviewed} revisão(ões)</span>
        <span><Clock3 size={13} /> {Math.round(job.budget.seconds)}s contabilizados</span>
      </div>
      {review && <section className="nora-brain-review" aria-label="Operação aguardando revisão">
        <strong><ShieldCheck size={16} /> Revise a operação exata</strong>
        <dl>{reviewFields(review).map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
        <p>A revisão vale somente para esta versão e expira em {new Date((review.approval?.expiresAt || 0) * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}.</p>
        <div className="nora-brain-review-actions">
          <Button variant="ghost" disabled={acting === review.id} onClick={() => void mutate(review.id, `/api/nora/brain/jobs/${job.id}/approval/reject`, { approvalId: review.approval?.id, digest: review.approval?.digest })}><X size={15} /> Não aprovar</Button>
          <Button variant="primary" disabled={acting === review.id} onClick={() => void mutate(review.id, `/api/nora/brain/jobs/${job.id}/approval`, { approvalId: review.approval?.id, digest: review.approval?.digest })}>{acting === review.id ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />} Aprovar esta versão</Button>
        </div>
      </section>}
      {job.status === "needs_information" && <div className="nora-brain-information"><textarea aria-label="Informação para a Nora" value={information[job.id] || ""} onChange={(event) => setInformation((current) => ({ ...current, [job.id]: event.target.value }))} placeholder="Responda à pendência acima..." /><Button variant="primary" disabled={!information[job.id]?.trim() || acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/information`, { message: information[job.id].trim() })}><Play size={15} /> Retomar</Button></div>}
      {job.status === "budget_paused" && job.profile !== "complex" && <div className="nora-brain-budget-action"><p>O consumo anterior será mantido. A ampliação autoriza apenas o novo teto deste mesmo trabalho.</p><Button variant="secondary" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/budget`, { profile: job.profile === "routine" ? "document" : "complex", acknowledged: true })}><Play size={15} /> {job.profile === "routine" ? "Ampliar para documento" : "Autorizar perfil complexo"}</Button></div>}
      <footer><span>{job.budget.calls} chamada(s) · {job.budget.tokens.toLocaleString("pt-BR")} tokens · {job.budget.tools} ferramenta(s)</span><span>{job.status === "unknown" && <Button variant="ghost" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/reconcile`)}><RefreshCcw size={14} /> Verificar resultado</Button>}{!["completed", "cancelled", "failed"].includes(job.status) && <Button variant="ghost" className="nora-brain-cancel" disabled={acting === job.id} onClick={() => void mutate(job.id, `/api/nora/brain/jobs/${job.id}/cancel`)}><Pause size={14} /> Cancelar futuras etapas</Button>}</span></footer>
    </article>;
  }

  return <div className="nora-brain-shell" role="dialog" aria-modal="true" aria-label="Trabalhos da Nora">
    <header className="nx-ph nora-brain-header">
      <div><h1>Trabalhos da Nora</h1><p>Tarefas longas que a Nora executa em segundo plano, com revisão e evidências</p></div>
      <div className="nx-ph-actions">
        <div className="nx-seg" role="group" aria-label="Seções da Nora"><button type="button" onClick={onClose}>Conversas</button><button type="button" className="is-active" aria-current="page">Trabalhos</button>{onOpenLibrary && <button type="button" onClick={onOpenLibrary}>Biblioteca</button>}</div>
        <button type="button" className="nx-btn is-primary" onClick={() => composeRef.current?.focus()}><Plus size={16} /> Novo trabalho</button>
        <Button variant="ghost" iconOnly onClick={onClose} aria-label="Fechar trabalhos"><X size={18} /></Button>
      </div>
    </header>
    <section className="nora-brain-controls" aria-label="Controles de engenharia dos agentes">
      <span><ListChecks size={15} /><strong>Plano por etapas</strong><small>Uma ferramenta por decisão</small></span>
      <span><BrainCircuit size={15} /><strong>Contexto limitado</strong><small>Orçamento por perfil</small></span>
      <span><ShieldCheck size={15} /><strong>Supervisão humana</strong><small>Ações sensíveis revisadas</small></span>
      <span><Eye size={15} /><strong>Evidências</strong><small>Resultado confirmado ou incerto</small></span>
    </section>
    <section className="nx-card nora-brain-compose" aria-label="Novo trabalho">
      <textarea ref={composeRef} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} placeholder="Descreva o resultado que você precisa..." />
      {attachments.length > 0 && <div className="nora-brain-attachments">{attachments.map((file) => <span key={file.id}><Paperclip size={12} /> {file.name}<button type="button" aria-label={`Remover ${file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}><Trash2 size={12} /></button></span>)}</div>}
      <div>
        <label>Perfil<select value={profile} onChange={(event) => { setProfile(event.target.value as BrainJob["profile"]); setComplexApproved(false); }}><option value="routine">Rotina</option><option value="document">Documento profissional</option><option value="complex">Complexo</option></select></label>
        {profile === "complex" && <label className="nora-brain-budget"><input type="checkbox" checked={complexApproved} onChange={(event) => setComplexApproved(event.target.checked)} /> Autorizo o orçamento ampliado deste trabalho</label>}
        <label className="nora-brain-file"><Paperclip size={15} /> {uploading ? "Enviando..." : "Anexar"}<input type="file" multiple disabled={uploading || attachments.length >= 8} accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.json" onChange={(event) => void upload(event.target.files)} /></label>
        <Button variant="primary" onClick={() => void submit()} disabled={!message.trim() || acting === "submit" || uploading || (profile === "complex" && !complexApproved)}>{acting === "submit" ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />} Iniciar</Button>
      </div>
    </section>
    {error && <p className="nora-brain-error" role="alert"><AlertTriangle size={15} /> {error}</p>}
    {loading ? <p className="nx-card nora-brain-empty"><Loader2 className="animate-spin" /> Carregando trabalhos...</p> : jobs.length === 0 ? <p className="nx-card nora-brain-empty"><BrainCircuit /> Nenhum trabalho persistente iniciado.</p> : <div className="nora-brain-grid">
      <div className="nx-card nora-brain-list">
        <table className="nx-table">
          <thead><tr><th>Trabalho</th><th>Perfil</th><th>Status</th><th>Etapas</th><th className="is-right">Tokens</th></tr></thead>
          <tbody>{jobs.map((job) => {
            const isSelected = selected?.id === job.id;
            return <tr key={job.id} className={isSelected ? "is-selected" : ""} onClick={() => setSelectedId(job.id)}>
              <td><button type="button" className="nora-brain-row-open" aria-pressed={isSelected} onClick={(event) => { event.stopPropagation(); setSelectedId(job.id); }}>{job.message || "Conteúdo temporário expirado"}</button></td>
              <td className="nx-muted">{profileLabels[job.profile]}</td>
              <td><span className={`nx-badge ${stateTone(job.status)}`}>{stateLabels[job.status] || job.status}</span></td>
              <td className="nx-muted">{stepsDone(job)}/{job.steps.length}</td>
              <td className="nx-muted is-right" title={`${job.budget.tokens.toLocaleString("pt-BR")} tokens`}>{job.budget.tokens ? compactNumber.format(job.budget.tokens) : "—"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {selected && renderJob(selected)}
    </div>}
  </div>;
}
