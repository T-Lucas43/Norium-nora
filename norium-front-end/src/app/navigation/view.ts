import type { AppMode } from "../../types/auth";

export type NoriumView = AppMode | "login" | "terms" | "privacy";

export const APP_MODE_STORAGE = "norium-app-mode";
export const NORIUM_VIEW_EVENT = "norium:view";

const validViews = new Set<NoriumView>(["app", "admin", "login", "terms", "privacy"]);

export function legacyViewFromHash(hash = window.location.hash): NoriumView | null {
  const normalized = hash.toLowerCase();
  if (normalized === "#/app") return "app";
  if (normalized === "#/admin") return "admin";
  if (normalized === "#/login") return "login";
  if (normalized === "#/termos") return "terms";
  if (normalized === "#/privacidade") return "privacy";
  return null;
}

export function preferredAppMode(): AppMode {
  const legacy = legacyViewFromHash();
  if (legacy === "admin" || legacy === "app") return legacy;
  return localStorage.getItem(APP_MODE_STORAGE) === "admin" ? "admin" : "app";
}

export function currentNoriumView(): NoriumView {
  const legacy = legacyViewFromHash();
  if (legacy) return legacy;
  const stateView = window.history.state?.noriumView as NoriumView | undefined;
  if (stateView && validViews.has(stateView)) return stateView;
  return preferredAppMode();
}

export function navigateNoriumView(view: NoriumView) {
  if (view === "app" || view === "admin") localStorage.setItem(APP_MODE_STORAGE, view);
  const cleanUrl = `${window.location.pathname || "/"}${window.location.search}`;
  window.history.replaceState({ ...(window.history.state || {}), noriumView: view }, "", cleanUrl);
  window.dispatchEvent(new CustomEvent<NoriumView>(NORIUM_VIEW_EVENT, { detail: view }));
}
