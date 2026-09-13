import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
export type TextBox = { text: string; x: number; y: number; width: number; height: number; fontSize: number };
export default function PdfPageCanvas({ pdf, page, rotation = 0, width, onSize, onText, onError }: {
  pdf: PDFDocumentProxy; page: number; rotation?: number; width: number;
  onSize?: (size: { width: number; height: number }) => void;
  onText?: (boxes: TextBox[]) => void; onError?: (message: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stopped = false; let cancel: (() => void) | undefined;
    void pdf.getPage(page + 1).then(async (documentPage) => {
      if (stopped || !ref.current) return;
      const base = documentPage.getViewport({ scale: 1, rotation: (documentPage.rotate + rotation) % 360 });
      onSize?.({ width: base.width, height: base.height });
      const canvas = ref.current, viewport = documentPage.getViewport({ scale: width / base.width, rotation: (documentPage.rotate + rotation) % 360 });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(viewport.width * ratio); canvas.height = Math.round(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      const task = documentPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }); cancel = () => task.cancel();
      await task.promise;
      if (onText) {
        const content = await documentPage.getTextContent();
        const { Util } = await import("pdfjs-dist");
        if (!stopped) onText(content.items.flatMap(item => {
          if (!("str" in item) || !item.str.trim()) return [];
          const matrix = Util.transform(base.transform, item.transform), size = Math.hypot(matrix[2], matrix[3]);
          return [{ text: item.str, x: matrix[4] / base.width, y: (matrix[5] - size * .85) / base.height, width: item.width / base.width, height: size * 1.2 / base.height, fontSize: size }];
        }));
      }
    }).catch((error: Error) => { if (!stopped && error.name !== "RenderingCancelledException") onError?.("Não foi possível renderizar esta página."); });
    return () => { stopped = true; cancel?.(); };
  }, [pdf, page, rotation, width, onSize, onText, onError]);
  return <canvas ref={ref} className="pdf-page-canvas" aria-label={`Página ${page + 1} do PDF`}/>;
}
