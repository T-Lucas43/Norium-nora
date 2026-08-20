const LOCAL_API_URL = "http://127.0.0.1:8000";
export const AUTH_TOKEN_STORAGE = "norium-auth-token";

declare global {
  interface Window {
    __NORIUM_CONFIG__?: {
      API_URL?: string;
      WS_URL?: string;
    };
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isLocalFrontend() {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

export function apiBaseUrl() {
  if (isLocalFrontend()) return LOCAL_API_URL;

  const runtimeConfigured = window.__NORIUM_CONFIG__?.API_URL?.trim();
  if (runtimeConfigured) return trimTrailingSlash(runtimeConfigured);

  const buildConfigured = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  if (buildConfigured) return trimTrailingSlash(buildConfigured);

  return trimTrailingSlash(window.location.origin);
}

export function wsBaseUrl() {
  const runtimeConfigured = window.__NORIUM_CONFIG__?.WS_URL?.trim();
  if (runtimeConfigured) return trimTrailingSlash(runtimeConfigured);

  const buildConfigured = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  if (buildConfigured) return trimTrailingSlash(buildConfigured);

  const apiUrl = apiBaseUrl();
  if (apiUrl === LOCAL_API_URL) return "ws://127.0.0.1:8000";
  return apiUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export function authToken() {
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE) || window.sessionStorage.getItem(AUTH_TOKEN_STORAGE);
}
