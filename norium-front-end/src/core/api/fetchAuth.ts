import { apiBaseUrl, authToken } from "./config";
import { accessClaims, CookieSessionError, renewCookieSession, SESSION_CLOSED_EVENT } from "./cookieSession";

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isNoriumApiRequest(url: string) {
  try {
    const target = new URL(url, window.location.origin);
    return target.origin === new URL(apiBaseUrl()).origin && target.pathname.startsWith("/api/");
  } catch { return false; }
}

export function installNoriumFetchAuth() {
  const marker = "__noriumFetchAuthInstalled";
  const markedWindow = window as typeof window & Record<string, unknown>;
  if (markedWindow[marker]) return;
  markedWindow[marker] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isNoriumApiRequest(url)) return nativeFetch(input, init);

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const path = new URL(url, window.location.origin).pathname;
    if (["/api/auth/refresh", "/api/auth/session-context", "/api/auth/cookie-logout", "/api/auth/login", "/api/auth/register"].includes(path)) {
      if (path !== "/api/auth/cookie-logout") headers.delete("Authorization");
      return nativeFetch(input, { ...init, headers });
    }
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
    const supplied = headers.get("Authorization")?.replace(/^Bearer /, "");
    const claims = supplied ? accessClaims(supplied) : null;
    const stored = token ? accessClaims(token) : null;
    if (claims && stored && (claims.sub !== stored.sub || claims.sid !== stored.sid)) {
      throw new CookieSessionError("O login mudou. Atualize a página antes de continuar.", 401);
    }
    if (claims && stored && claims.sub === stored.sub && claims.sid === stored.sid && stored.exp > claims.exp) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const current = headers.get("Authorization")?.replace(/^Bearer /, "");
    const currentClaims = current ? accessClaims(current) : null;
    if (current && currentClaims && currentClaims.exp * 1000 <= Date.now() + 30_000) {
      let renewed;
      try { renewed = await renewCookieSession(current); }
      catch (error) {
        if (error instanceof CookieSessionError && error.status === 401) {
          window.dispatchEvent(new CustomEvent(SESSION_CLOSED_EVENT, { detail: { sessionId: currentClaims.sid } }));
        }
        throw error;
      }
      if (init?.signal?.aborted) throw new DOMException("Operação cancelada.", "AbortError");
      headers.set("Authorization", `Bearer ${renewed.token}`);
    }
    const response = await nativeFetch(input, { ...init, headers });
    if (response.status === 401 && current && (!path.startsWith("/api/auth/") || ["/api/auth/me", "/api/auth/session-activity", "/api/auth/sessions"].includes(path))) {
      const reason = response.headers.get("X-Norium-Auth-Error");
      if (reason !== "access_expired") window.dispatchEvent(new CustomEvent(SESSION_CLOSED_EVENT, {
        detail: { sessionId: currentClaims?.sid },
      }));
    }
    return response;
  };
}
