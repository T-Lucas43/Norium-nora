export const MAX_CHAT_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_COUNT = 8;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 24 * 1024 * 1024;

function dataUrlFor(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Não foi possível ler ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function optimizedImageName(name: string) {
  const stem = name.replace(/\.[^.]+$/, "") || "imagem";
  return `${stem}.webp`;
}

async function optimizeLargeImage(file: File) {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || file.type === "image/gif" || file.size < 4 * 1024 * 1024) return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const maxDimension = 2560;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.84));
    return blob && blob.size > 0 && blob.size < file.size
      ? new File([blob], optimizedImageName(file.name), { type: "image/webp", lastModified: file.lastModified })
      : file;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

export async function prepareChatAttachments(files: File[]) {
  if (files.length > MAX_CHAT_ATTACHMENT_COUNT) throw new Error(`Envie no máximo ${MAX_CHAT_ATTACHMENT_COUNT} arquivos por mensagem.`);
  const optimized = await Promise.all(files.map(optimizeLargeImage));
  const oversized = optimized.find((file) => file.size > MAX_CHAT_ATTACHMENT_BYTES);
  if (oversized) throw new Error(`${oversized.name} ultrapassa 12 MB. Escolha uma imagem menor.`);
  const totalBytes = optimized.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) throw new Error("Os anexos desta mensagem ultrapassam o limite total de 24 MB.");
  return Promise.all(optimized.map(async (file) => ({
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    dataUrl: await dataUrlFor(file),
  })));
}
