export type PdfLayerType = "text" | "image" | "signature" | "rectangle" | "ellipse" | "highlight" | "draw" | "cover";
export type PdfLayer = {
  id: string; type: PdfLayerType; page: number; x: number; y: number; width: number; height: number;
  text: string; color: string; fill: string; opacity: number; fontSize: number;
  fontFamily: "Helvetica" | "Times" | "Courier"; bold: boolean; italic: boolean;
  strokeWidth: number; dataUrl: string; points: Array<{ x: number; y: number }>;
};
export type PdfEdits = { layers: PdfLayer[]; pages: Array<{ source: number; rotation: 0 | 90 | 180 | 270 }> };
export const emptyEdits = (): PdfEdits => ({ layers: [], pages: [] });
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function newLayer(type: PdfLayerType, page: number, patch: Partial<PdfLayer> = {}): PdfLayer {
  return { id: crypto.randomUUID(), type, page, x: .12, y: .2, width: .36, height: .065,
    text: "Novo texto", color: type === "highlight" ? "#facc15" : "#171717", fill: "#ffffff",
    opacity: type === "highlight" ? .35 : 1, fontSize: 18, fontFamily: "Helvetica", bold: false, italic: false,
    strokeWidth: 2, dataUrl: "", points: [], ...patch };
}
export function moveLayer(layer: PdfLayer, dx: number, dy: number): PdfLayer {
  return { ...layer, x: clamp(layer.x + dx, 0, 1 - layer.width), y: clamp(layer.y + dy, 0, 1 - layer.height) };
}
export function resizeLayer(layer: PdfLayer, dx: number, dy: number): PdfLayer {
  let width = clamp(layer.width + dx, .015, 1 - layer.x);
  let height = clamp(layer.height + dy, .012, 1 - layer.y);
  if (["image", "signature"].includes(layer.type)) {
    const ratio = layer.height / layer.width;
    width = Math.min(width, (1 - layer.y) / ratio);
    height = width * ratio;
  }
  return { ...layer, width, height };
}
export async function imageData(file: File): Promise<{ dataUrl: string; ratio: number }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error("Selecione uma imagem PNG, JPG ou WebP de até 12 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > 1_500_000) throw new Error("A imagem é muito detalhada. Use uma versão menor.");
    return { dataUrl, ratio: bitmap.height / bitmap.width };
  } finally { bitmap.close(); }
}
