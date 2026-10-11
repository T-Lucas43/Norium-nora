import "../shared/workspace.css";
import "../../styles/screens/trabalho-comum.css";
import "../../styles/screens/documentos.css";
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
  split: { title: "Separar PDF", description: "Extraia páginas em arquivos independentes.", category: "Organizar", icon: Split, accent: "from-violet-500 to-fuchsia-400" },
  reorder: { title: "Organizar páginas", description: "Defina uma nova ordem para as páginas.", category: "Organizar", icon: Layers3, accent: "from-indigo-500 to-blue-400" },
  delete_pages: { title: "Excluir páginas", description: "Remova páginas selecionadas com segurança.", category: "Organizar", icon: Trash2, accent: "from-rose-500 to-orange-400" },
  rotate: { title: "Girar PDF", description: "Corrija a orientação de uma ou mais páginas.", category: "Organizar", icon: RotateCw, accent: "from-cyan-500 to-blue-400" },
  compress: { title: "Comprimir PDF", description: "Reduza o tamanho preservando a leitura.", category: "Otimizar", icon: Minimize2, accent: "from-emerald-500 to-cyan-400" },
  remove_metadata: { title: "Limpar metadados", description: "Remova propriedades ocultas do documento.", category: "Otimizar", icon: ShieldCheck, accent: "from-slate-500 to-cyan-400" },
  sanitize: { title: "Sanitizar PDF", description: "Reconstrua o arquivo em uma cópia controlada.", category: "Otimizar", icon: RefreshCw, accent: "from-teal-500 to-emerald-400" },
  images_to_pdf: { title: "Imagens para PDF", description: "Converta JPG, PNG ou WebP em PDF.", category: "Converter", icon: ImagePlus, accent: "from-amber-500 to-orange-400" },
  extract_text: { title: "PDF para texto", description: "Extraia o texto para um arquivo editável.", category: "Converter", icon: FileText, accent: "from-sky-500 to-blue-400" },
  ocr: { title: "OCR", description: "Transforme digitalizações em texto pesquisável.", category: "Converter", icon: FileSearch, accent: "from-purple-500 to-indigo-400" },
  edit_pdf: { title: "Editar PDF", description: "Edite texto, assine, desenhe e organize as páginas visualmente.", category: "Editar", icon: Pencil, accent: "from-blue-600 to-violet-500" },
  watermark: { title: "Marca d'água", description: "Aplique texto com opacidade e rotação.", category: "Editar", icon: Highlighter, accent: "from-fuchsia-500 to-rose-400" },
  page_numbers: { title: "Numerar páginas", description: "Inclua numeração consistente no rodapé.", category: "Editar", icon: ListFilter, accent: "from-cyan-500 to-indigo-400" },
  add_password: { title: "Proteger PDF", description: "Criptografe o documento com uma senha.", category: "Seguranca", icon: LockKeyhole, accent: "from-emerald-600 to-teal-400" },
  remove_password: { title: "Desbloquear PDF", description: "Remova uma senha que você está autorizado a usar.", category: "Seguranca", icon: UnlockKeyhole, accent: "from-amber-500 to-yellow-300" },
  compare: { title: "Comparar PDFs", description: "Gere um relatório das diferenças textuais.", category: "Inteligencia", icon: Files, accent: "from-violet-600 to-blue-500" },
};

const categories = ["Todos", "Organizar", "Otimizar", "Converter", "Editar", "Seguranca", "Inteligencia"] as const;
const categoryLabels: Record<(typeof categories)[number], string> = { Todos: "Todos", Organizar: "Organizar", Otimizar: "Otimizar", Converter: "Converter", Editar: "Editar", Seguranca: "Segurança", Inteligencia: "Inteligência" };
const jobStatusLabels: Record<string, string> = { queued: "Na fila", processing: "Processando", completed: "Concluído", failed: "Falhou", cancelled: "Cancelado" };

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo selecionado."));
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
  const [dragging, setDragging] = useState(false);
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
      .catch(() => active && setError("Não foi possível abrir a visualização deste arquivo."))
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
    await importFileList(files);
  }

  async function importFileList(files: File[]) {
    if (!files.length) return;
    setImporting(true); setError(""); setMessage("");
    try {
      const imported: UploadedDocument[] = [];
      for (const file of files) {
        if (!["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          throw new Error(`Formato não permitido: ${file.name}`);
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
      setError(reason instanceof Error ? reason.message : "Não foi possível importar os arquivos.");
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

  if (!capabilities) return <main className="clean-workspace nxw-screen nxw-remap nx-page nxp-page min-h-[calc(100dvh-74px)]"><LoadingState label="Carregando o PDF Studio..." /></main>;

  const maxUploadMb = Math.round((capabilities.maxUploadBytes || 0) / 1024 ** 2);
  const toolGroups = categories.filter((item) => item !== "Todos").map((group) => ({ group, tools: availableTools.filter((tool) => toolMeta[tool.id].category === group) })).filter((entry) => entry.tools.length);

  return (
    <main className="clean-workspace nxw-screen nxw-remap nx-page nxp-page min-h-[calc(100dvh-74px)]">
      <input ref={fileInput} hidden multiple type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => void importFiles(event)} />
      <header className="nx-ph">
        <button type="button" className="nxw-icon-btn" onClick={onBack} aria-label="Voltar para Documentos" title="Voltar para Documentos"><ArrowLeft size={16} /></button>
        <div className="nx-grow"><h1>PDF Studio</h1><p>Ferramentas para organizar, converter e proteger PDFs</p></div>
        <div className="nx-ph-actions">
          {operation && <Button variant="ghost" onClick={() => { setOperation(null); setSelectedIds([]); }}>Todas as ferramentas</Button>}
          <Button variant="secondary" onClick={() => fileInput.current?.click()} loading={importing} icon={<Upload size={15} />}>Selecionar arquivos</Button>
          {!operation && <Button variant="primary" onClick={() => chooseTool("edit_pdf")} icon={<Pencil size={15} />}>Abrir editor</Button>}
        </div>
      </header>

      {error && <StatusBanner tone="error">{error}</StatusBanner>}
      {message && <StatusBanner tone="success">{message}</StatusBanner>}
      {activeJob && <div role="status" className="nx-card nxp-job"><strong>{processing ? "Preparando seu arquivo…" : activeJob.status === "completed" ? "Processamento concluído" : "Processamento interrompido"}</strong><p className="nx-muted nx-small" style={{ margin: "4px 0 0" }}>{activeJob.message}</p>{processing && <div className="nx-bar" style={{ marginTop: 10 }}><i style={{ width: `${activeJob.progress}%` }} /></div>}</div>}
      {resultDocuments.map(document => <PdfResult key={document.id} document={document}/>)}
      {!operation ? (
        <>
          <section className="nxp-filters" aria-label="Navegação das ferramentas PDF">
            <label className="nx-input nxp-search"><Search size={15} className="nx-faint" /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar entre edição, organização, OCR e segurança" /><kbd className="nxp-kbd">Ctrl K</kbd></label>
            <div className="nx-seg nxp-seg">{categories.map((item) => {
              const count = item === "Todos" ? capabilities.operations.length : capabilities.operations.filter((tool) => toolMeta[tool.id].category === item).length;
              return <button key={item} type="button" aria-pressed={category === item} className={category === item ? "is-active" : ""} onClick={() => setCategory(item)}>{categoryLabels[item]} <span className="nx-faint">{count}</span></button>;
            })}</div>
            <span className={`nx-badge ${capabilities.stirling.available ? "is-green" : ""}`} title={capabilities.stirling.message}><ShieldCheck size={12} />{capabilities.stirling.available ? "Stirling privado conectado" : "Motor nativo ativo"}</span>
          </section>

          <div className="nxp-groups-meta nx-faint nx-small">{availableTools.length} ferramenta(s) · {capabilities.stirling.message}</div>
          <section className="nxp-groups">{toolGroups.map(({ group, tools }) => (
            <div key={group} className="nxp-group">
              <div className="nxp-group-title">{categoryLabels[group]}</div>
              <div className="nxp-group-list">{tools.map((tool) => { const item = toolMeta[tool.id]; const Icon = item.icon; const engine = capabilities.operations.find((candidate) => candidate.id === tool.id)?.engine; return <button key={tool.id} type="button" onClick={() => chooseTool(tool.id)} className="nx-card nxp-tool" title={item.description}><span className="nxw-icon is-sm"><Icon size={16} /></span><span className="nx-grow"><strong>{item.title}</strong><small>{item.description}</small><em>{engine === "stirling" ? "Stirling" : "Norium"}</em></span></button>; })}</div>
            </div>
          ))}</section>
          {!availableTools.length && <EmptyState title="Nenhuma ferramenta encontrada" description="Tente outra categoria ou termo de busca." icon={Search} className="min-h-64" />}

          <button type="button" className={`nx-card nxp-drop ${dragging ? "is-over" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void importFileList(Array.from(event.dataTransfer.files || [])); }} disabled={importing}>
            <Upload size={26} className="nx-faint" />
            <b>{importing ? "Importando arquivos..." : "Arraste PDFs aqui"}</b>
            <span className="nx-faint nx-small">ou clique para escolher · PDF, PNG, JPG ou WebP{maxUploadMb ? ` · até ${maxUploadMb} MB por arquivo` : ""}</span>
          </button>

          <section className="nxp-bottom">
            <article className="nx-card"><div className="nx-card-h"><h3>Processamentos recentes</h3><Sparkles size={16} className="nx-faint" style={{ marginLeft: "auto" }} /></div><div className="nx-card-b">{jobs.slice(0, 5).map((job) => <div key={job.id} className="nx-row"><span className="nx-grow"><span className="nx-row-t nx-ell" style={{ display: "block" }}>{job.label}</span><span className="nx-row-sub nx-ell" style={{ display: "block" }}>{job.message}</span></span><span className={`nx-badge ${job.status === "completed" ? "is-green" : job.status === "failed" || job.status === "cancelled" ? "is-red" : "is-amber"}`}>{jobStatusLabels[job.status] || job.status}</span>{job.status === "completed" && <Button size="sm" onClick={() => setActiveJobId(job.id)}>Ver</Button>}</div>)}{!jobs.length && <p className="nx-faint nx-small" style={{ margin: 0 }}>Nenhum processamento realizado.</p>}</div></article>
            <article className="nx-card nxp-privacy"><ShieldCheck size={18} className="nx-muted" /><h3>Privacidade por padrão</h3><p>O arquivo original é preservado. Cada resultado vira um novo documento e serviços externos só são usados quando uma instância privada autorizada confirma a operação.</p></article>
          </section>
        </>
      ) : (
        <section className="nxp-work">
          <aside className="nx-card nxp-side"><div className="nxp-side-h"><span className="nxw-icon">{SelectedToolIcon && <SelectedToolIcon size={16} />}</span><div><span className="nxp-eyebrow">{meta ? categoryLabels[meta.category] : ""}</span><h2>{meta?.title}</h2></div></div><p className="nx-muted nx-small" style={{ margin: "10px 0 0", lineHeight: 1.55 }}>{meta?.description}</p><div className="nxp-side-files"><div className="nxp-side-files-h"><h3>Arquivos</h3><button type="button" onClick={() => fileInput.current?.click()} className="nxp-link">+ Importar</button></div><div className="nxp-file-list">{compatibleDocuments.map((document) => { const checked = selectedIds.includes(document.id); return <div key={document.id} className={`nxp-file ${checked ? "is-checked" : ""}`}><label><input type={needsMany || operation === "images_to_pdf" ? "checkbox" : "radio"} checked={checked} name="pdf-studio-document" onChange={() => toggleDocument(document.id)} /><span className="nxw-icon is-sm is-red">{document.mimeType.startsWith("image/") ? <FileImage size={15} /> : <FileText size={15} />}</span><span className="nx-grow"><strong className="nx-ell" style={{ display: "block" }}>{document.title}</strong><small className="nx-faint">{fileSize(document.size)}</small></span></label><button type="button" disabled={busy} onClick={() => void removeDocument(document)} className="nxw-icon-btn is-sm is-plain nxp-danger" aria-label={`Excluir ${document.title}`} title="Excluir PDF"><Trash2 size={15} /></button></div>; })}{!compatibleDocuments.length && <p className="nx-faint nx-small" style={{ padding: "24px 0", textAlign: "center", margin: 0 }}>Importe um arquivo compatível.</p>}</div></div></aside>

          <article className="nx-card nxp-viewer"><header className="nxp-viewer-h"><span className="nx-grow"><strong className="nx-ell" style={{ display: "block" }}>{selectedDocument?.title || "Visualização do documento"}</strong><small className="nx-faint">{selectedDocument ? fileSize(selectedDocument.size) : "Selecione um arquivo ao lado"}</small></span><span style={{ display: "flex", gap: 4 }}>{previewUrl && <a href={previewUrl} download={selectedDocument?.originalFileName} className="nxw-icon-btn is-sm is-plain" aria-label="Baixar arquivo original"><Download size={16} /></a>}{selectedDocument && <button type="button" disabled={busy} onClick={() => void removeDocument(selectedDocument)} className="nxw-icon-btn is-sm is-plain nxp-danger" aria-label={`Excluir ${selectedDocument.title}`} title="Excluir PDF"><Trash2 size={16} /></button>}</span></header>{selectedDocument?.securityReviewRequired && <div className="nxw-alert is-warning nxp-flat-alert"><ShieldCheck size={14} /><span>Arquivo importado em visualização isolada; revisão de segurança pendente.</span></div>}<div className="nxp-viewer-b">{previewLoading ? <LoadingState label="Preparando visualização..." /> : !previewUrl ? <div className="nxw-empty"><FileText size={36} /><strong>Selecione um PDF para visualizar.</strong></div> : selectedDocument?.mimeType.startsWith("image/") ? <img src={previewUrl} alt={selectedDocument.title} className="nxp-image" /> : <div className="nxp-frame"><iframe title={`Visualizacao de ${selectedDocument?.title}`} src={previewUrl} /></div>}</div></article>

          <aside className="nx-card nxp-side"><h3 className="nxp-h3">{operation === "edit_pdf" ? "Editor visual" : "Configurar resultado"}</h3><p className="nx-muted nx-small" style={{ margin: "4px 0 0" }}>A visualização permanece ao centro durante a configuração.</p><div className="nxp-options" hidden={operation === "edit_pdf"}>{["split", "reorder", "delete_pages", "rotate"].includes(operation) && <label className="nxw-label">Páginas<input value={pages} onChange={(event) => setPages(event.target.value)} placeholder="Vazio = todas; ex.: 1,3,4" className="nxw-field" /></label>}{operation === "watermark" && <label className="nxw-label">Texto<input value={text} onChange={(event) => setText(event.target.value)} className="nxw-field" /></label>}{operation === "rotate" && <label className="nxw-label">Rotação<select value={degrees} onChange={(event) => setDegrees(Number(event.target.value))} className="nxw-field"><option value={90}>90 graus</option><option value={180}>180 graus</option><option value={270}>270 graus</option><option value={-90}>-90 graus</option></select></label>}{["add_password", "remove_password"].includes(operation) && <label className="nxw-label">Senha autorizada<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="nxw-field" /></label>}</div><div className="nxp-engine"><div className="nxw-action nx-small nx-muted" style={{ lineHeight: 1.55 }}><strong style={{ color: "var(--nx-text)" }}>Motor:</strong> {capabilities?.operations.find((item) => item.id === operation)?.engine === "native" ? "Norium nativo" : "Stirling privado"}. O original permanece preservado e o resultado será salvo como novo documento.</div><Button variant="primary" className="mt-4 w-full" loading={busy || processing} disabled={!validSelection || (operation === "edit_pdf" && !previewBlob) || ((operation === "add_password" && password.length < 8) || (operation === "remove_password" && !password.length))} onClick={() => operation === "edit_pdf" ? setEditorOpen(true) : void process()} icon={<Wrench size={15} />}>{operation === "edit_pdf" ? "Abrir editor de PDF" : `Processar ${meta?.title}`}</Button></div></aside>
        </section>
      )}
    </main>
  );
}
