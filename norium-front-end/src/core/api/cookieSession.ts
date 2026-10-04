import type { AuthSession } from "../../types/auth";
import { apiBaseUrl, authToken, AUTH_TOKEN_STORAGE } from "./config";

export const SESSION_RENEWED_EVENT = "norium:session-renewed";
export const SESSION_CLOSED_EVENT = "norium:session-closed";
let renewal: Promise<AuthSession> | null = null;
let generation = 0;

export class CookieSessionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function accessClaims(token: string) {
  try {
    const encoded = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    return typeof value?.exp === "number" && typeof value?.sub === "string"
      ? value as { exp: number; sub: string; sid?: string } : null;
  } catch { return null; }
}

export function cancelSessionRestoration() { generation += 1; }

function sameOriginEndpoint(path: string) {
  const url = new URL(`${apiBaseUrl()}${path}`, window.location.origin);
  if (url.origin !== window.location.origin) throw new CookieSessionError("A sessão persistente exige a API na mesma origem do aplicativo.", 400);
  return url.href;
}

async function cookieRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(sameOriginEndpoint(path), { ...init, credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new CookieSessionError(typeof data?.detail === "string" ? data.detail : "Não foi possível recuperar sua sessão.", response.status);
  return data as T;
}

async function locked<T>(action: () => Promise<T>) {
  // Web Locks coordinates cookies shared by tabs. The database remains the
  // authority. Older browsers fail closed on a rotation race and require login.
  return navigator.locks ? navigator.locks.request("norium-session-cookie", action) : action();
}

async function contextHeaders() {
  const { csrf } = await cookieRequest<{ csrf: string }>("/api/auth/session-context");
  return { "Content-Type": "application/json", "X-Norium-CSRF": csrf, Accept: "application/json" };
}

export async function passwordSession(path: "/api/auth/login" | "/api/auth/register", body: unknown) {
  cancelSessionRestoration();
  return locked(async () => {
    const headers = await contextHeaders();
    return cookieRequest<AuthSession>(path, { method: "POST", headers, body: JSON.stringify(body) });
  });
}

export function renewCookieSession(expectedToken?: string): Promise<AuthSession> {
  if (renewal) return renewal.then((session) => { checkExpectedSession(expectedToken, session); return session; });
  const startedGeneration = generation;
  renewal = locked(async () => {
    const headers = await contextHeaders();
    let session: AuthSession;
    try {
      session = await cookieRequest<AuthSession>("/api/auth/refresh", { method: "POST", headers, body: "{}" });
    } catch (error) {
      // A definitive rate-limit response did not consume the credential. Never
      // retry a lost/ambiguous response or reuse a consumed cookie.
      if (!(error instanceof CookieSessionError) || error.status !== 429) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 5100));
      session = await cookieRequest<AuthSession>("/api/auth/refresh", { method: "POST", headers, body: "{}" });
    }
    if (startedGeneration !== generation) throw new CookieSessionError("A restauração foi cancelada.", 499);
    const newClaims = accessClaims(session.token);
    if (!session.user?.id || !Array.isArray(session.availableModes) || !newClaims || newClaims.sub !== session.user.id) throw new CookieSessionError("Resposta de sessão inválida.", 401);
    checkExpectedSession(expectedToken, session);
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, session.token);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
    window.dispatchEvent(new CustomEvent<AuthSession>(SESSION_RENEWED_EVENT, { detail: session }));
    return session;
  }).finally(() => { renewal = null; });
  return renewal;
}

function checkExpectedSession(expectedToken: string | undefined, session: AuthSession) {
  const oldClaims = expectedToken ? accessClaims(expectedToken) : null;
  const newClaims = accessClaims(session.token);
  if (oldClaims && (!newClaims || oldClaims.sub !== newClaims.sub || oldClaims.sid !== newClaims.sid)) {
    throw new CookieSessionError("O login deste navegador mudou. Entre novamente.", 401);
  }
}

export async function closeCookieSession() {
  cancelSessionRestoration();
  const token = authToken();
  await locked(async () => {
    const headers = await contextHeaders();
    await cookieRequest("/api/auth/cookie-logout", { method: "POST", headers: {
      ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: "{}" });
  });
  notifySessionClosed(accessClaims(token ?? "")?.sid);
}

export function notifySessionClosed(sessionId?: string) {
  window.dispatchEvent(new CustomEvent(SESSION_CLOSED_EVENT, { detail: { sessionId } }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("norium-session-events");
    channel.postMessage({ type: "closed", sessionId });
    channel.close();
  }
}
