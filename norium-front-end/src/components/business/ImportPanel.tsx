import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope, workspaceScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import "./business.css";

type Job = { id: string; kind: string; status: string; progress: number; errorCode: string; createdAt: number;
  result: { previewId?: string; created?: number; merged?: number; duplicates?: number; attention?: number; skippedInvalid?: number;
    attentionExamples?: { line: number; reason: string }[] } };
type Preview = { id: string; digest: string; total: number; valid: number; columns: string[]; mapping: Record<string, string>;
  rows: { index: number; line: number; data: Record<string, unknown>; error: string; warning: string }[]; nextOffset: number | null };
const fields: Record<string, Record<string, string>> = {
  clients: { name: "Nome / razão social", company: "Empresa", document: "CPF / CNPJ", phone: "WhatsApp", email: "E-mail", city: "Cidade", state: "UF", segment: "Segmento", notes: "Observações" },
  catalog: { name: "Nome do item", sku: "Código / SKU", type: "Tipo", unit: "Unidade", price: "Preço", discount: "Desconto máximo", category: "Categoria", description: "Descrição", duration: "Duração (minutos)" },
};

export default function ImportPanel({ target, onComplete }: { target: "clients" | "catalog"; onComplete?: () => void }) {
  const scope = requestScope();
  const [source, setSource] = useState<{ fileName: string; dataBase64: string } | null>(null);
  const [job, setJob] = useState<Job | null>(null); const [history, setHistory] = useState<Job[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null); const [mapping, setMapping] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0); const [skipInvalid, setSkipInvalid] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const completed = useRef(""); const pendingRequests = useRef(new Set<string>());
  const isRunning = job?.status === "queued" || job?.status === "running";
  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    const current = requestScope();
    try { const result = await apiRequest<{ jobs: Job[] }>(`/api/business/imports/jobs?target=${target}`, { signal });
      if (requestScope() === current && !signal?.aborted) setHistory(result.jobs);
    } catch (err) { if (!signal?.aborted && requestScope() === current) setError(err instanceof Error ? err.message : "Não foi possível consultar as importações."); }
  }, [target]);
  const loadPreview = useCallback(async (id: string, pageOffset = 0) => {
    const current = requestScope();
    const data = await apiRequest<Preview>(`/api/business/imports/previews/${encodeURIComponent(id)}?offset=${pageOffset}&limit=25`);
    if (requestScope() === current) { setPreview(data); setMapping(data.mapping); setOffset(pageOffset); }
  }, []);
  const loadJob = useCallback(async (id: string) => {
    if (pendingRequests.current.has(id)) return;
    pendingRequests.current.add(id); const current = requestScope();
    try { const data = await apiRequest<{ job: Job }>(`/api/business/imports/jobs/${encodeURIComponent(id)}`);
      if (requestScope() !== current) return;
      setJob(data.job);
      if (data.job.status === "completed" && data.job.result.previewId) await loadPreview(data.job.result.previewId);
      if (data.job.status === "completed" || data.job.status === "failed") void loadHistory();
    } catch (err) { if (requestScope() === current) setError(err instanceof Error ? err.message : "Não foi possível consultar o processamento."); }
    finally { pendingRequests.current.delete(id); }
  }, [loadHistory, loadPreview]);
  useEffect(() => {
    const controller = new AbortController(); setSource(null); setJob(null); setPreview(null); setError("");
    void loadHistory(controller.signal); return () => controller.abort();
  }, [scope, loadHistory]);
  useEffect(() => {
    const update = (event: Event) => { const detail = (event as CustomEvent<{ jobId: string; workspace: string }>).detail;
      if (job?.id === detail?.jobId && detail.workspace === workspaceScope() && requestScope() === scope) void loadJob(job.id); };
    const visible = () => { if (job && document.visibilityState === "visible" && requestScope() === scope) void loadJob(job.id); };
    window.addEventListener("norium:business-job-updated", update); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("norium:business-job-updated", update); document.removeEventListener("visibilitychange", visible); };
  }, [job, scope, loadJob]);
  useEffect(() => { if (job?.status === "completed" && !job.kind.includes(".preview.") && completed.current !== job.id) {
    completed.current = job.id; onComplete?.();
  } }, [job, onComplete]);
  async function chooseFile(file?: File) {
    if (!file) return;
    if (file.size > 8_000_000) { setError("Escolha um arquivo de até 8 MB."); return; }
    setBusy(true); setError(""); setPreview(null); setJob(null); setSkipInvalid(false); const current = requestScope();
    try { const encoded = await new Promise<string>((resolve, reject) => { const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]); reader.onerror = () => reject(new Error("Não foi possível ler o arquivo.")); reader.readAsDataURL(file); });
      if (requestScope() !== current) return;
      const value = { fileName: file.name, dataBase64: encoded }; setSource(value); setMapping({});
      const result = await apiRequest<{ job: Job }>("/api/business/imports/preview", { method: "POST", body: JSON.stringify({ ...value, target }) });
      if (requestScope() === current) { setJob(result.job); await loadJob(result.job.id); }
    } catch (err) { if (requestScope() === current) setError(err instanceof Error ? err.message : "Falha ao preparar importação."); }
    finally { if (requestScope() === current) setBusy(false); }
  }
  async function remap() {
    if (!source || busy) return; setBusy(true); setError(""); const current = requestScope();
    try { const result = await apiRequest<{ job: Job }>("/api/business/imports/preview", { method: "POST", body: JSON.stringify({ ...source, target, mapping }) });
      if (requestScope() === current) { setJob(result.job); await loadJob(result.job.id); }
    } catch (err) { if (requestScope() === current) setError(err instanceof Error ? err.message : "Falha ao ajustar as colunas."); }
    finally { if (requestScope() === current) setBusy(false); }
  }
  async function commit() {
    if (!preview || busy) return; setBusy(true); setError(""); const current = requestScope();
    try { const result = await apiRequest<{ job: Job }>(`/api/business/imports/previews/${encodeURIComponent(preview.id)}/commit`, {
      method: "POST", body: JSON.stringify({ expectedDigest: preview.digest, skipInvalid }) });
      if (requestScope() === current) { setJob(result.job); await loadJob(result.job.id); }
    } catch (err) { if (requestScope() === current) setError(err instanceof Error ? err.message : "Não foi possível confirmar a importação."); }
    finally { if (requestScope() === current) setBusy(false); }
  }
  async function retry() {
    if (!job || busy) return; setBusy(true); setError(""); const current = requestScope();
    try { const result = await apiRequest<{ job: Job }>(`/api/business/imports/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      if (requestScope() === current) { setJob(result.job); await loadJob(result.job.id); }
    } catch (err) { if (requestScope() === current) setError(err instanceof Error ? err.message : "Não foi possível retomar o processamento."); }
    finally { if (requestScope() === current) setBusy(false); }
  }
  return <section className="business-panel" aria-label={`Importar ${target === "clients" ? "clientes" : "catálogo"}`}>
    <header className="business-toolbar"><div><h2>Importar em um passo</h2><p>Escolha o arquivo, confira as colunas e revise antes de gravar.</p></div><FileSpreadsheet size={24} aria-hidden="true" /></header>
    <label className="business-upload"><Upload size={24} aria-hidden="true" /><strong>Selecionar arquivo</strong><span>{target === "clients" ? "CSV, XLSX ou vCard" : "CSV ou XLSX"} · até 8 MB e 5.000 registros</span>
      <input type="file" disabled={busy || !!isRunning} accept={target === "clients" ? ".csv,.xlsx,.vcf,.vcard" : ".csv,.xlsx"} onChange={event => { void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
    {source && <p className="business-note">Arquivo: {source.fileName}</p>}
    {error && <p role="alert" className="business-error">{error}</p>}
    {job && <section className="nx-card business-job" aria-live="polite"><div className="business-toolbar"><strong>{job.status === "queued" ? "Na fila" : job.status === "running" ? "Processando" : job.status === "completed" ? "Processamento concluído" : "Não foi possível concluir"}</strong>
      <Button size="sm" onClick={() => void loadJob(job.id)} icon={<RefreshCw size={14} />}>Atualizar status</Button></div>
      {isRunning && <><progress aria-label="Progresso da importação" value={job.progress} max={100} /><p className="business-note">Você pode continuar usando o Norium. O progresso fica salvo.</p></>}
      {job.status === "failed" && <><p role="alert">{job.errorCode === "permission_changed" ? "Seu acesso mudou. Confira as permissões antes de importar novamente." : job.errorCode === "expired_import" ? "O arquivo temporário expirou após 24 horas. Selecione-o novamente; os registros já importados foram preservados." : job.errorCode === "processing_unavailable" ? "O processamento foi interrompido. Você pode retomar do progresso salvo; os registros já aplicados serão reconhecidos." : "Confira o formato do arquivo, as colunas e o limite de registros, e selecione o arquivo novamente."}</p>
        {job.errorCode === "processing_unavailable" && <Button loading={busy} onClick={() => void retry()}>Retomar processamento</Button>}</>}
      {job.status === "completed" && !job.kind.includes(".preview.") && <><p className="flex items-center gap-2"><CheckCircle2 size={18} />{job.result.created ?? 0} criados · {job.result.merged ?? 0} complementados · {job.result.duplicates ?? 0} já cadastrados · {job.result.attention ?? 0} precisam de revisão · {job.result.skippedInvalid ?? 0} inválidos ignorados por sua escolha.</p>
        {job.result.attentionExamples?.map(row => <p className="business-note" key={row.line}>Registro {row.line}: {row.reason}</p>)}</>}
    </section>}
    {preview && !isRunning && job?.kind.includes(".preview.") && <>
      <details open><summary>Conferir o mapeamento das colunas</summary><div className="business-form-grid" style={{ marginTop: 12 }}>{Object.entries(fields[target]).map(([key, label]) => <label className="business-form" key={key}>{label}
        <select className="business-input" value={mapping[key] || ""} onChange={event => setMapping(current => ({ ...current, [key]: event.target.value }))}><option value="">Não importar</option>{preview.columns.map(column => <option key={column} value={column}>{column}</option>)}</select></label>)}</div>
        <Button className="mt-3" disabled={!source || busy} onClick={() => void remap()}>Atualizar prévia com este mapeamento</Button>{!source && <p className="business-note">Para ajustar o mapeamento, selecione o arquivo novamente.</p>}</details>
      <div className="business-toolbar"><h3>Prévia: {preview.valid} de {preview.total} registros válidos</h3><span className="business-badge">Ainda não gravados</span></div>
      <div className="business-table-wrap"><table className="business-table"><thead><tr><th>Registro</th><th>Nome</th><th>{target === "clients" ? "Contato" : "Preço"}</th><th>Conferência</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.index}><td>{row.index+1}</td><td>{String(row.data.name || "Sem nome")}</td><td>{target === "clients" ? String(row.data.email || row.data.phone || "—") : typeof row.data.priceCents === "number" ? (row.data.priceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : String(row.data.price || "—")}</td><td>{row.error ? <span className="business-error">{row.error}</span> : row.warning || "Pronto para importar"}</td></tr>)}</tbody></table></div>
      <div className="business-pagination"><span>{offset+1}–{Math.min(offset+25, preview.total)} de {preview.total}</span><div className="flex gap-2"><Button size="sm" disabled={!offset || busy} onClick={() => void loadPreview(preview.id, Math.max(0, offset-25)).catch(() => setError("Falha ao consultar a página."))}>Anterior</Button><Button size="sm" disabled={preview.nextOffset == null || busy} onClick={() => void loadPreview(preview.id, preview.nextOffset ?? offset).catch(() => setError("Falha ao consultar a página."))}>Próxima</Button></div></div>
      {preview.valid !== preview.total && <label className="flex items-start gap-2"><input type="checkbox" checked={skipInvalid} onChange={event => setSkipInvalid(event.target.checked)} />Importar somente os válidos e ignorar os {preview.total-preview.valid} registros com erro.</label>}
      <p className="business-note">{target === "clients" ? "Clientes são reconhecidos por CPF/CNPJ, telefone ou e-mail no seu cadastro. A importação complementa campos vazios; conflitos entre clientes exigem revisão." : "Códigos/SKUs já cadastrados são reconhecidos e os preços atuais são preservados. Itens novos começam com a oferta pela Nora desativada."}</p>
      <Button variant="primary" loading={busy} disabled={!preview.valid || (preview.valid !== preview.total && !skipInvalid)} onClick={() => void commit()}>Confirmar importação de {preview.valid} registros</Button>
    </>}
    {history.length > 0 && <details><summary>Últimas importações</summary><div className="grid gap-2 mt-3">{history.map(item => <button className="nx-btn" type="button" key={item.id} onClick={() => void loadJob(item.id)}>{item.kind.includes(".preview.") ? "Prévia" : "Importação"} · {new Date(item.createdAt*1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {item.status === "completed" ? "Concluída" : item.status === "failed" ? "Precisa de atenção" : "Em andamento"}</button>)}</div></details>}
  </section>;
}
