import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { PdfPreviewBinaryData, pdfPreviewBytes } from "./pdfPreviewData";
import PdfPageCanvas from "./PdfPageCanvas";
import Button from "../shared/Button";
import "./proposalFiles.css";

export default function PdfDocumentPreview({ url, blob, title }: { url?: string; blob?: Blob; title: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, destroy: (() => void) | undefined;
    const controller = new AbortController();
    setPdf(null); setPage(0); setError("");
    void (async () => {
      const engine = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&url");
      if (!active) return;
      engine.GlobalWorkerOptions.workerSrc = worker.default;
      const data = await pdfPreviewBytes(blob, url, controller.signal);
      if (!active) return;
      const task = engine.getDocument({ data, BinaryDataFactory: PdfPreviewBinaryData, useWorkerFetch: false, useSystemFonts: false });
      destroy = () => { void task.destroy(); };
      const loaded = await task.promise;
      if (active) setPdf(loaded);
    })().catch((reason) => { if (active) setError(reason instanceof Error && reason.name === "PasswordException" ? "Este PDF está protegido por senha. Desbloqueie o arquivo para visualizar." : "Não foi possível abrir a prévia deste PDF. Tente novamente."); });
    return () => { active = false; controller.abort(); destroy?.(); };
  }, [url, blob, retry]);
  return <section aria-label={`Visualização de ${title}`} className="pdf-document-preview">
    {error ? <div className="space-y-3 p-6 text-center"><p role="alert">{error}</p><Button onClick={() => setRetry(value => value + 1)}><RefreshCw size={15}/>Tentar visualizar novamente</Button></div> : pdf ? <><div className="pdf-preview-navigation"><Button size="sm" variant="ghost" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(value => value - 1)} icon={<ChevronLeft size={15}/>}/><span>Página {page + 1} de {pdf.numPages}</span><Button size="sm" variant="ghost" aria-label="Próxima página" disabled={page + 1 === pdf.numPages} onClick={() => setPage(value => value + 1)} icon={<ChevronRight size={15}/>}/></div><div className="pdf-preview-paper"><PdfPageCanvas pdf={pdf} page={page} width={760} onError={setError}/></div></> : <p role="status">Preparando visualização do PDF…</p>}
  </section>;
}
