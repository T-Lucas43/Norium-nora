import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle, Bot, Camera, CheckCircle2, Download, ExternalLink, FileInput,
  FileSearch, FileUp, Globe2, KeyRound, ListChecks, Loader2, MousePointerClick,
  Pause, Play, Plus, RefreshCw, Save, ShieldCheck, Square, Trash2, XCircle,
} from "lucide-react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";

type GenericItem = Record<string, unknown> & { id: string; name?: string; status?: string };
type ActionType = "navigate" | "search" | "click" | "fill" | "credential_fill" | "select" | "press" | "wait" | "extract" | "screenshot" | "download" | "upload";
type BrowserAction = {
  id?: string;
  type: ActionType;
  description: string;
  target: string;
  value: string;
  status?: string;
  riskClass?: "read" | "external" | "sensitive";
  requiresApproval?: boolean;
  credentialId?: string | null;
  credentialField?: "username" | "password" | "secret" | null;
  artifactId?: string | null;
};
type BrowserArtifact = { id: string; kind: "screenshot" | "download" | "upload"; name: string; mimeType: string; size: number; url: string; createdAt: string };
type BrowserProfile = GenericItem & {
  description?: string; allowedDomains?: string[]; credentialIds?: string[];
  allowDownloads?: boolean; allowUploads?: boolean; allowForms?: boolean;
  retainSession?: boolean; maxActions?: number; maxDurationSeconds?: number;
};
type BrowserCredential = GenericItem & { label?: string; integration?: string; maskedSecret?: string; lastUsedAt?: string };
type BrowserRun = GenericItem & {
  objective: string; startUrl: string; host: string; risk: "baixo" | "medio" | "alto";
  riskReason: string; progress: number; executionMode?: "assisted" | "automatic";
  planner?: { mode?: string; detail?: string }; plan?: BrowserAction[]; artifacts?: BrowserArtifact[];
  pendingApproval?: { actionId: string; type: string; target: string; description: string; riskClass: string } | null;
  result?: { title?: string; summary?: string; url?: string; readOnly?: boolean; actionsPerformed?: number; structuredData?: { links?: Array<{ text: string; url: string }>; tables?: string[][][] } } | null;
  error?: string | null; timeline?: Array<{ at: string; event: string; message: string }>; createdAt: string;
};
type BrowserOverview = {
  profiles: BrowserProfile[]; runs: BrowserRun[]; credentials: BrowserCredential[];
  runtime?: { engine?: string; realBrowser?: boolean; maxConcurrency?: number };
};

const activeStates = new Set(["queued", "running", "cancelling"]);
const actionTypes: Array<{ value: ActionType; label: string }> = [
  { value: "navigate", label: "Abrir URL" }, { value: "search", label: "Pesquisar" },
  { value: "click", label: "Clicar" }, { value: "fill", label: "Preencher" },
  { value: "credential_fill", label: "Preencher credencial" }, { value: "select", label: "Selecionar opcao" },
  { value: "press", label: "Pressionar tecla" }, { value: "wait", label: "Aguardar" },
  { value: "extract", label: "Extrair dados" }, { value: "screenshot", label: "Capturar tela" },
  { value: "download", label: "Baixar arquivo" }, { value: "upload", label: "Enviar arquivo" },
];

function displayDate(value: unknown) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function statusLabel(value: string) {
  return ({ planned: "Planejado", queued: "Na fila", running: "Executando", paused: "Pausado", awaiting_approval: "Aguardando aprovacao", completed: "Concluido", failed: "Falhou", cancelled: "Cancelado", cancelling: "Cancelando", intervention_required: "Intervencao necessaria", pending: "Pendente", rejected: "Rejeitado" } as Record<string, string>)[value] || value;
}

function Status({ value }: { value: string }) {
  const style = ["completed"].includes(value) ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : ["failed", "cancelled", "rejected", "intervention_required"].includes(value) ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : ["awaiting_approval", "paused"].includes(value) ? "border-amber-400/30 bg-amber-400/10 text-amber-100" : "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${style}`}>{statusLabel(value)}</span>;
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function blankAction(type: ActionType = "click"): BrowserAction {
  return { type, description: actionTypes.find((item) => item.value === type)?.label || "Nova etapa", target: "", value: "", credentialId: null, credentialField: null, artifactId: null };
}

export default function BrowserAgentDashboard({ onOpenNora }: { onOpenNora: (prompt?: string) => void }) {
  const [data, setData] = useState<BrowserOverview>({ profiles: [], runs: [], credentials: [] });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [objective, setObjective] = useState("Acesse a pagina, realize a tarefa solicitada e registre o resultado com evidencias");
  const [startUrl, setStartUrl] = useState("");
  const [profileId, setProfileId] = useState("");
  const [executionMode, setExecutionMode] = useState<"assisted" | "automatic">("assisted");
  const [expectedResult, setExpectedResult] = useState("structured");
  const [maxSteps, setMaxSteps] = useState(20);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [showProfile, setShowProfile] = useState(false);
  const [showCredential, setShowCredential] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", description: "", domains: "", allowDownloads: false, allowUploads: false, allowForms: false, retainSession: false, maxActions: 20, maxDurationSeconds: 300, credentialIds: [] as string[] });
  const [credentialForm, setCredentialForm] = useState({ label: "", domain: "", username: "", password: "" });
  const [editingPlan, setEditingPlan] = useState(false);
  const [draftActions, setDraftActions] = useState<BrowserAction[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await apiRequest<BrowserOverview>("/api/navegador");
      setData(response);
      setSelectedRunId((current) => current && response.runs.some((run) => run.id === current) ? current : response.runs[0]?.id || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nao foi possivel carregar o navegador.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data.runs.some((run) => activeStates.has(run.status || ""))) return undefined;
    const timer = window.setInterval(() => void load(), 1800);
    return () => window.clearInterval(timer);
  }, [data.runs, load]);

  const selected = data.runs.find((run) => run.id === selectedRunId) || data.runs[0] || null;
  const screenshots = useMemo(() => (selected?.artifacts || []).filter((item) => item.kind === "screenshot"), [selected?.artifacts]);
  const latestScreenshot = screenshots[screenshots.length - 1];
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setPreviewUrl("");
    if (latestScreenshot) {
      apiBlobRequest(latestScreenshot.url, { headers: { Accept: latestScreenshot.mimeType } }).then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob); setPreviewUrl(objectUrl);
      }).catch(() => undefined);
    }
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [latestScreenshot]);

  async function createPlan(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await apiRequest<{ item: BrowserRun }>("/api/navegador/runs/plan", { method: "POST", body: JSON.stringify({ objective, startUrl, profileId: profileId || null, executionMode, expectedResult, maxPages: 10, maxSteps, timeoutSeconds, actions: [], useAiPlanner: true }) });
      setSelectedRunId(response.item.id); setMessage(`Plano ${response.item.planner?.mode === "ai" ? "criado pela IA" : "criado e pronto para revisao"}. Nenhuma acao foi executada.`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel planejar a tarefa."); }
    finally { setBusy(false); }
  }

  async function createProfile(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await apiRequest<{ item: BrowserProfile }>("/api/navegador/profiles", { method: "POST", body: JSON.stringify({ ...profileForm, allowedDomains: profileForm.domains.split(",").map((item) => item.trim()).filter(Boolean), blockedDomains: [], domains: undefined }) });
      setProfileId(response.item.id); setProfileForm({ name: "", description: "", domains: "", allowDownloads: false, allowUploads: false, allowForms: false, retainSession: false, maxActions: 20, maxDurationSeconds: 300, credentialIds: [] }); setShowProfile(false); setMessage("Perfil isolado criado."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel criar o perfil."); }
    finally { setBusy(false); }
  }

  async function createCredential(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiRequest("/api/navegador/credentials", { method: "POST", body: JSON.stringify(credentialForm) });
      setCredentialForm({ label: "", domain: "", username: "", password: "" }); setShowCredential(false); setMessage("Credencial criptografada e vinculavel a perfis."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel salvar a credencial."); }
    finally { setBusy(false); }
  }

  async function executeControl(action: "execute" | "pause" | "resume" | "cancel") {
    if (!selected) return; setBusy(true); setError("");
    try {
      await apiRequest(`/api/navegador/runs/${selected.id}/${action}`, { method: "POST" });
      setMessage(action === "execute" ? "Chromium real adicionado a fila." : "Controle aplicado a sessao."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel controlar a execucao."); }
    finally { setBusy(false); }
  }

  async function decide(decision: "approve" | "reject") {
    if (!selected?.pendingApproval) return; setBusy(true); setError("");
    try {
      await apiRequest(`/api/navegador/runs/${selected.id}/approval`, { method: "POST", body: JSON.stringify({ decision, actionId: selected.pendingApproval.actionId, note: decision === "approve" ? "Acao revisada e aprovada na tela." : "Acao rejeitada pelo operador." }) });
      setMessage(decision === "approve" ? "Acao liberada. O navegador continuara da mesma sessao." : "Acao bloqueada e execucao cancelada."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel registrar a decisao."); }
    finally { setBusy(false); }
  }

  function beginPlanEdit() { if (!selected) return; setDraftActions((selected.plan || []).map((item) => ({ ...item }))); setEditingPlan(true); }
  function updateAction(index: number, patch: Partial<BrowserAction>) { setDraftActions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  async function savePlan() {
    if (!selected || !draftActions.length) return; setBusy(true); setError("");
    try {
      const actions = draftActions.map((item) => ({
        type: item.type,
        description: item.description,
        target: item.target,
        value: item.value,
        credentialId: item.credentialId || null,
        credentialField: item.credentialField || null,
        artifactId: item.artifactId || null,
      }));
      await apiRequest(`/api/navegador/runs/${selected.id}/plan`, { method: "PUT", body: JSON.stringify({ actions }) });
      setEditingPlan(false); setMessage("Plano atualizado e riscos recalculados pelo servidor."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel salvar o plano."); }
    finally { setBusy(false); }
  }

  async function uploadForRun(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !selected) return; setBusy(true); setError("");
    try {
      const response = await apiRequest<{ item: BrowserArtifact }>(`/api/navegador/runs/${selected.id}/uploads`, { method: "POST", body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", dataUrl: await fileDataUrl(file) }), timeoutMs: 60_000 });
      setDraftActions((current) => [...(editingPlan ? current : (selected.plan || [])), { ...blankAction("upload"), description: `Enviar ${file.name}`, target: "css=input[type=file]", artifactId: response.item.id }]);
      setEditingPlan(true); setMessage("Arquivo anexado. Revise o alvo do campo e salve o plano."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nao foi possivel anexar o arquivo."); }
    finally { setBusy(false); }
  }

  async function downloadArtifact(artifact: BrowserArtifact) {
    const blob = await apiBlobRequest(artifact.url, { headers: { Accept: artifact.mimeType } });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.name; anchor.click(); URL.revokeObjectURL(url);
  }

  async function deleteProfile(item: BrowserProfile) {
    if (!await showConfirm({ title: "Excluir perfil?", description: `O perfil ${item.name} sera removido. Historicos permanecem.`, confirmLabel: "Excluir", tone: "danger" })) return;
    await apiRequest(`/api/navegador/profiles/${item.id}`, { method: "DELETE" }); await load();
  }

  return (
    <main className="mx-auto w-full max-w-[1740px] space-y-5 p-4 text-[var(--text)] sm:p-6">
      <header className="overflow-hidden rounded-3xl border border-cyan-400/20 bg-[radial-gradient(circle_at_top_left,rgba(6,182,212,.22),transparent_38%),linear-gradient(135deg,rgba(15,23,42,.98),rgba(7,30,62,.96))] p-5 shadow-2xl sm:p-7"><div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between"><div className="flex gap-4"><span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-400 text-white shadow-lg"><MousePointerClick size={26} /></span><div><span className="inline-flex rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-xs font-black uppercase tracking-[.13em] text-emerald-100">Chromium real</span><h1 className="mt-3 text-2xl font-black text-white sm:text-4xl">Agente Navegador</h1><p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-300">Navega, pesquisa, clica, preenche, seleciona, envia e baixa arquivos com plano supervisionado, capturas e confirmacao por etapa.</p></div></div><div className="flex flex-wrap gap-2"><Button onClick={() => setShowCredential((value) => !value)}><KeyRound size={16} /> Credencial</Button><Button onClick={() => setShowProfile((value) => !value)}><ShieldCheck size={16} /> Perfil</Button><Button variant="primary" onClick={() => onOpenNora("Crie uma tarefa real para o Agente Navegador: ")}><Bot size={16} /> Pedir a Nora</Button></div></div></header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={Globe2} label="Execucoes" value={data.runs.length} detail="Historico isolado" /><Metric icon={Play} label="Em andamento" value={data.runs.filter((run) => activeStates.has(run.status || "")).length} detail="Fila real do Chromium" /><Metric icon={AlertTriangle} label="Aprovacoes" value={data.runs.filter((run) => run.status === "awaiting_approval").length} detail="Antes da acao externa" /><Metric icon={Camera} label="Evidencias" value={data.runs.reduce((sum, run) => sum + (run.artifacts || []).filter((item) => item.kind === "screenshot").length, 0)} detail={data.runtime?.engine || "playwright-chromium"} /></section>
      {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}

      {showCredential && <form onSubmit={createCredential} className="grid gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]"><input required value={credentialForm.label} onChange={(event) => setCredentialForm({ ...credentialForm, label: event.target.value })} placeholder="Nome da credencial" className="intelligence-field" /><input required value={credentialForm.domain} onChange={(event) => setCredentialForm({ ...credentialForm, domain: event.target.value })} placeholder="portal.empresa.com" className="intelligence-field" /><input required autoComplete="off" value={credentialForm.username} onChange={(event) => setCredentialForm({ ...credentialForm, username: event.target.value })} placeholder="Usuario" className="intelligence-field" /><input required type="password" autoComplete="new-password" value={credentialForm.password} onChange={(event) => setCredentialForm({ ...credentialForm, password: event.target.value })} placeholder="Senha protegida" className="intelligence-field" /><Button type="submit" variant="primary" disabled={busy}><KeyRound size={15} /> Criptografar</Button><p className="text-xs font-semibold text-[var(--text-secondary)] md:col-span-2 xl:col-span-5">Usuario e senha nunca retornam pela API, nao entram no plano da IA e nao aparecem em logs.</p></form>}

      {showProfile && <form onSubmit={createProfile} className="space-y-4 rounded-2xl border border-cyan-400/25 bg-cyan-400/5 p-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><input required minLength={2} value={profileForm.name} onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })} placeholder="Nome do perfil" className="intelligence-field" /><input value={profileForm.description} onChange={(event) => setProfileForm({ ...profileForm, description: event.target.value })} placeholder="Finalidade e responsavel" className="intelligence-field" /><input required value={profileForm.domains} onChange={(event) => setProfileForm({ ...profileForm, domains: event.target.value })} placeholder="Dominios permitidos, separados por virgula" className="intelligence-field md:col-span-2" /><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Limite de acoes<input type="number" min={1} max={40} value={profileForm.maxActions} onChange={(event) => setProfileForm({ ...profileForm, maxActions: Number(event.target.value) })} className="intelligence-field mt-2" /></label><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Duracao maxima<input type="number" min={30} max={900} value={profileForm.maxDurationSeconds} onChange={(event) => setProfileForm({ ...profileForm, maxDurationSeconds: Number(event.target.value) })} className="intelligence-field mt-2" /></label><div className="space-y-2 md:col-span-2"><span className="text-xs font-black uppercase text-[var(--text-secondary)]">Credenciais autorizadas</span><div className="flex flex-wrap gap-2">{data.credentials.map((credential) => <label key={credential.id} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-bold"><input type="checkbox" checked={profileForm.credentialIds.includes(credential.id)} onChange={() => setProfileForm((current) => ({ ...current, credentialIds: current.credentialIds.includes(credential.id) ? current.credentialIds.filter((id) => id !== credential.id) : [...current.credentialIds, credential.id] }))} />{credential.label || credential.name}</label>)}{!data.credentials.length && <span className="text-xs font-semibold text-[var(--text-secondary)]">Nenhuma credencial cadastrada.</span>}</div></div></div><div className="flex flex-wrap items-center gap-4"><Toggle label="Formularios" checked={profileForm.allowForms} onChange={(value) => setProfileForm({ ...profileForm, allowForms: value })} /><Toggle label="Downloads" checked={profileForm.allowDownloads} onChange={(value) => setProfileForm({ ...profileForm, allowDownloads: value })} /><Toggle label="Uploads" checked={profileForm.allowUploads} onChange={(value) => setProfileForm({ ...profileForm, allowUploads: value })} /><Toggle label="Manter sessao criptografada" checked={profileForm.retainSession} onChange={(value) => setProfileForm({ ...profileForm, retainSession: value })} /><Button type="submit" variant="primary" disabled={busy}><Plus size={15} /> Criar perfil</Button></div></form>}

      <section className="grid gap-5 2xl:grid-cols-[390px_minmax(0,1fr)]"><div className="space-y-4"><form onSubmit={createPlan} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--glass-shadow)]"><div className="flex items-center justify-between"><div><h2 className="text-lg font-black">Nova tarefa</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Primeiro planeja. Depois voce executa.</p></div><ListChecks className="text-cyan-300" size={21} /></div><label className="mt-4 block text-xs font-black uppercase text-[var(--text-secondary)]">Objetivo<textarea required minLength={4} value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} className="intelligence-field mt-2 resize-y py-3" /></label><label className="mt-3 block text-xs font-black uppercase text-[var(--text-secondary)]">URL inicial<input required type="url" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} placeholder="https://portal.empresa.com" className="intelligence-field mt-2" /></label><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Perfil<select value={profileId} onChange={(event) => setProfileId(event.target.value)} className="intelligence-field mt-2"><option value="">Consulta publica sem credencial</option>{data.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Execucao<select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as "assisted" | "automatic")} className="intelligence-field mt-2"><option value="assisted">Assistida, etapa a etapa</option><option value="automatic">Automatica, com aprovacoes</option></select></label><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Resultado<select value={expectedResult} onChange={(event) => setExpectedResult(event.target.value)} className="intelligence-field mt-2"><option value="structured">Dados estruturados</option><option value="summary">Resumo</option><option value="files">Arquivos</option></select></label><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Limite<input type="number" min={1} max={40} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} className="intelligence-field mt-2" /></label></div><label className="mt-3 block text-xs font-black uppercase text-[var(--text-secondary)]">Tempo maximo: {timeoutSeconds}s<input type="range" min={30} max={900} step={30} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} className="mt-2 w-full" /></label><Button type="submit" variant="primary" disabled={busy || !startUrl.trim()} className="mt-4 w-full">{busy ? <Loader2 size={17} className="animate-spin" /> : <FileSearch size={17} />} Criar plano</Button></form><section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-center justify-between"><h2 className="font-black">Historico</h2><Button iconOnly variant="ghost" onClick={() => void load()} aria-label="Atualizar"><RefreshCw size={15} /></Button></div><div className="mt-3 max-h-[440px] space-y-2 overflow-y-auto">{data.runs.map((run) => <button key={run.id} onClick={() => setSelectedRunId(run.id)} className={`w-full rounded-xl border p-3 text-left ${selected?.id === run.id ? "border-cyan-300/50 bg-cyan-400/8" : "border-[var(--border)] bg-[var(--background)]"}`}><div className="flex items-center justify-between gap-2"><strong className="truncate text-sm">{run.host}</strong><Status value={run.status || "planned"} /></div><p className="mt-2 line-clamp-2 text-xs font-semibold text-[var(--text-secondary)]">{run.objective}</p></button>)}{!data.runs.length && <p className="py-8 text-center text-sm font-semibold text-[var(--text-secondary)]">Nenhuma execucao criada.</p>}</div></section><section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-center justify-between"><h2 className="font-black">Perfis</h2><ShieldCheck size={16} className="text-cyan-300" /></div><div className="mt-3 space-y-2">{data.profiles.map((profile) => <div key={profile.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><span className="min-w-0"><strong className="block truncate text-sm">{profile.name}</strong><small className="text-[var(--text-secondary)]">{(profile.allowedDomains || []).join(", ")}</small></span><Button iconOnly variant="danger" onClick={() => void deleteProfile(profile)} aria-label={`Excluir ${profile.name}`}><Trash2 size={13} /></Button></div>)}</div></section></div>

        <section className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)] sm:p-5">{!selected ? <div className="grid min-h-[620px] place-items-center text-center text-[var(--text-secondary)]"><div><Globe2 className="mx-auto" size={42} /><p className="mt-3 font-bold">Crie ou selecione uma tarefa.</p></div></div> : <div className="space-y-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap gap-2"><Status value={selected.status || "planned"} /><span className={`rounded-full px-2.5 py-1 text-xs font-black ${selected.risk === "alto" ? "bg-rose-400/12 text-rose-200" : selected.risk === "medio" ? "bg-amber-400/12 text-amber-100" : "bg-emerald-400/12 text-emerald-200"}`}>Risco {selected.risk}</span><span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-black text-blue-200">{selected.executionMode === "automatic" ? "Automatico" : "Assistido"}</span></div><h2 className="mt-3 text-xl font-black">{selected.objective}</h2><a href={selected.startUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 break-all text-xs font-black text-cyan-300">{selected.startUrl}<ExternalLink size={12} /></a></div><span className="text-xs font-bold text-[var(--text-secondary)]">{displayDate(selected.createdAt)}</span></div><div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]"><div className="relative min-h-[360px] overflow-hidden rounded-2xl border border-white/10 bg-slate-950"><div className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-4 py-3 text-white"><span className="flex items-center gap-2 text-sm font-black"><Camera size={15} /> Captura da execucao</span><span className="text-xs text-slate-400">1440 x 900</span></div><div className="grid min-h-[320px] place-items-center bg-[radial-gradient(circle_at_top,#24364f,#0f172a_70%)]">{previewUrl ? <img src={previewUrl} alt="Ultima captura do navegador" className="max-h-[520px] w-full object-contain" /> : <div className="text-center text-slate-400"><Globe2 className="mx-auto" size={38} /><p className="mt-3 text-sm font-bold">A captura aparecera apos a primeira etapa.</p></div>}</div></div><div className="space-y-4"><div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"><div className="flex justify-between text-xs font-black"><span>Progresso</span><span>{selected.progress || 0}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-300" style={{ width: `${selected.progress || 0}%` }} /></div><p className="mt-3 text-xs font-semibold leading-5 text-[var(--text-secondary)]">{selected.riskReason}</p><p className="mt-2 text-xs font-bold text-cyan-300">Planejador: {selected.planner?.mode || "manual"}</p></div><div className="flex flex-wrap gap-2">{["planned", "failed"].includes(selected.status || "") && <Button variant="primary" disabled={busy} onClick={() => void executeControl("execute")}><Play size={15} /> Executar no Chromium</Button>}{selected.status === "running" && <Button disabled={busy} onClick={() => void executeControl("pause")}><Pause size={15} /> Pausar</Button>}{selected.status === "paused" && <Button variant="primary" disabled={busy} onClick={() => void executeControl("resume")}><Play size={15} /> Continuar</Button>}{["queued", "running", "paused", "awaiting_approval", "cancelling"].includes(selected.status || "") && <Button variant="danger" disabled={busy} onClick={() => void executeControl("cancel")}><Square size={14} /> Cancelar</Button>}<Button disabled={busy || !["planned", "failed", "paused"].includes(selected.status || "")} onClick={beginPlanEdit}><ListChecks size={15} /> Editar plano</Button><label className="inline-flex cursor-pointer"><input hidden type="file" onChange={(event) => void uploadForRun(event)} /><span className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-bold"><FileUp size={15} /> Anexar</span></label></div>{selected.pendingApproval && <div className="rounded-xl border border-amber-400/35 bg-amber-400/10 p-4"><div className="flex items-center gap-2 text-amber-100"><AlertTriangle size={17} /><strong>Confirmacao imediata</strong></div><p className="mt-2 text-sm font-bold">{selected.pendingApproval.description}</p><p className="mt-1 break-all text-xs text-[var(--text-secondary)]">Alvo: {selected.pendingApproval.target || "acao da pagina"}</p><div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void decide("approve")}><CheckCircle2 size={15} /> Aprovar esta acao</Button><Button variant="danger" disabled={busy} onClick={() => void decide("reject")}><XCircle size={15} /> Rejeitar</Button></div></div>}</div></div>

          {selected.error && <Notice tone="error">{selected.error}</Notice>}
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4"><div className="flex items-center justify-between"><div><h3 className="font-black">Plano de acoes</h3><p className="text-xs font-semibold text-[var(--text-secondary)]">Seletores aceitam texto visivel, label=, placeholder= ou css=.</p></div>{editingPlan && <Button variant="primary" disabled={busy || !draftActions.length} onClick={() => void savePlan()}><Save size={14} /> Salvar plano</Button>}</div>{editingPlan ? <div className="mt-4 space-y-3">{draftActions.map((action, index) => <div key={`${action.id || "new"}-${index}`} className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 lg:grid-cols-[150px_1fr_1fr_auto]"><select value={action.type} onChange={(event) => updateAction(index, { type: event.target.value as ActionType })} className="intelligence-field">{actionTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input value={action.description} onChange={(event) => updateAction(index, { description: event.target.value })} placeholder="Descricao da etapa" className="intelligence-field" /><input value={action.target} onChange={(event) => updateAction(index, { target: event.target.value })} placeholder="Alvo visivel ou seletor" className="intelligence-field" /><Button iconOnly variant="danger" onClick={() => setDraftActions((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="Remover etapa"><Trash2 size={14} /></Button>{action.type === "credential_fill" ? <div className="grid gap-2 lg:col-span-3 lg:col-start-2 sm:grid-cols-2"><select value={action.credentialId || ""} onChange={(event) => updateAction(index, { credentialId: event.target.value })} className="intelligence-field"><option value="">Selecione a credencial</option>{data.credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label || credential.name}</option>)}</select><select value={action.credentialField || "username"} onChange={(event) => updateAction(index, { credentialField: event.target.value as "username" | "password" | "secret" })} className="intelligence-field"><option value="username">Usuario protegido</option><option value="password">Senha protegida</option><option value="secret">Segredo protegido</option></select></div> : !["navigate", "extract", "screenshot", "click", "download", "upload"].includes(action.type) && <input value={action.value} onChange={(event) => updateAction(index, { value: event.target.value })} placeholder="Valor, opcao, tecla ou segundos" className="intelligence-field lg:col-span-3 lg:col-start-2" />}</div>)}<Button onClick={() => setDraftActions((current) => [...current, blankAction()])}><Plus size={14} /> Adicionar etapa</Button></div> : <ol className="mt-4 grid gap-2 lg:grid-cols-2">{(selected.plan || []).map((action, index) => <li key={action.id || index} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"><div className="flex items-start justify-between gap-2"><span className="flex min-w-0 items-start gap-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-xs font-black text-blue-300">{index + 1}</span><span><strong className="block text-sm">{action.description}</strong><small className="mt-1 block break-all text-[var(--text-secondary)]">{action.target || action.value || action.type}</small></span></span><Status value={action.status || "pending"} /></div><span className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-black ${action.riskClass === "sensitive" ? "bg-rose-400/10 text-rose-200" : action.riskClass === "external" ? "bg-amber-400/10 text-amber-100" : "bg-emerald-400/10 text-emerald-200"}`}>{action.riskClass === "sensitive" ? "Sensivel" : action.riskClass === "external" ? "Alteracao externa" : "Somente leitura"}</span></li>)}</ol>}</section>

          {selected.result && <section className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4"><div className="flex items-center gap-2 text-emerald-200"><CheckCircle2 size={18} /><h3 className="font-black">{selected.result.title || "Resultado concluido"}</h3></div><p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm font-semibold leading-6 text-[var(--text-secondary)]">{selected.result.summary}</p><div className="mt-3 flex flex-wrap gap-2"><span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-black text-emerald-200">{selected.result.actionsPerformed || 0} acoes</span><span className="rounded-full bg-blue-400/10 px-2.5 py-1 text-xs font-black text-blue-200">{selected.result.readOnly ? "Consulta" : "Acao real executada"}</span></div></section>}
          <div className="grid gap-4 xl:grid-cols-2"><section className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4"><h3 className="font-black">Arquivos e capturas</h3><div className="mt-3 space-y-2">{(selected.artifacts || []).slice().reverse().map((artifact) => <button key={artifact.id} onClick={() => void downloadArtifact(artifact)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left"><span className="flex min-w-0 items-center gap-2">{artifact.kind === "screenshot" ? <Camera size={15} /> : artifact.kind === "upload" ? <FileInput size={15} /> : <Download size={15} />}<span className="min-w-0"><strong className="block truncate text-xs">{artifact.name}</strong><small className="text-[var(--text-secondary)]">{fileSize(artifact.size)}</small></span></span><Download size={14} className="text-cyan-300" /></button>)}{!selected.artifacts?.length && <p className="py-5 text-center text-xs font-semibold text-[var(--text-secondary)]">Nenhuma evidencia ainda.</p>}</div></section><section className="rounded-2xl border border-[var(--border)] bg-[var(--background)] p-4"><h3 className="font-black">Linha do tempo</h3><ol className="mt-3 max-h-80 space-y-3 overflow-y-auto">{(selected.timeline || []).slice().reverse().map((event, index) => <li key={`${event.at}-${index}`} className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-cyan-300" /><span><strong className="block text-xs uppercase tracking-wide">{event.event.replaceAll("_", " ")}</strong><p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{event.message}</p><small className="text-[var(--text-secondary)]">{displayDate(event.at)}</small></span></li>)}</ol></section></div>
        </div>}</section></section>
    </main>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof Globe2; label: string; value: string | number; detail: string }) {
  return <article className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/14 text-cyan-200"><Icon size={18} /></span><p className="mt-3 text-xs font-black uppercase tracking-[.12em] text-[var(--text-secondary)]">{label}</p><strong className="mt-1 block text-2xl font-black">{value}</strong><small className="mt-1 block font-semibold text-[var(--text-secondary)]">{detail}</small></article>;
}

function Notice({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return <div role="status" className={`rounded-xl border px-4 py-3 text-sm font-bold ${tone === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-100" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"}`}>{children}</div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-xs font-black"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}
