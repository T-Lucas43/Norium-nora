import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "norium:whatsapp:wallpaper:v1";
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_DATA_URL_LENGTH = 2_600_000;
const MAX_EDGE = 1920;
const SAFE_RASTER_DATA_URL = /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\r\n]+$/i;
const SAFE_RASTER_MIME = /^image\/(?:avif|gif|jpe?g|png|webp)$/i;

export interface ChatWallpaperPreference {
  dataUrl: string;
  fileName: string;
  updatedAt: number;
}

export function chatWallpaperStorageKey(userId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId || "primary")}`;
}

export function readChatWallpaper(userId: string): ChatWallpaperPreference | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(chatWallpaperStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatWallpaperPreference>;
    if (!parsed.dataUrl || !SAFE_RASTER_DATA_URL.test(parsed.dataUrl)) return null;
    return {
      dataUrl: parsed.dataUrl,
      fileName: String(parsed.fileName || "Imagem personalizada"),
      updatedAt: Number(parsed.updatedAt || Date.now()),
    };
  } catch {
    return null;
  }
}

export function persistChatWallpaper(userId: string, preference: ChatWallpaperPreference) {
  window.localStorage.setItem(chatWallpaperStorageKey(userId), JSON.stringify(preference));
}

export function removeChatWallpaper(userId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(chatWallpaperStorageKey(userId));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem selecionada."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("O arquivo selecionado não é uma imagem válida."));
    image.src = dataUrl;
  });
}

function renderCompressedImage(image: HTMLImageElement, edge: number, quality: number) {
  const ratio = Math.min(1, edge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Seu navegador não conseguiu preparar a imagem.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

export async function prepareChatWallpaper(file: File): Promise<ChatWallpaperPreference> {
  if (!SAFE_RASTER_MIME.test(file.type)) {
    throw new Error("Escolha uma imagem JPG, PNG, WebP, GIF ou AVIF da galeria.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("A imagem deve ter no máximo 20 MB.");
  }

  const original = await readFileAsDataUrl(file);
  let dataUrl = original;
  if (dataUrl.length > MAX_STORED_DATA_URL_LENGTH) {
    const image = await loadImage(original);
    const attempts = [
      [MAX_EDGE, 0.82],
      [1600, 0.74],
      [1280, 0.68],
      [1024, 0.62],
    ] as const;
    for (const [edge, quality] of attempts) {
      dataUrl = renderCompressedImage(image, edge, quality);
      if (dataUrl.length <= MAX_STORED_DATA_URL_LENGTH) break;
    }
  }

  if (!SAFE_RASTER_DATA_URL.test(dataUrl) || dataUrl.length > MAX_STORED_DATA_URL_LENGTH) {
    throw new Error("A imagem ficou grande demais para ser salva. Escolha uma imagem menor.");
  }

  return { dataUrl, fileName: file.name || "Imagem personalizada", updatedAt: Date.now() };
}

export function useChatWallpaper(userId: string) {
  const [preference, setPreference] = useState<ChatWallpaperPreference | null>(() => readChatWallpaper(userId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeUserIdRef = useRef(userId);
  const operationIdRef = useRef(0);
  activeUserIdRef.current = userId;

  useEffect(() => {
    operationIdRef.current += 1;
    setPreference(readChatWallpaper(userId));
    setSaving(false);
    setError(null);
  }, [userId]);

  useEffect(() => {
    const key = chatWallpaperStorageKey(userId);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) setPreference(readChatWallpaper(userId));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [userId]);

  const selectFile = useCallback(async (file: File) => {
    const requestedUserId = userId;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    const isCurrentOperation = () => activeUserIdRef.current === requestedUserId && operationIdRef.current === operationId;
    setSaving(true);
    setError(null);
    try {
      const next = await prepareChatWallpaper(file);
      if (!isCurrentOperation()) {
        throw new DOMException("Seleção de imagem cancelada após a troca de usuário.", "AbortError");
      }
      persistChatWallpaper(userId, next);
      setPreference(next);
      return next;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      const message = cause instanceof DOMException && cause.name === "QuotaExceededError"
        ? "O navegador está sem espaço para salvar esta imagem. Escolha uma imagem menor."
        : cause instanceof Error ? cause.message : "Não foi possível salvar a imagem.";
      if (isCurrentOperation()) setError(message);
      throw new Error(message);
    } finally {
      if (isCurrentOperation()) setSaving(false);
    }
  }, [userId]);

  const restoreDefault = useCallback(() => {
    removeChatWallpaper(userId);
    setPreference(null);
    setError(null);
  }, [userId]);

  return { preference, saving, error, selectFile, restoreDefault };
}
