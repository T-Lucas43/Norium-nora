import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, File, FileImage, FileText, Loader2, X } from "lucide-react";
import { apiBlobRequest } from "../../core/api/client";
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

export function NoraFileCards({ files }: { files: NoraChatFile[] }) {
  const [preview, setPreview] = useState<NoraChatFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

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

  if (!files.length) return null;
  return (
    <>
      <div className="nora-file-grid" aria-label="Arquivos desta mensagem">
        {files.map((file) => (
          <article key={`${file.id}-${file.name}`} className="nora-file-card">
            <span className="nora-file-icon"><FileIcon file={file} /></span>
            <span className="nora-file-copy">
              <strong title={file.name}>{file.name}</strong>
              <small>{fileKind(file)} · {readableSize(file.size)}</small>
            </span>
            <span className="nora-file-actions">
              {canPreview(file) && <button type="button" onClick={() => void openPreview(file)} title={`Visualizar ${file.name}`} aria-label={`Visualizar ${file.name}`}><Eye size={15} /><span>Visualizar</span></button>}
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
            <footer><button type="button" onClick={() => void download(preview)}><Download size={16} /> Baixar arquivo</button></footer>
          </section>
        </div>
      , document.body)}
    </>
  );
}
