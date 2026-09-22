import "../shared/workspace.css";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeft, Combine, Download, FileImage, FileSearch, FileText, Files,
  Highlighter, ImagePlus, Layers3, ListFilter, LockKeyhole, Minimize2, Pencil,
  RefreshCw, RotateCw, Search, ShieldCheck, Sparkles, Split, Trash2,
  UnlockKeyhole, Upload, Wrench,
  type LucideIcon,
} from "lucide-react";
import { downloadImportedDocument, importDocument, loadPdfJob } from "../../features/commercial/api";
import type { PdfCapabilities, PdfOperation, PdfProcessingJob, UploadedDocument } from "../../features/commercial/types";
import Button from "../shared/Button";
import EmptyState from "../shared/EmptyState";
import LoadingState from "../shared/LoadingState";
import StatusBanner from "../shared/StatusBanner";

import PdfVisualEditor from "./PdfVisualEditor";
import PdfResult from "./PdfResult";
import type { PdfEdits } from "./pdfEditorModel";
import "./pdfToolsWorkspace.css";

type ToolMeta = {
  title: string;
  description: string;
  category: "Organizar" | "Otimizar" | "Converter" | "Editar" | "Seguranca" | "Inteligencia";
  icon: LucideIcon;
  accent: string;
};

const toolMeta: Record<PdfOperation, ToolMeta> = {
  merge: { title: "Combinar PDF", description: "Una arquivos na ordem escolhida.", category: "Organizar", icon: Combine, accent: "from-blue-500 to-cyan-400" },
  split: { title: "Separar PDF", description: "Extraia paginas em arquivos independentes.", category: "Organizar", icon: Split, accent: "from-violet-500 to-fuchsia-400" },
  reorder: { title: "Organizar paginas", description: "Defina uma nova ordem para as paginas.", category: "Organizar", icon: Layers3, accent: "from-indigo-500 to-blue-400" },
  delete_pages: { title: "Excluir paginas", description: "Remova paginas selecionadas com seguranca.", category: "Organizar", icon: Trash2, accent: "from-rose-500 to-orange-400" },
  rotate: { title: "Girar PDF", description: "Corrija a orientacao de uma ou mais paginas.", category: "Organizar", icon: RotateCw, accent: "from-cyan-500 to-blue-400" },
  compress: { title: "Comprimir PDF", description: "Reduza o tamanho preservando a leitura.", category: "Otimizar", icon: Minimize2, accent: "from-emerald-500 to-cyan-400" },
  remove_metadata: { title: "Limpar metadados", description: "Remova propriedades ocultas do documento.", category: "Otimizar", icon: ShieldCheck, accent: "from-slate-500 to-cyan-400" },
  sanitize: { title: "Sanitizar PDF", description: "Reconstrua o arquivo em uma copia controlada.", category: "Otimizar", icon: RefreshCw, accent: "from-teal-500 to-emerald-400" },
  images_to_pdf: { title: "Imagens para PDF", description: "Converta JPG, PNG ou WebP em PDF.", category: "Converter", icon: ImagePlus, accent: "from-amber-500 to-orange-400" },
  extract_text: { title: "PDF para texto", description: "Extraia o texto para um arquivo editavel.", category: "Converter", icon: FileText, accent: "from-sky-500 to-blue-400" },
  ocr: { title: "OCR", description: "Transforme digitalizacoes em texto pesquisavel.", category: "Converter", icon: FileSearch, accent: "from-purple-500 to-indigo-400" },
  edit_pdf: { title: "Editar PDF", description: "Edite texto, assine, desenhe e organize as páginas visualmente.", category: "Editar", icon: Pencil, accent: "from-blue-600 to-violet-500" },
  watermark: { title: "Marca d'agua", description: "Aplique texto com opacidade e rotacao.", category: "Editar", icon: Highlighter, accent: "from-fuchsia-500 to-rose-400" },
  page_numbers: { title: "Numerar paginas", description: "Inclua numeracao consistente no rodape.", category: "Editar", icon: ListFilter, accent: "from-cyan-500 to-indigo-400" },
  add_password: { title: "Proteger PDF", description: "Criptografe o documento com uma senha.", category: "Seguranca", icon: LockKeyhole, accent: "from-emerald-600 to-teal-400" },
  remove_password: { title: "Desbloquear PDF", description: "Remova uma senha que voce esta autorizado a usar.", category: "Seguranca", icon: UnlockKeyhole, accent: "from-amber-500 to-yellow-300" },
  compare: { title: "Comparar PDFs", description: "Gere um relatorio das diferencas textuais.", category: "Inteligencia", icon: Files, accent: "from-violet-600 to-blue-500" },
};

const categories = ["Todos", "Organizar", "Otimizar", "Converter", "Editar", "Seguranca", "Inteligencia"] as const;

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo selecionado."));
    reader.readAsDataURL(file);
  });
}

export default function PdfToolsWorkspace({
  capabilities, documents, jobs, busy, onBack, onProcess, onImported, onDelete,
}: {
  capabilities: PdfCapabilities | null;
  documents: UploadedDocument[];
  jobs: PdfProcessingJob[];
  busy: boolean;
  onBack: () => void;
  onProcess: (operation: PdfOperation, documentIds: string[], options: Record<string, unknown>) => Promise<PdfProcessingJob | undefined>;
  onImported: (document: UploadedDocument) => void;
  onDelete: (document: UploadedDocument) => Promise<boolean>;
}) {
  const [operation, setOperation] = useState<PdfOperation | null>(null);
  const [category, setCategory] = useState<(typeof categories)[number]>("Todos");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [text, setText] = useState("Texto do documento");
  const [pages, setPages] = useState("");
  const [password, setPassword] = useState("");
  const [degrees, setDegrees] = useState(90);
  const [editorOpen, setEditorOpen] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [activeJobId, setActiveJobId] = useState("");
  const activeJob = jobs.find(job => job.id === activeJobId);
  const resultDocuments = documents.filter(document => activeJob?.outputDocumentIds.includes(document.id));
  const processing = activeJob?.status === "queued" || activeJob?.status === "processing";
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const availableTools = useMemo(() => (capabilities?.operations || []).filter((item) => {
    const meta = toolMeta[item.id];
    const matchesCategory = category === "Todos" || meta.category === category;
    const normalized = `${meta.title} ${meta.description}`.toLocaleLowerCase("pt-BR");
    return matchesCategory && normalized.includes(query.trim().toLocaleLowerCase("pt-BR"));
  }), [capabilities?.operations, category, query]);
  const meta = operation ? toolMeta[operation] : null;
  const SelectedToolIcon = meta?.icon;
  const needsMany = operation === "merge" || operation === "compare";
  const compatibleDocuments = operation === "images_to_pdf"
    ? documents.filter((item) => item.mimeType.startsWith("image/"))
    : documents.filter((item) => item.mimeType === "application/pdf");
  const selectedDocument = documents.find((item) => item.id === selectedIds[0]);
  const selectedDocumentId = selectedDocument?.id;
  const validSelection = needsMany ? operation === "compare" ? selectedIds.length === 2 : selectedIds.length >= 2 : operation === "images_to_pdf" ? selectedIds.length > 0 : selectedIds.length === 1;

  useEffect(() => {
    if (!selectedDocumentId) {
      setPreviewUrl(""); setPreviewBlob(null); setPreviewLoading(false);
      return undefined;
    }
    setPreviewUrl(""); setPreviewBlob(null);
    let active = true;
    let objectUrl = "";
    setPreviewLoading(true);
    downloadImportedDocument(selectedDocumentId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setPreviewBlob(blob);
      })
      .catch(() => active && setError("Nao foi possivel abrir a visualizacao deste arquivo."))
      .finally(() => active && setPreviewLoading(false));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDocumentId]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !operation) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [operation]);

  function chooseTool(value: PdfOperation) {
    setOperation(value);
    setActiveJobId("");
    setSelectedIds([]);
    setMessage("");
    setError("");
  }

  function toggleDocument(id: string) {
    setSelectedIds((current) => needsMany || operation === "images_to_pdf"
      ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      : [id]);
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setImporting(true); setError(""); setMessage("");
    try {
      const imported: UploadedDocument[] = [];
      for (const file of files) {
        if (!["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          throw new Error(`Formato nao permitido: ${file.name}`);
        }
        const response = await importDocument({
          fileName: file.name,
          mimeType: file.type as "application/pdf" | "image/png" | "image/jpeg" | "image/webp",
          dataBase64: await fileDataUrl(file), category: "pdf", direction: "internal", confidential: false,
        });
        imported.push(response.document);
        onImported(response.document);
      }
      setSelectedIds((needsMany || operation === "images_to_pdf" ? imported : imported.slice(0, 1)).map((item) => item.id));
      setMessage(`${imported.length} arquivo(s) importado(s) para o workspace.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nao foi possivel importar os arquivos.");
    } finally {
      setImporting(false);
    }
  }

  async function process() {
    if (!operation || !validSelection) return;
    const options: Record<string, unknown> = {};
    if (["split", "reorder", "delete_pages", "rotate"].includes(operation) && pages.trim()) options.pages = pages.trim();
    if (operation === "watermark") options.text = text.trim();
    if (["add_password", "remove_password"].includes(operation)) options.password = password;
    if (operation === "rotate") options.degrees = degrees;
    const job = await onProcess(operation, selectedIds, options);
    if (job) setActiveJobId(job.id);
  }

  async function removeDocument(document: UploadedDocument) {
    setError("");
    const deleted = await onDelete(document);
    if (!deleted) return;
    setSelectedIds((current) => current.filter((id) => id !== document.id));
    setMessage(`O arquivo "${document.title}" foi excluido.`);
  }

  async function saveVisualEdits(edits: PdfEdits) {
    const response = await onProcess("edit_pdf", selectedIds, { editor: edits });
    if (!response) throw new Error("Não foi possível iniciar o processamento.");
    setActiveJobId(response.id);
    for (let attempt = 0; attempt < 220; attempt++) {
      const { job } = await loadPdfJob(response.id);
      if (job.status === "completed" && job.outputDocumentIds.length) return downloadImportedDocument(job.outputDocumentIds[0]);
      if (job.status === "failed" || job.status === "cancelled") throw new Error(job.message);
      await new Promise(resolve => window.setTimeout(resolve, 1500));
    }
    throw new Error("O processamento continua em andamento. Acompanhe o resultado nesta ferramenta.");
  }

  if (editorOpen && previewBlob && selectedDocument) return <PdfVisualEditor blob={previewBlob} title={selectedDocument.title} onClose={() => setEditorOpen(false)} onSave={saveVisualEdits}/>;

  if (!capabilities) return <main className="clean-workspace pdf-workspace min-h-[calc(100dvh-74px)] bg-[var(--background)] p-4 sm:p-6"><LoadingState label="Carregando o Norium PDF Studio..." /></main>;

  return (
    <main className="clean-workspace pdf-workspace min-h-[calc(100dvh-74px)] bg-[var(--background)] text-[var(--text)]">
      <input ref={fileInput} hidden multiple type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => void importFiles(event)} />
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color:var(--background)]/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3"><Button iconOnly variant="ghost" onClick={onBack} aria-label="Voltar para Documentos"><ArrowLeft size={18} /></Button><span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-cyan-400 text-white"><Wrench size={19} /></span><div><h1 className="font-black">Norium PDF Studio</h1><p className="text-xs font-semibold text-[var(--text-secondary)]">Editor, conversor e organizador privado</p></div></div>
          <div className="flex gap-2"><Button variant="secondary" onClick={() => fileInput.current?.click()} loading={importing} icon={<Upload size={15} />}>Selecionar arquivos</Button>{operation && <Button variant="ghost" onClick={() => { setOperation(null); setSelectedIds([]); }}>Todas as ferramentas</Button>}</div>
        </div>
      </header>

      <div className="mx-auto max-w-[1720px] p-4 sm:p-6">
        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        {message && <StatusBanner tone="success">{message}</StatusBanner>}
        {activeJob && <div role="status" className="my-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><strong>{processing ? "Preparando seu arquivo…" : activeJob.status === "completed" ? "Processamento concluído" : "Processamento interrompido"}</strong><p className="mt-1 text-xs text-[var(--text-secondary)]">{activeJob.message}</p>{processing && <progress className="mt-3 w-full accent-emerald-500" max={100} value={activeJob.progress}/>}</div>}
        {resultDocuments.map(document => <PdfResult key={document.id} document={document}/>)}
        {!operation ? (
          <section className="pdf-home-shell">
            <aside className="pdf-home-sidebar" aria-label="Navegação das ferramentas PDF">
              <div className="pdf-home-sidebar-heading"><Wrench size={18} /><span><strong>Ferramentas</strong><small>{capabilities.operations.length} disponíveis</small></span></div>
              <nav>{categories.map((item) => {
                const count = item === "Todos" ? capabilities.operations.length : capabilities.operations.filter((tool) => toolMeta[tool.id].category === item).length;
                return <button key={item} aria-pressed={category === item} onClick={() => setCategory(item)}><span>{item}</span><small>{count}</small></button>;
              })}</nav>
              <div className={`pdf-engine-status ${capabilities.stirling.available ? "is-online" : ""}`}>
                <i aria-hidden="true" />
                <span><strong>{capabilities.stirling.available ? "Stirling privado conectado" : "Motor nativo ativo"}</strong><small>{capabilities.stirling.message}</small></span>
              </div>
            </aside>

            <div className="pdf-home-content">
              <section className="pdf-library-intro">
                <div className="pdf-library-copy">
                  <span className="pdf-library-kicker"><ShieldCheck size={14} /> PDF Studio privado</span>
                  <h2>Leia, edite ou transforme qualquer PDF.</h2>
                  <p>Uma central completa para documentos, com processamento no ambiente do Norium e integração privada opcional.</p>
                  <div className="pdf-library-actions">
                    <Button variant="primary" onClick={() => chooseTool("edit_pdf")} icon={<Pencil size={16} />}>Abrir editor</Button>
                    <Button variant="secondary" onClick={() => fileInput.current?.click()} loading={importing} icon={<Upload size={16} />}>Importar arquivos</Button>
                  </div>
                </div>
                <div className="pdf-library-visual" aria-hidden="true"><span><FileText size={42} /></span><i /><i /><i /></div>
              </section>

              <label className="pdf-tool-search"><Search size={18} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar entre edição, organização, OCR e segurança" /><kbd>Ctrl K</kbd></label>

              <div className="pdf-section-heading"><div><span>{category === "Todos" ? "Todas as ferramentas" : category}</span><h3>Escolha o que deseja fazer</h3></div><small>{availableTools.length} resultado(s)</small></div>
              <section className="pdf-tools-grid">{availableTools.map((tool) => { const item = toolMeta[tool.id]; const Icon = item.icon; const engine = capabilities.operations.find((candidate) => candidate.id === tool.id)?.engine; return <button key={tool.id} onClick={() => chooseTool(tool.id)} className="pdf-tool-card"><span className={`pdf-tool-icon bg-gradient-to-br ${item.accent}`}><Icon size={21} /></span><span className="pdf-tool-copy"><small>{item.category}</small><strong>{item.title}</strong><span>{item.description}</span></span><span className="pdf-tool-engine">{engine === "stirling" ? "Stirling" : "Norium"}</span><ArrowLeft className="pdf-tool-arrow rotate-180" size={15} /></button>; })}</section>
              {!availableTools.length && <EmptyState title="Nenhuma ferramenta encontrada" description="Tente outra categoria ou termo de busca." icon={Search} className="mt-5 min-h-64" />}

              <section className="pdf-home-bottom"><article><div className="pdf-section-heading"><div><span>Atividade</span><h3>Processamentos recentes</h3></div><Sparkles size={19} /></div><div className="pdf-recent-list">{jobs.slice(0, 5).map((job) => <div key={job.id}><span className="min-w-0"><strong>{job.label}</strong><small>{job.message}</small></span><em>{job.status}</em>{job.status === "completed" && <Button size="sm" onClick={() => setActiveJobId(job.id)}>Ver</Button>}</div>)}{!jobs.length && <p>Nenhum processamento realizado.</p>}</div></article><article className="pdf-privacy-card"><ShieldCheck size={23} /><h3>Privacidade por padrão</h3><p>O arquivo original é preservado. Cada resultado vira um novo documento e serviços externos só são usados quando uma instância privada autorizada confirma a operação.</p></article></section>
            </div>
          </section>
        ) : (
          <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)_340px]">
            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]"><div className="flex items-center gap-3"><span className={`grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br ${meta?.accent} text-white`}>{SelectedToolIcon && <SelectedToolIcon size={20} />}</span><div><span className="text-xs font-black uppercase tracking-wide text-blue-300">{meta?.category}</span><h2 className="font-black">{meta?.title}</h2></div></div><p className="mt-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{meta?.description}</p><div className="mt-5 border-t border-[var(--border)] pt-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black uppercase text-[var(--text-secondary)]">Arquivos</h3><button onClick={() => fileInput.current?.click()} className="text-xs font-black text-cyan-300">+ Importar</button></div><div className="mt-3 max-h-[52dvh] space-y-2 overflow-auto">{compatibleDocuments.map((document) => { const checked = selectedIds.includes(document.id); return <div key={document.id} className={`flex items-center gap-1 rounded-xl border pr-2 ${checked ? "border-blue-400/50 bg-blue-500/10" : "border-[var(--border)] bg-[var(--background)]"}`}><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 p-3"><input type={needsMany || operation === "images_to_pdf" ? "checkbox" : "radio"} checked={checked} name="pdf-studio-document" onChange={() => toggleDocument(document.id)} /><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-300">{document.mimeType.startsWith("image/") ? <FileImage size={17} /> : <FileText size={17} />}</span><span className="min-w-0"><strong className="block truncate text-xs">{document.title}</strong><small className="text-[var(--text-secondary)]">{fileSize(document.size)}</small></span></label><button type="button" disabled={busy} onClick={() => void removeDocument(document)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40" aria-label={`Excluir ${document.title}`} title="Excluir PDF"><Trash2 size={15} /></button></div>; })}{!compatibleDocuments.length && <p className="py-8 text-center text-xs font-semibold text-[var(--text-secondary)]">Importe um arquivo compativel.</p>}</div></div></aside>

            <article className="min-h-[68dvh] overflow-hidden rounded-2xl border border-[var(--border)] bg-slate-950 shadow-2xl"><header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-4 py-3 text-white"><span className="min-w-0"><strong className="block truncate text-sm">{selectedDocument?.title || "Visualizacao do documento"}</strong><small className="text-slate-400">{selectedDocument ? fileSize(selectedDocument.size) : "Selecione um arquivo ao lado"}</small></span><span className="flex items-center gap-1">{previewUrl && <a href={previewUrl} download={selectedDocument?.originalFileName} className="rounded-lg p-2 text-cyan-300 hover:bg-white/10" aria-label="Baixar arquivo original"><Download size={17} /></a>}{selectedDocument && <button type="button" disabled={busy} onClick={() => void removeDocument(selectedDocument)} className="rounded-lg p-2 text-rose-300 hover:bg-rose-500/10 disabled:opacity-40" aria-label={`Excluir ${selectedDocument.title}`} title="Excluir PDF"><Trash2 size={17} /></button>}</span></header>{selectedDocument?.securityReviewRequired && <div className="flex items-center gap-2 border-b border-amber-300/20 bg-amber-300/10 px-4 py-2 text-xs font-bold text-amber-100"><ShieldCheck size={14} /> Arquivo importado em visualizacao isolada; revisao de seguranca pendente.</div>}<div className="relative grid min-h-[62dvh] place-items-center overflow-auto bg-[radial-gradient(circle_at_top,#27354b,#0f172a_65%)] p-4">{previewLoading ? <LoadingState label="Preparando visualizacao..." /> : !previewUrl ? <div className="text-center text-slate-400"><FileText className="mx-auto" size={44} /><p className="mt-3 text-sm font-bold">Selecione um PDF para visualizar.</p></div> : selectedDocument?.mimeType.startsWith("image/") ? <img src={previewUrl} alt={selectedDocument.title} className="max-h-[58dvh] max-w-full rounded bg-white object-contain shadow-2xl" /> : <div className="relative h-[62dvh] w-full max-w-4xl overflow-hidden rounded bg-white shadow-2xl"><iframe title={`Visualizacao de ${selectedDocument?.title}`} src={previewUrl} className="h-full w-full" /></div>}</div></article>

            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]"><h3 className="font-black">{operation === "edit_pdf" ? "Editor visual" : "Configurar resultado"}</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">A visualizacao permanece ao centro durante a configuracao.</p><div className="mt-5 space-y-4" hidden={operation === "edit_pdf"}>{["split", "reorder", "delete_pages", "rotate"].includes(operation) && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Paginas<input value={pages} onChange={(event) => setPages(event.target.value)} placeholder="Vazio = todas; ex.: 1,3,4" className="commercial-field mt-2" /></label>}{operation === "watermark" && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Texto<input value={text} onChange={(event) => setText(event.target.value)} className="commercial-field mt-2" /></label>}{operation === "rotate" && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Rotacao<select value={degrees} onChange={(event) => setDegrees(Number(event.target.value))} className="commercial-field mt-2"><option value={90}>90 graus</option><option value={180}>180 graus</option><option value={270}>270 graus</option><option value={-90}>-90 graus</option></select></label>}{["add_password", "remove_password"].includes(operation) && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Senha autorizada<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="commercial-field mt-2" /></label>}</div><div className="mt-6 border-t border-[var(--border)] pt-4"><div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs font-semibold leading-5 text-[var(--text-secondary)]"><strong className="text-cyan-200">Motor:</strong> {capabilities?.operations.find((item) => item.id === operation)?.engine === "native" ? "Norium nativo" : "Stirling privado"}. O original permanece preservado e o resultado sera salvo como novo documento.</div><Button className="mt-4 w-full" loading={busy || processing} disabled={!validSelection || (operation === "edit_pdf" && !previewBlob) || ((operation === "add_password" && password.length < 8) || (operation === "remove_password" && !password.length))} onClick={() => operation === "edit_pdf" ? setEditorOpen(true) : void process()} icon={<Wrench size={15} />}>{operation === "edit_pdf" ? "Abrir editor de PDF" : `Processar ${meta?.title}`}</Button></div></aside>
          </section>
        )}
      </div>
    </main>
  );
}
