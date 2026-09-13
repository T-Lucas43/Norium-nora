const fontAssets = import.meta.glob<string>("/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", { eager: true, import: "default", query: "?url&no-inline" });

/** PDF.js can load its bundled fonts without system-font or CDN dependencies. */
export class PdfPreviewBinaryData {
  private options: Record<string, string | undefined>;
  constructor(options: Record<string, string | undefined>) { this.options = options; }
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === "standardFontDataUrl" ? fontAssets[`/node_modules/pdfjs-dist/standard_fonts/${filename}`] : this.options[kind] ? `${this.options[kind]}${filename}` : undefined;
    if (!url) throw new Error("Recurso do PDF indisponível.");
    const response = await fetch(url);
    if (!response.ok) throw new Error("Não foi possível carregar os recursos do PDF.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function pdfPreviewBytes(blob?: Blob, url?: string, signal?: AbortSignal): Promise<Uint8Array> {
  // Read the already authenticated response directly; fetching blob: is blocked by production CSP.
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  if (!url || url.startsWith("blob:")) throw new Error("Reabra o arquivo para carregar a pré-visualização.");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Não foi possível carregar este PDF.");
  return new Uint8Array(await response.arrayBuffer());
}
