import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeft, Combine, Download, FileImage, FileSearch, FileText, Files,
  Highlighter, ImagePlus, Layers3, ListFilter, LockKeyhole, Minimize2, Pencil,
  RefreshCw, RotateCw, Search, ShieldCheck, Sparkles, Split, Trash2,
  UnlockKeyhole, Upload, Wrench,
  type LucideIcon,
} from "lucide-react";
import { downloadImportedDocument, importDocument } from "../../features/commercial/api";
import type { PdfCapabilities, PdfOperation, PdfProcessingJob, UploadedDocument } from "../../features/commercial/types";
import Button from "../shared/Button";
import EmptyState from "../shared/EmptyState";
import LoadingState from "../shared/LoadingState";
import StatusBanner from "../shared/StatusBanner";

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
  edit_pdf: { title: "Editar PDF", description: "Adicione texto e ajuste posicao, cor e tamanho.", category: "Editar", icon: Pencil, accent: "from-blue-600 to-violet-500" },
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
  capabilities, documents, jobs, busy, onBack, onProcess, onImported,
}: {
  capabilities: PdfCapabilities | null;
  documents: UploadedDocument[];
  jobs: PdfProcessingJob[];
  busy: boolean;
  onBack: () => void;
  onProcess: (operation: PdfOperation, documentIds: string[], options: Record<string, unknown>) => void;
  onImported: (document: UploadedDocument) => void;
}) {
  const [operation, setOperation] = useState<PdfOperation | null>(null);
  const [category, setCategory] = useState<(typeof categories)[number]>("Todos");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [text, setText] = useState("Texto do documento");
  const [pages, setPages] = useState("");
  const [password, setPassword] = useState("");
  const [degrees, setDegrees] = useState(90);
  const [fontSize, setFontSize] = useState(18);
  const [color, setColor] = useState("#1266F1");
  const [xPercent, setXPercent] = useState(10);
  const [yPercent, setYPercent] = useState(12);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

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
  const validSelection = needsMany ? selectedIds.length >= 2 : operation === "images_to_pdf" ? selectedIds.length > 0 : selectedIds.length === 1;

  useEffect(() => {
    if (!selectedDocument) {
      setPreviewUrl("");
      return undefined;
    }
    let active = true;
    let objectUrl = "";
    setPreviewLoading(true);
    downloadImportedDocument(selectedDocument.id)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => active && setError("Nao foi possivel abrir a visualizacao deste arquivo."))
      .finally(() => active && setPreviewLoading(false));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDocument]);

  function chooseTool(value: PdfOperation) {
    setOperation(value);
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
      setSelectedIds(imported.map((item) => item.id));
      setMessage(`${imported.length} arquivo(s) importado(s) para o workspace.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nao foi possivel importar os arquivos.");
    } finally {
      setImporting(false);
    }
  }

  function process() {
    if (!operation || !validSelection) return;
    const options: Record<string, unknown> = {};
    if (["split", "reorder", "delete_pages", "rotate", "edit_pdf"].includes(operation) && pages.trim()) options.pages = pages.trim();
    if (["watermark", "edit_pdf"].includes(operation)) options.text = text.trim();
    if (["add_password", "remove_password"].includes(operation)) options.password = password;
    if (operation === "rotate") options.degrees = degrees;
    if (operation === "edit_pdf") Object.assign(options, { fontSize, color, xPercent, yPercent });
    onProcess(operation, selectedIds, options);
  }

  if (!capabilities) return <main className="min-h-[calc(100dvh-74px)] bg-[var(--background)] p-4 sm:p-6"><LoadingState label="Carregando o Norium PDF Studio..." /></main>;

  return (
    <main className="min-h-[calc(100dvh-74px)] bg-[var(--background)] text-[var(--text)]">
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
        {!operation ? (
          <>
            <section className="relative overflow-hidden rounded-3xl border border-blue-400/20 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,.28),transparent_42%),linear-gradient(135deg,rgba(15,23,42,.98),rgba(5,25,55,.95))] px-5 py-10 text-center shadow-2xl sm:px-8 sm:py-14">
              <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />
              <span className="inline-flex rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-xs font-black uppercase tracking-[.14em] text-cyan-100">Ferramentas PDF</span>
              <h2 className="mx-auto mt-4 max-w-4xl text-3xl font-black tracking-tight text-white sm:text-5xl">Tudo para trabalhar com PDFs, dentro do Norium</h2>
              <p className="mx-auto mt-4 max-w-2xl text-sm font-semibold leading-6 text-slate-300 sm:text-base">Organize, converta, proteja, visualize e edite sem sair do workspace da empresa.</p>
              <label className="mx-auto mt-7 flex h-12 max-w-xl items-center gap-3 rounded-2xl border border-white/15 bg-white/10 px-4 text-left shadow-xl backdrop-blur"><Search size={18} className="text-cyan-200" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar uma ferramenta PDF" className="min-w-0 flex-1 bg-transparent text-sm font-bold text-white outline-none placeholder:text-slate-400" /></label>
            </section>

            <nav className="mt-6 flex gap-2 overflow-x-auto pb-2">{categories.map((item) => <button key={item} onClick={() => setCategory(item)} className={`whitespace-nowrap rounded-full border px-4 py-2 text-xs font-black transition ${category === item ? "border-blue-400 bg-blue-500 text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-blue-400/40"}`}>{item}</button>)}</nav>

            <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{availableTools.map((tool) => { const item = toolMeta[tool.id]; const Icon = item.icon; return <button key={tool.id} onClick={() => chooseTool(tool.id)} className="group min-h-48 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-[var(--glass-shadow)] transition hover:-translate-y-1 hover:border-blue-400/40 hover:shadow-2xl"><span className={`grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br ${item.accent} text-white shadow-lg`}><Icon size={22} /></span><span className="mt-5 block text-xs font-black uppercase tracking-[.12em] text-blue-300">{item.category}</span><strong className="mt-1 block text-lg font-black">{item.title}</strong><span className="mt-2 block text-sm font-semibold leading-6 text-[var(--text-secondary)]">{item.description}</span><span className="mt-4 inline-flex items-center gap-1 text-xs font-black text-cyan-300 opacity-0 transition group-hover:opacity-100">Abrir ferramenta <ArrowLeft className="rotate-180" size={13} /></span></button>; })}</section>
            {!availableTools.length && <EmptyState title="Nenhuma ferramenta encontrada" description="Tente outra categoria ou termo de busca." icon={Search} className="mt-5 min-h-64" />}

            <section className="mt-8 grid gap-4 lg:grid-cols-[1.4fr_1fr]"><article className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex items-center justify-between"><div><h3 className="font-black">Processamentos recentes</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Resultados permanecem em Documentos.</p></div><Sparkles className="text-cyan-300" size={20} /></div><div className="mt-4 space-y-2">{jobs.slice(0, 5).map((job) => <div key={job.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><span className="min-w-0"><strong className="block truncate text-sm">{job.label}</strong><small className="text-[var(--text-secondary)]">{job.message}</small></span><span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-black text-blue-300">{job.status}</span></div>)}{!jobs.length && <p className="py-5 text-center text-sm font-semibold text-[var(--text-secondary)]">Nenhum processamento realizado.</p>}</div></article><article className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5"><ShieldCheck className="text-emerald-300" size={24} /><h3 className="mt-4 font-black">Arquivos privados</h3><p className="mt-2 text-sm font-semibold leading-6 text-[var(--text-secondary)]">As ferramentas nativas processam os documentos no backend do Norium. Operacoes externas aparecem somente quando um servico privado autorizado estiver configurado.</p></article></section>
          </>
        ) : (
          <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)_340px]">
            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]"><div className="flex items-center gap-3"><span className={`grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br ${meta?.accent} text-white`}>{SelectedToolIcon && <SelectedToolIcon size={20} />}</span><div><span className="text-xs font-black uppercase tracking-wide text-blue-300">{meta?.category}</span><h2 className="font-black">{meta?.title}</h2></div></div><p className="mt-3 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{meta?.description}</p><div className="mt-5 border-t border-[var(--border)] pt-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black uppercase text-[var(--text-secondary)]">Arquivos</h3><button onClick={() => fileInput.current?.click()} className="text-xs font-black text-cyan-300">+ Importar</button></div><div className="mt-3 max-h-[52dvh] space-y-2 overflow-auto">{compatibleDocuments.map((document) => { const checked = selectedIds.includes(document.id); return <label key={document.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${checked ? "border-blue-400/50 bg-blue-500/10" : "border-[var(--border)] bg-[var(--background)]"}`}><input type={needsMany || operation === "images_to_pdf" ? "checkbox" : "radio"} checked={checked} name="pdf-studio-document" onChange={() => toggleDocument(document.id)} /><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-300">{document.mimeType.startsWith("image/") ? <FileImage size={17} /> : <FileText size={17} />}</span><span className="min-w-0"><strong className="block truncate text-xs">{document.title}</strong><small className="text-[var(--text-secondary)]">{fileSize(document.size)}</small></span></label>; })}{!compatibleDocuments.length && <p className="py-8 text-center text-xs font-semibold text-[var(--text-secondary)]">Importe um arquivo compativel.</p>}</div></div></aside>

            <article className="min-h-[68dvh] overflow-hidden rounded-2xl border border-[var(--border)] bg-slate-950 shadow-2xl"><header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-4 py-3 text-white"><span className="min-w-0"><strong className="block truncate text-sm">{selectedDocument?.title || "Visualizacao do documento"}</strong><small className="text-slate-400">{selectedDocument ? fileSize(selectedDocument.size) : "Selecione um arquivo ao lado"}</small></span>{previewUrl && <a href={previewUrl} download={selectedDocument?.originalFileName} className="rounded-lg p-2 text-cyan-300 hover:bg-white/10" aria-label="Baixar arquivo original"><Download size={17} /></a>}</header>{selectedDocument?.securityReviewRequired && <div className="flex items-center gap-2 border-b border-amber-300/20 bg-amber-300/10 px-4 py-2 text-xs font-bold text-amber-100"><ShieldCheck size={14} /> Arquivo importado em visualizacao isolada; revisao de seguranca pendente.</div>}<div className="relative grid min-h-[62dvh] place-items-center overflow-auto bg-[radial-gradient(circle_at_top,#27354b,#0f172a_65%)] p-4">{previewLoading ? <LoadingState label="Preparando visualizacao..." /> : !previewUrl ? <div className="text-center text-slate-400"><FileText className="mx-auto" size={44} /><p className="mt-3 text-sm font-bold">Selecione um PDF para visualizar.</p></div> : selectedDocument?.mimeType.startsWith("image/") ? <img src={previewUrl} alt={selectedDocument.title} className="max-h-[58dvh] max-w-full rounded bg-white object-contain shadow-2xl" /> : <div className="relative h-[62dvh] w-full max-w-4xl overflow-hidden rounded bg-white shadow-2xl"><iframe sandbox="" title={`Visualizacao de ${selectedDocument?.title}`} src={previewUrl} className="h-full w-full" />{operation === "edit_pdf" && text && <span className="pointer-events-none absolute whitespace-nowrap font-medium" style={{ left: `${xPercent}%`, top: `${yPercent}%`, color, fontSize: `${Math.max(8, fontSize) * 0.72}px` }}>{text}</span>}</div>}</div></article>

            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--glass-shadow)]"><h3 className="font-black">Configurar resultado</h3><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">A visualizacao permanece ao centro durante a configuracao.</p><div className="mt-5 space-y-4">{["split", "reorder", "delete_pages", "rotate", "edit_pdf"].includes(operation) && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Paginas<input value={pages} onChange={(event) => setPages(event.target.value)} placeholder="Vazio = todas; ex.: 1,3,4" className="commercial-field mt-2" /></label>}{["watermark", "edit_pdf"].includes(operation) && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Texto<input value={text} onChange={(event) => setText(event.target.value)} className="commercial-field mt-2" /></label>}{operation === "rotate" && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Rotacao<select value={degrees} onChange={(event) => setDegrees(Number(event.target.value))} className="commercial-field mt-2"><option value={90}>90 graus</option><option value={180}>180 graus</option><option value={270}>270 graus</option><option value={-90}>-90 graus</option></select></label>}{["add_password", "remove_password"].includes(operation) && <label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Senha autorizada<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="commercial-field mt-2" /></label>}{operation === "edit_pdf" && <><div className="grid grid-cols-2 gap-3"><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Tamanho<input type="number" min={8} max={96} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} className="commercial-field mt-2" /></label><label className="text-xs font-black uppercase text-[var(--text-secondary)]">Cor<input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="commercial-field mt-2 p-1" /></label></div><label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Posicao horizontal: {xPercent}%<input type="range" min={2} max={90} value={xPercent} onChange={(event) => setXPercent(Number(event.target.value))} className="mt-2 w-full" /></label><label className="block text-xs font-black uppercase text-[var(--text-secondary)]">Posicao vertical: {yPercent}%<input type="range" min={2} max={90} value={yPercent} onChange={(event) => setYPercent(Number(event.target.value))} className="mt-2 w-full" /></label></>}</div><div className="mt-6 border-t border-[var(--border)] pt-4"><div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs font-semibold leading-5 text-[var(--text-secondary)]"><strong className="text-cyan-200">Motor:</strong> {capabilities?.operations.find((item) => item.id === operation)?.engine === "native" ? "Norium nativo" : "Stirling privado"}. O original permanece preservado e o resultado sera salvo como novo documento.</div><Button className="mt-4 w-full" loading={busy} disabled={!validSelection || (["add_password", "remove_password"].includes(operation) && password.length < 8)} onClick={process} icon={<Wrench size={15} />}>Processar {meta?.title}</Button></div></aside>
          </section>
        )}
      </div>
    </main>
  );
}
