import { useEffect, useState } from "react";
import { Download, ExternalLink, FilePenLine, RefreshCw, Save, Sparkles } from "lucide-react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import PdfDocumentPreview from "../commercial/PdfDocumentPreview";
import Button from "../shared/Button";

export type BrowserReport = { title: string; content: string; coverage: string; revision: number; generator: string; warnings: string[]; sources: Array<{ title: string; url: string; accessedAt: string }>; skipped?: Array<{ url: string; reason: string }> };

export default function BrowserReportEditor({ runId, onDirtyChange }: { runId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [report, setReport] = useState<BrowserReport | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiRequest<{ item: BrowserReport }>(`/api/navegador/runs/${runId}/report`).then((response) => { if (active) setReport(response.item); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Não foi possível abrir o relatório."); });
    return () => { active = false; };
  }, [runId]);
  if (error) return <p role="alert" className="text-sm text-rose-400">{error}</p>;
  return report ? <ReportEditor runId={runId} initial={report} onDirtyChange={onDirtyChange} /> : <p role="status" className="p-4 text-sm">Abrindo relatório…</p>;
}

function ReportEditor({ runId, initial, onDirtyChange }: { runId: string; initial: BrowserReport; onDirtyChange?: (dirty: boolean) => void }) {
  const [report, setReport] = useState(initial), [title, setTitle] = useState(initial.title), [content, setContent] = useState(initial.content);
  const [url, setUrl] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pdfBlob, setPdfBlob] = useState<Blob | undefined>();
  const [pdfError, setPdfError] = useState(""), [pdfRetry, setPdfRetry] = useState(0);
  const [rewriteOpen, setRewriteOpen] = useState(false), [rewriting, setRewriting] = useState(false);
  const [instruction, setInstruction] = useState("Desenvolva o assunto com frases completas, contexto e explicações claras. Explique os conceitos, conecte as ideias e use exemplos didáticos quando ajudarem. Escreva parágrafos articulados e uma conclusão que responda ao pedido.");
  const dirty = title !== report.title || content !== report.content;
  const authorship = report.generator === "nora" ? "Análise por Nora" : report.generator === "manual" ? "Editado por você" : "Análise pendente";
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let active = true, objectUrl = "";
    setUrl(""); setPdfBlob(undefined); setPdfError("");
    void apiBlobRequest(`/api/navegador/runs/${runId}/report/pdf`).then((blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setPdfBlob(blob); setUrl(objectUrl); } }).catch((reason) => { if (active) setPdfError(reason instanceof Error ? reason.message : "Não foi possível abrir o PDF."); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [runId, report.revision, pdfRetry]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  async function save() {
    setBusy(true); setError("");
    try { const response = await apiRequest<{ item: BrowserReport }>(`/api/navegador/runs/${runId}/report`, { method: "PUT", body: JSON.stringify({ title, content, revision: report.revision }) }); setReport(response.item); setTitle(response.item.title); setContent(response.item.content); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar o relatório."); }
    finally { setBusy(false); }
  }
  async function rewrite() {
    setRewriting(true); setError("");
    try {
      const response = await apiRequest<{ item: BrowserReport }>(`/api/navegador/runs/${runId}/report/rewrite`, { method: "POST", body: JSON.stringify({ instruction, revision: report.revision }), timeoutMs: 180_000 });
      setReport(response.item); setTitle(response.item.title); setContent(response.item.content); setRewriteOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível reescrever o relatório."); }
    finally { setRewriting(false); }
  }
  return <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Relatório da pesquisa</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{authorship} · {report.sources.length} fontes · Versão {report.revision}</p></div><div className="flex flex-wrap gap-2"><Button disabled={rewriting} onClick={() => setEditing(!editing)}><FilePenLine size={15} />{editing ? "Ocultar editor" : "Editar relatório"}</Button>{editing && <Button disabled={busy || rewriting || !title.trim() || !content.trim() || !dirty} onClick={() => void save()}><Save size={15} />{busy ? "Salvando…" : "Salvar e atualizar PDF"}</Button>}<Button disabled={rewriting || dirty} onClick={() => setRewriteOpen(!rewriteOpen)}><Sparkles size={15} />Reescrever com Nora</Button><Button disabled={!url || dirty || report.generator === "pending"} onClick={() => { const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${report.title.replace(/[^\p{L}\p{N}\s-]/gu, "").slice(0,100) || "pesquisa-norium"}.pdf`; anchor.click(); }}><Download size={15} />Baixar PDF</Button></div></div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{report.coverage}</p>
    {(report.generator === "pending" || report.generator === "extracted") && <p role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-sm text-amber-400">As fontes estão disponíveis, mas este relatório ainda precisa de uma análise desenvolvida. Use Reescrever com Nora para elaborar o texto.</p>}
    {rewriteOpen && <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"><label className="block text-sm font-medium">Como a Nora deve melhorar o relatório?<textarea disabled={rewriting} value={instruction} onChange={event => setInstruction(event.target.value)} rows={4} maxLength={2000} className="intelligence-field mt-2 py-3" /></label><p className="text-xs text-[var(--text-secondary)]">A Nora usará o material preservado da pesquisa. Para relatórios antigos, usará o texto e as referências já disponíveis. A nova redação substituirá o texto quando estiver pronta.</p><div className="flex gap-2"><Button disabled={rewriting || instruction.trim().length < 4 || dirty} onClick={() => void rewrite()}><Sparkles size={15}/>{rewriting ? "Nora está escrevendo…" : "Gerar nova redação"}</Button><Button disabled={rewriting} onClick={() => setRewriteOpen(false)}>Fechar</Button></div></div>}
    {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
    {dirty && <p role="status" className="text-xs text-amber-400">Alterações não salvas. Salve para atualizar a prévia e baixar a nova versão.</p>}
    <div className={editing ? "grid items-start gap-4 xl:grid-cols-2" : ""}>{editing && <div className="space-y-3"><label className="block text-xs font-medium">Título<input disabled={rewriting} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className="intelligence-field mt-2" /></label><label className="block text-xs font-medium">Texto do relatório<textarea disabled={rewriting} value={content} maxLength={200000} onChange={(event) => setContent(event.target.value)} className="intelligence-field mt-2 min-h-[550px] resize-y py-3 text-sm leading-6" /></label><p className="text-xs text-[var(--text-secondary)]">Use ## para títulos. As referências [1], [2] correspondem às fontes listadas no final do PDF.</p></div>}<div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)]">{pdfError ? <div className="space-y-3 p-6 text-center"><p role="alert" className="text-sm text-rose-400">{pdfError}</p><Button onClick={() => setPdfRetry(value => value + 1)}><RefreshCw size={15}/>Tentar carregar PDF</Button></div> : pdfBlob ? <PdfDocumentPreview blob={pdfBlob} title={report.title} /> : <p role="status" className="p-10 text-center text-sm text-[var(--text-secondary)]">Preparando pré-visualização do PDF…</p>}</div></div>
    <details><summary className="cursor-pointer text-sm font-medium">Fontes consultadas ({report.sources.length})</summary><ol className="mt-3 space-y-3">{report.sources.map((source, index) => <li key={source.url} className="text-xs"><a href={source.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 font-medium">[{index + 1}] {source.title || source.url}<ExternalLink size={12} /></a><p className="mt-1 break-all text-[var(--text-secondary)]">{source.url}</p></li>)}</ol></details>
    {!!report.warnings.length && <details><summary className="cursor-pointer text-xs text-amber-400">Observações sobre a leitura ({report.warnings.length})</summary><ul className="mt-2 space-y-2 text-xs leading-5 text-[var(--text-secondary)]">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}{report.skipped?.map((source) => <li key={source.url} className="break-all">{source.url}: {source.reason}</li>)}</ul></details>}
  </section>;
}
