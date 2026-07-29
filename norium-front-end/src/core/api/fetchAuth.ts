import { apiBaseUrl, authToken } from "./config";

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isNoriumApiRequest(url: string) {
  if (url.startsWith("/api/")) return true;
  const base = apiBaseUrl();
  return url.startsWith(`${base}/api/`) || url.startsWith("http://127.0.0.1:8000/api/");
}

export function installNoriumFetchAuth() {
  const marker = "__noriumFetchAuthInstalled";
  const markedWindow = window as typeof window & Record<string, unknown>;
  if (markedWindow[marker]) return;
  markedWindow[marker] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isNoriumApiRequest(url)) return nativeFetch(input, init);

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const token = authToken();
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const workspaceId = window.localStorage.getItem("norium-workspace-id");
    if (workspaceId && workspaceId !== "primary" && !headers.has("X-Norium-Workspace")) {
      headers.set("X-Norium-Workspace", workspaceId);
    }
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("Idempotency-Key")) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return nativeFetch(input, { ...init, headers });
  };
}
