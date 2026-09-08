import { useEffect, useState } from "react";
import { CheckCircle2, Download, Eye, X } from "lucide-react";
import { downloadImportedDocument } from "../../features/commercial/api";
import type { UploadedDocument } from "../../features/commercial/types";
import Button from "../shared/Button";
import "./pdfVisualEditor.css";

export default function PdfResult({ document }: { document: UploadedDocument }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [view, setView] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, objectUrl = "";
    void downloadImportedDocument(document.id).then(async blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      if (document.mimeType.startsWith("text/")) { const content = await blob.text(); if (active) setText(content); }
    }).catch(() => { if (active) setError("Não foi possível carregar o resultado. Tente abrir a ferramenta novamente."); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [document.id, document.mimeType]);
  return <article className="pdf-result-card"><header><div><h3 className="flex items-center gap-2"><CheckCircle2 size={18} className="text-emerald-400"/>Arquivo pronto: {document.title}</h3><p>Salvo em Documentos e disponível nesta página.</p></div><div className="pdf-result-actions"><Button disabled={!url} onClick={() => setView(!view)} icon={view ? <X size={15}/> : <Eye size={15}/>}>{view ? "Fechar visualização" : "Visualizar resultado"}</Button>{url && <a href={url} download={document.originalFileName} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold"><Download size={15}/>Baixar arquivo</a>}</div></header>{error && <p role="alert">{error}</p>}{view && (document.mimeType === "application/pdf" ? <iframe title={`Resultado: ${document.title}`} src={url}/> : document.mimeType.startsWith("image/") ? <img src={url} alt={document.title}/> : <pre>{text}</pre>)}</article>;
}
