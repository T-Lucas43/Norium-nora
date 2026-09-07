import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PdfPageCanvas from "./PdfPageCanvas";
import Button from "../shared/Button";

export default function PdfDocumentPreview({ url, title }: { url: string; title: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, destroy: (() => void) | undefined;
    setPdf(null); setPage(0); setError("");
    void (async () => {
      const engine = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      if (!active) return;
      engine.GlobalWorkerOptions.workerSrc = worker.default;
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      if (!active) return;
      const task = engine.getDocument({ data });
      destroy = () => { void task.destroy(); };
      const loaded = await task.promise;
      if (active) setPdf(loaded);
    })().catch(() => { if (active) setError("Não foi possível visualizar o PDF. Você ainda pode baixá-lo."); });
    return () => { active = false; destroy?.(); };
  }, [url]);
  return <section aria-label={`Visualização de ${title}`} className="pdf-document-preview">
    {error ? <p role="alert">{error}</p> : pdf ? <><div className="pdf-preview-navigation"><Button size="sm" variant="ghost" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(value => value - 1)} icon={<ChevronLeft size={15}/>}/><span>Página {page + 1} de {pdf.numPages}</span><Button size="sm" variant="ghost" aria-label="Próxima página" disabled={page + 1 === pdf.numPages} onClick={() => setPage(value => value + 1)} icon={<ChevronRight size={15}/>}/></div><div className="pdf-preview-paper"><PdfPageCanvas pdf={pdf} page={page} width={760} onError={setError}/></div></> : <p role={error ? "alert" : "status"}>{error || "Preparando visualização do PDF…"}</p>}
  </section>;
}
