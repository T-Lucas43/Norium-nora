import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import type { NoraChatFile } from "./NoraFiles";
import "./noraMailWork.css";

type Recipient = { email: string; name: string };
export type MailWork = {
  id: string; digest: string; sender: string; status: string; read: number; failed: number; estimatedTotal: number;
  sent: number; pageCount: number; unread: number; attachments: number; truncatedBodies: number; unknown: number | null;
  recipientCount: number;
  updatedAt: string; summaries: string[]; highlights: { id: string; subject: string; from: string }[];
  consolidated?: string;
  attempts: { email: string; status: string }[];
  spec: { kind: "mailbox" | "campaign"; folder: string; query: string; analyze: boolean; includeBody: boolean;
    messageBudget: number; recipients: Recipient[]; subject: string; body: string; purpose: string;
    attachments?: { id: string; name: string; size: number }[] };
};
const root = "/api/emails/gmail/work/jobs";
const labels: Record<string, string> = { paused: "Pausado", running: "Em andamento", completed: "Concluído", partial: "Concluído com falhas de leitura", read_error: "Leitura interrompida", awaiting_approval: "Aguardando sua aprovação", budget_reached: "Limite de leitura alcançado", analysis_budget_reached: "Limite de análise alcançado", cancelled: "Cancelado", unknown: "Envio com resultado incerto", connection_changed: "Conta Gmail alterada", daily_limit: "Limite diário de envio alcançado" };

export function NoraMailJobCard({ jobId, initialJob }: { jobId: string; initialJob?: MailWork }) {
  const [job, setJob] = useState<MailWork | undefined>(initialJob);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [budget, setBudget] = useState(5000);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [testJob, setTestJob] = useState<MailWork | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setAuto(false);
    void apiRequest<{ job: MailWork }>(`${root}/${jobId}`).then((result) => { if (active) { setJob(result.job); setError(""); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Trabalho indisponível."); });
    return () => { active = false; };
  }, [jobId]);
  useEffect(() => {
    if (!auto || job?.status !== "running") return;
    let active = true;
    const timer = window.setTimeout(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await apiRequest<{ job: MailWork }>(`${root}/${jobId}/advance`, { method: "POST" });
        if (active) { setJob(result.job); setError(""); }
      } catch (reason) { if (active) { setAuto(false); setError(reason instanceof Error ? reason.message : "Não foi possível continuar."); } }
      finally { inFlight.current = false; }
    }, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [job, auto, jobId]);
  async function action(name: string) {
    if (!job || busy) return;
    if (name === "resume" && job.status === "running") { setAuto(true); return; }
    setBusy(true);
    try {
      const result = await apiRequest<{ job: MailWork }>(`${root}/${jobId}/${name}`, { method: "POST", body: JSON.stringify({ digest: job.digest, acknowledged }) });
      setJob(result.job); setAuto((name === "resume" || name === "approve") && result.job.status === "running"); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível atualizar o trabalho."); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true);
    try {
      const url = URL.createObjectURL(await apiBlobRequest(`${root}/${jobId}/report`));
      const link = document.createElement("a"); link.href = url; link.download = `relatorio-nora-${jobId}.md`; link.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Relatório indisponível."); }
    finally { setBusy(false); }
  }
  async function extend() {
    if (!job) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ job: MailWork }>(`${root}/${jobId}/budget/extend`, { method: "POST", body: JSON.stringify({ messageBudget: budget }) });
      setJob(result.job); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível ampliar o limite."); }
    finally { setBusy(false); }
  }
  async function prepareTest() {
    if (!job) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ job: MailWork }>(`${root}/${jobId}/prepare-test`, { method: "POST", body: JSON.stringify({ digest: job.digest, acknowledged: false }) });
      setTestJob(result.job); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível preparar o teste."); }
    finally { setBusy(false); }
  }
  function preview(value: string) {
    const recipient = job?.spec.recipients[previewIndex];
    return recipient ? value.replaceAll("{{nome}}", recipient.name || recipient.email).replaceAll("{{email}}", recipient.email) : value;
  }
  return <section className="nora-mail-job" aria-label="Trabalho de e-mails com a Nora">
    {error && <p role="alert">{error}</p>}
    {!job ? <p>Carregando trabalho…</p> : <>
      <header><strong>{job.spec.kind === "campaign" ? "Campanha de e-mails" : "Leitura e análise de e-mails"}</strong><span role="status">{labels[job.status] || job.status}</span></header>
      <p>{job.spec.kind === "campaign" ? `${job.sent} de ${job.recipientCount} envios confirmados` : `${job.read} lidos · ${job.failed} falhas · ${job.pageCount} páginas · limite ${job.spec.messageBudget}`}</p>
      <p className="nora-mail-note">Conta: {job.sender}. {job.spec.query ? `Filtro: ${job.spec.query}.` : ""} O progresso fica salvo. Fechar esta área interrompe os próximos passos; reabra e continue.</p>
      {job.spec.kind === "mailbox" && <p className="nora-mail-note">{job.spec.includeBody ? `Corpos limitados a 4.000 caracteres para análise; ${job.truncatedBodies} reduzidos.` : "Análise de assuntos e trechos; corpos completos não analisados."} Anexos não são baixados.</p>}
      {job.status === "awaiting_approval" && <div className="nora-mail-review">
        <p><strong>Finalidade:</strong> {job.spec.purpose}</p>
        <label>Prévia por destinatário<select aria-label="Prévia por destinatário" value={previewIndex} onChange={(event) => setPreviewIndex(Number(event.target.value))}>{job.spec.recipients.map((recipient, index) => <option key={recipient.email} value={index}>{recipient.name || recipient.email}</option>)}</select></label>
        <p><strong>Assunto:</strong> {preview(job.spec.subject)}</p><pre>{preview(job.spec.body)}</pre>
        {!!job.spec.attachments?.length && <ul aria-label="Anexos da campanha">{job.spec.attachments.map((file) => <li key={file.id}>{file.name} · {Math.ceil(file.size / 1024)} KB</li>)}</ul>}
        <details><summary>Revisar todos os {job.spec.recipients.length} destinatários</summary><ul>{job.spec.recipients.map((recipient) => <li key={recipient.email}>{recipient.name} &lt;{recipient.email}&gt;</li>)}</ul></details>
        <p className="nora-mail-note">Envios individuais: nenhum destinatário vê os demais. Limite inicial: 100 tentativas diárias por conta. Sem comprovação de abertura ou entrega.</p>
        <label className="nora-mail-check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />Revisei a mensagem, a finalidade e os contatos; tenho autorização para enviar a eles.</label>
      </div>}
      {job.unknown !== null && <p role="status">Um envio pode ter sido aplicado. A fila está parada. Reconciliar consulta Enviados e nunca reenvia automaticamente.</p>}
      <div className="nora-mail-actions">
        {job.status === "awaiting_approval" && <button type="button" disabled={busy || !acknowledged} onClick={() => void action("approve")}>Aprovar e enviar individualmente</button>}
        {job.status === "awaiting_approval" && <button type="button" disabled={busy} onClick={() => void prepareTest()}>Preparar teste para mim</button>}
        {["paused", "read_error", "daily_limit", "running"].includes(job.status) && !auto && <button type="button" disabled={busy} onClick={() => void action("resume")}>Continuar</button>}
        {job.status === "running" && <button type="button" disabled={busy} onClick={() => { setAuto(false); void action("pause"); }}>Pausar</button>}
        {job.unknown !== null && <button type="button" disabled={busy} onClick={() => void action("reconcile")}>Reconciliar envio</button>}
        {job.status === "analysis_budget_reached" && <button type="button" disabled={busy} onClick={() => void action("read_only")}>Continuar somente a leitura</button>}
        {!["completed", "cancelled"].includes(job.status) && <button type="button" disabled={busy} onClick={() => { setAuto(false); void action("cancel"); }}>Cancelar próximos passos</button>}
        <button type="button" disabled={busy} onClick={() => void download()}>Baixar relatório</button>
        {job.summaries.length > 0 && <button type="button" disabled={busy || auto} onClick={() => void action("summarize")}>Consolidar relatório com a Nora</button>}
      </div>
      {job.status === "budget_reached" && <div className="nora-mail-actions"><label>Novo limite de mensagens<input type="number" min={job.spec.messageBudget + 1} max={50000} value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></label><button type="button" disabled={busy || budget <= job.spec.messageBudget} onClick={() => void extend()}>Ampliar limite de leitura</button></div>}
      {job.summaries.length > 0 && <details><summary>Ver análises de {job.summaries.length} lotes</summary>{job.summaries.map((summary, index) => <p key={index}>{summary}</p>)}</details>}
      {job.consolidated && <section><strong>Resumo executivo</strong><p>{job.consolidated}</p></section>}
      {testJob && <div><button type="button" onClick={() => setTestJob(null)}>Fechar prévia de teste</button><NoraMailJobCard jobId={testJob.id} initialJob={testJob} /></div>}
    </>}
  </section>;
}

export default function NoraMailWork({ initialKind = "mailbox", identity = "" }: { initialKind?: "mailbox" | "campaign"; identity?: string }) {
  const [kind, setKind] = useState(initialKind);
  const [folder, setFolder] = useState("inbox"); const [query, setQuery] = useState("newer_than:30d");
  const [includeBody, setIncludeBody] = useState(false); const [analyze, setAnalyze] = useState(false);
  const [messageBudget, setMessageBudget] = useState(1000);
  const [recipients, setRecipients] = useState(""); const [subject, setSubject] = useState("");
  const [body, setBody] = useState(""); const [purpose, setPurpose] = useState("");
  const [files, setFiles] = useState<NoraChatFile[]>([]); const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<MailWork[]>([]); const [selected, setSelected] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  useEffect(() => {
    let active = true; setJobs([]); setSelected(""); setRecipients(""); setSubject(""); setBody(""); setPurpose(""); setFiles([]); setAttachmentIds([]); setError("");
    void apiRequest<{ items: MailWork[] }>(root).then((result) => { if (active) setJobs(result.items); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Não foi possível listar trabalhos."); });
    return () => { active = false; };
  }, [identity]);
  useEffect(() => {
    if (kind !== "campaign") return;
    let active = true;
    void apiRequest<{ files: NoraChatFile[] }>("/api/nora/files/library").then((result) => { if (active) setFiles(result.files); }).catch(() => { if (active) setFiles([]); });
    return () => { active = false; };
  }, [kind, identity]);
  async function create(event: FormEvent) {
    event.preventDefault(); if (creating.current) return;
    creating.current = true; setBusy(true); setError("");
    try {
      const list = kind === "campaign" ? recipients.split(/[\n;]+/).flatMap((line) => line.includes("<") ? [line] : line.split(",")).map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^(.*?)\s*<([^<>]+)>$/);
        return match ? { name: match[1].trim(), email: match[2].trim() } : { email: line, name: "" };
      }) : [];
      const result = await apiRequest<{ job: MailWork }>(root, { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), kind, folder, query, includeBody, analyze, messageBudget, recipients: list, subject: kind === "campaign" ? subject : "", body: kind === "campaign" ? body : "", purpose: kind === "campaign" ? purpose : "", attachmentIds: kind === "campaign" ? attachmentIds : [] }) });
      setJobs((current) => [result.job, ...current]); setSelected(result.job.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível preparar o trabalho."); }
    finally { creating.current = false; setBusy(false); }
  }
  return <section className="nora-mail-productivity" aria-label="Central de trabalhos da Nora em e-mails">
    <header><strong>Trabalhos com a Nora</strong><p>Leia a caixa por completo, analise respostas e prepare envios com revisão.</p></header>
    {error && <p role="alert">{error}</p>}
    <div className="nora-mail-actions"><button type="button" aria-pressed={kind === "mailbox"} onClick={() => { setKind("mailbox"); setSelected(""); }}>Leitura e relatório</button><button type="button" aria-pressed={kind === "campaign"} onClick={() => { setKind("campaign"); setSelected(""); }}>Campanha individual</button></div>
    {!selected && <form onSubmit={(event) => void create(event)}>
      {kind === "mailbox" ? <>
        <label>Área<select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="inbox">Caixa de entrada</option><option value="sent">Enviados</option><option value="all">Todas as mensagens, exceto spam e lixeira</option></select></label>
        <label>Filtro Gmail ou período<input value={query} maxLength={600} onChange={(event) => setQuery(event.target.value)} placeholder="after:2026/10/01 before:2026/11/01 — vazio para caixa inteira" /></label>
        <label>Limite por trabalho<input type="number" min={1} max={50000} value={messageBudget} onChange={(event) => setMessageBudget(Number(event.target.value))} /></label>
        <label className="nora-mail-check"><input type="checkbox" checked={includeBody} onChange={(event) => setIncludeBody(event.target.checked)} />Incluir conteúdo das mensagens, com limite por corpo</label>
        <label className="nora-mail-check"><input type="checkbox" checked={analyze} onChange={(event) => setAnalyze(event.target.checked)} />Analisar os trechos com o provedor de IA configurado</label>
        <p className="nora-mail-note">Filtro vazio percorre todas as páginas até o limite escolhido. Ao atingir o limite, o trabalho pausa e permite ampliá-lo. Anexos não são lidos.</p>
      </> : <>
        <label>Finalidade<input required maxLength={300} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
        <label>Destinatários — um por linha, até 500; aceita Nome &lt;e-mail&gt;<textarea required value={recipients} onChange={(event) => setRecipients(event.target.value)} maxLength={128000} /></label>
        <label>Assunto<input required maxLength={240} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label>Mensagem<textarea required maxLength={12000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        {files.length > 0 && <fieldset><legend>Anexos da sua biblioteca — até 8 arquivos e 18 MB</legend>{files.map((file) => <label className="nora-mail-check" key={file.id}><input type="checkbox" checked={attachmentIds.includes(file.id)} disabled={!attachmentIds.includes(file.id) && attachmentIds.length >= 8} onChange={(event) => setAttachmentIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} />{file.name}</label>)}</fieldset>}
        <p className="nora-mail-note">Use {"{{nome}}"} e {"{{email}}"} para personalizar. Você revisará a lista e a mensagem antes de aprovar. Para alterar uma campanha, cancele-a e prepare outra versão. Conteúdo temporário: até 7 dias; envios incertos preservam a referência para reconciliação.</p>
      </>}
      <button type="submit" disabled={busy}>{busy ? "Preparando…" : kind === "campaign" ? "Preparar prévia de campanha" : "Preparar leitura"}</button>
    </form>}
    {selected && <><button type="button" onClick={() => setSelected("")}>Preparar outro trabalho</button><NoraMailJobCard key={selected} jobId={selected} initialJob={jobs.find((job) => job.id === selected)} /></>}
    {jobs.length > 0 && <details><summary>Trabalhos salvos ({jobs.length})</summary><ul>{jobs.map((job) => <li key={job.id}><button type="button" onClick={() => setSelected(job.id)}>{job.spec.kind === "campaign" ? job.spec.subject : "Leitura da caixa"} · {labels[job.status] || job.status}</button></li>)}</ul></details>}
  </section>;
}
