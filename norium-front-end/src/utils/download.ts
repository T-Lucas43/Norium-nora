import { apiBaseUrl, authToken } from "./api";

export function resolveApiFileUrl(url: string) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  return `${apiBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
}

function authorizationHeaders(explicitToken?: string) {
  const token = explicitToken || authToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function downloadWithAuth(url: string, fileName?: string, explicitToken?: string) {
  const response = await fetch(resolveApiFileUrl(url), { headers: authorizationHeaders(explicitToken) });
  if (!response.ok) {
    throw new Error("Nao foi possivel baixar o arquivo.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName || "arquivo";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 800);
}

export async function openWithAuth(url: string, explicitToken?: string) {
  const response = await fetch(resolveApiFileUrl(url), { headers: authorizationHeaders(explicitToken) });
  if (!response.ok) {
    throw new Error("Nao foi possivel abrir o arquivo.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
