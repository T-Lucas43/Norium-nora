import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, Download, Eye, File, FileImage, FilePenLine, FileText, Library, Loader2, X } from "lucide-react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import { apiBaseUrl } from "../../core/api/config";

export type NoraChatFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl: string;
  downloadUrl: string;
  source?: string;
  createdAt?: string;
  inLibrary?: boolean;
  editTarget?: {
    tab: string;
    entityType: string;
    entityId: string;
    label?: string;
  };
};

function readableSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "Arquivo";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function fileKind(file: NoraChatFile) {
  if (file.mimeType === "application/pdf") return "PDF";
  if (file.mimeType.startsWith("image/")) return "Imagem";
  if (file.mimeType.startsWith("audio/")) return "Áudio";
  if (file.mimeType.startsWith("video/")) return "Vídeo";
  if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") return "Texto";
  return "Documento";
}

function canPreview(file: NoraChatFile) {
  return file.mimeType === "application/pdf"
    || file.mimeType.startsWith("image/")
    || file.mimeType.startsWith("audio/")
    || file.mimeType.startsWith("video/")
    || file.mimeType.startsWith("text/")
    || file.mimeType === "application/json";
}

function authenticatedPath(value: string) {
  if (!/^https?:\/\//i.test(value)) return value;
  const fileUrl = new URL(value);
  const backendUrl = new URL(apiBaseUrl(), window.location.origin);
  if (fileUrl.origin !== backendUrl.origin) throw new Error("Origem de arquivo não autorizada.");
  return `${fileUrl.pathname}${fileUrl.search}`;
}

function FileIcon({ file }: { file: NoraChatFile }) {
  if (file.mimeType.startsWith("image/")) return <FileImage size={20} />;
  if (file.mimeType === "application/pdf" || file.mimeType.startsWith("text/")) return <FileText size={20} />;
  return <File size={20} />;
}

export function NoraFileCards({ files, compact = false, onLibraryChange }: { files: NoraChatFile[]; compact?: boolean; onLibraryChange?: (file: NoraChatFile) => void }) {
  const [preview, setPreview] = useState<NoraChatFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [libraryState, setLibraryState] = useState<Record<string, boolean>>({});
  const [libraryBusy, setLibraryBusy] = useState("");

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    const syncLibrary = (event: Event) => {
      const file = (event as CustomEvent<NoraChatFile>).detail;
      if (file?.id) setLibraryState((state) => ({ ...state, [file.id]: Boolean(file.inLibrary) }));
    };
    window.addEventListener("nora:file-library-changed", syncLibrary);
    return () => window.removeEventListener("nora:file-library-changed", syncLibrary);
  }, []);

  async function openPreview(file: NoraChatFile) {
    setPreview(file);
    setPreviewUrl("");
    setPreviewText("");
    setError("");
    setLoading(true);
    try {
      const blob = await apiBlobRequest(authenticatedPath(file.previewUrl), { headers: { Accept: file.mimeType || "*/*" } });
      if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
        setPreviewText(await blob.text());
      } else {
        setPreviewUrl(URL.createObjectURL(blob));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível abrir o arquivo.");
    } finally {
      setLoading(false);
    }
  }

  async function download(file: NoraChatFile) {
    setError("");
    try {
      const blob = await apiBlobRequest(authenticatedPath(file.downloadUrl), { headers: { Accept: file.mimeType || "*/*" } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível baixar o arquivo.");
    }
  }

  async function toggleLibrary(file: NoraChatFile) {
    const current = libraryState[file.id] ?? Boolean(file.inLibrary);
    setLibraryBusy(file.id);
    setError("");
    try {
      const response = await apiRequest<{ file: NoraChatFile }>(`/api/nora/files/${encodeURIComponent(file.id)}/library`, {
        method: "PATCH",
        body: JSON.stringify({ inLibrary: !current }),
      });
      setLibraryState((state) => ({ ...state, [file.id]: Boolean(response.file.inLibrary) }));
      onLibraryChange?.(response.file);
      window.dispatchEvent(new CustomEvent("nora:file-library-changed", { detail: response.file }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível atualizar a biblioteca.");
    } finally {
      setLibraryBusy("");
    }
  }

  function editDocument(file: NoraChatFile) {
    if (!file.editTarget) return;
    window.localStorage.setItem("norium-deep-link", JSON.stringify(file.editTarget));
    window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: file.editTarget }));
  }

  if (!files.length) return null;
  return (
    <>
      <div className={`nora-file-grid ${compact ? "is-compact" : ""}`} aria-label="Arquivos desta mensagem">
        {files.map((file) => (
          <article key={`${file.id}-${file.name}`} className="nora-file-card">
            <span className="nora-file-icon"><FileIcon file={file} /></span>
            <span className="nora-file-copy">
              <strong title={file.name}>{file.name}</strong>
              <small>{fileKind(file)} · {readableSize(file.size)}</small>
            </span>
            <span className="nora-file-actions">
              {file.editTarget && <button type="button" onClick={() => editDocument(file)} title={file.editTarget.label || `Editar ${file.name}`} aria-label={`${file.editTarget.label || "Editar no Documentos"}: ${file.name}`}><FilePenLine size={15} /><span>Editar</span></button>}
              {canPreview(file) && <button type="button" onClick={() => void openPreview(file)} title={`Visualizar ${file.name}`} aria-label={`Visualizar ${file.name}`}><Eye size={15} /><span>Visualizar</span></button>}
              <button type="button" className={(libraryState[file.id] ?? file.inLibrary) ? "is-saved" : ""} disabled={libraryBusy === file.id} onClick={() => void toggleLibrary(file)} title={`${(libraryState[file.id] ?? file.inLibrary) ? "Remover da" : "Adicionar à"} biblioteca`} aria-label={`${(libraryState[file.id] ?? file.inLibrary) ? "Remover da" : "Adicionar à"} biblioteca: ${file.name}`}>
                {libraryBusy === file.id ? <Loader2 className="animate-spin" size={15} /> : <Bookmark size={15} fill={(libraryState[file.id] ?? file.inLibrary) ? "currentColor" : "none"} />}<span>{(libraryState[file.id] ?? file.inLibrary) ? "Salvo" : "Biblioteca"}</span>
              </button>
              <button type="button" onClick={() => void download(file)} title={`Baixar ${file.name}`} aria-label={`Baixar ${file.name}`}><Download size={15} /><span>Baixar</span></button>
            </span>
          </article>
        ))}
        {error && <p className="nora-file-error">{error}</p>}
      </div>
      {preview && createPortal(
        <div className="nora-file-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Visualização de ${preview.name}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setPreview(null); }}>
          <section className="nora-file-preview">
            <header><div><strong>{preview.name}</strong><small>{fileKind(preview)} · {readableSize(preview.size)}</small></div><button type="button" onClick={() => setPreview(null)} aria-label="Fechar visualização"><X size={19} /></button></header>
            <div className="nora-file-preview-body">
              {loading && <span className="nora-file-loading"><Loader2 size={22} className="animate-spin" /> Abrindo arquivo...</span>}
              {!loading && error && <p className="nora-file-preview-error">{error}</p>}
              {!loading && !error && previewText && <pre>{previewText}</pre>}
              {!loading && !error && previewUrl && preview.mimeType === "application/pdf" && <iframe title={preview.name} src={previewUrl} />}
              {!loading && !error && previewUrl && preview.mimeType.startsWith("image/") && <img src={previewUrl} alt={preview.name} />}
              {!loading && !error && previewUrl && preview.mimeType.startsWith("audio/") && <audio src={previewUrl} controls autoPlay />}
              {!loading && !error && previewUrl && preview.mimeType.startsWith("video/") && <video src={previewUrl} controls autoPlay />}
            </div>
            <footer>{preview.editTarget && <button type="button" onClick={() => editDocument(preview)}><FilePenLine size={16} /> Editar no Documentos</button>}<button type="button" onClick={() => void download(preview)}><Download size={16} /> Baixar arquivo</button></footer>
          </section>
        </div>
      , document.body)}
    </>
  );
}

export function NoraFileLibrary({ query = "", onCountChange }: { query?: string; onCountChange?: (count: number) => void }) {
  const [files, setFiles] = useState<NoraChatFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest<{ files: NoraChatFile[]; total: number }>("/api/nora/files/library");
      setFiles(response.files);
      onCountChange?.(response.total);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível carregar os arquivos.");
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void loadLibrary();
    const refresh = () => void loadLibrary();
    window.addEventListener("nora:file-library-changed", refresh);
    return () => window.removeEventListener("nora:file-library-changed", refresh);
  }, [loadLibrary]);

  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  const visible = normalized ? files.filter((file) => file.name.toLocaleLowerCase("pt-BR").includes(normalized)) : files;
  if (loading) return <div className="nora-library-files-state"><Loader2 className="animate-spin" size={17} /> Carregando arquivos...</div>;
  if (error) return <div className="nora-library-files-state is-error">{error}<button type="button" onClick={() => void loadLibrary()}>Tentar novamente</button></div>;
  if (!visible.length) return <div className="nora-library-files-state"><Library size={22} /><strong>{query ? "Nenhum arquivo encontrado" : "Nenhum arquivo salvo"}</strong><span>{query ? "Tente buscar por outro nome." : "Nos PDFs do chat, use Biblioteca para guardar aqui."}</span></div>;
  return <section className="nora-library-files" aria-label="Arquivos da biblioteca"><div className="nora-library-files-heading"><span>Arquivos</span><strong>{visible.length}</strong></div><NoraFileCards files={visible} compact onLibraryChange={(updated) => {
    if (!updated.inLibrary) {
      setFiles((items) => items.filter((item) => item.id !== updated.id));
      onCountChange?.(Math.max(0, files.length - 1));
    }
  }} /></section>;
}
