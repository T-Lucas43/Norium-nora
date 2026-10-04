import { useCallback, useEffect, useRef, useState } from "react";

import type { AppMode, AuthSession } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import { AUTH_TOKEN_STORAGE } from "../../core/api/config";
import { preferredAppMode } from "../navigation/view";
import { mailboxSessionCache } from "../../features/mail/mailboxCache";
import { accessClaims, cancelSessionRestoration, renewCookieSession, SESSION_CLOSED_EVENT, SESSION_RENEWED_EVENT } from "../../core/api/cookieSession";
import { ApiError } from "../../core/api/client";

function clearPrivateSnapshots() {
  mailboxSessionCache.clear();
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("norium-operations-overview:")) sessionStorage.removeItem(key);
  }
  localStorage.removeItem("norium-workspace-id");
}


export function useAuthSession() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [appMode, setAppMode] = useState<AppMode>("app");
  const revision = useRef(0);
  const sessionUserId = useRef<string | null>(null);

  const updateSession = useCallback((nextSession: AuthSession) => {
    cancelSessionRestoration();
    revision.current += 1;
    if (sessionUserId.current !== nextSession.user.id) clearPrivateSnapshots();
    sessionUserId.current = nextSession.user.id;
    setAuthSession(nextSession);
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, nextSession.token);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
  }, []);

  const clearSession = useCallback(() => {
    cancelSessionRestoration();
    revision.current += 1;
    sessionUserId.current = null;
    clearPrivateSnapshots();
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
    setAuthSession(null);
    setAppMode("app");
  }, []);

  useEffect(() => {
    const restoringRevision = ++revision.current;
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
    const token = sessionStorage.getItem(AUTH_TOKEN_STORAGE);
    const restore = token
      ? authJson<{ user: AuthSession["user"]; availableModes: AppMode[] }>("/api/auth/me", token)
          .then((data) => ({ token, ...data }))
      : renewCookieSession();
    restore
      .then((data) => {
        if (revision.current !== restoringRevision) return;
        const session: AuthSession = { token: data.token, user: data.user, availableModes: data.availableModes };
        sessionStorage.setItem(AUTH_TOKEN_STORAGE, data.token);
        sessionUserId.current = data.user.id;
        setAuthSession(session);
        setAppMode(preferredAppMode() === "admin" && data.availableModes.includes("admin") ? "admin" : "app");
      })
      .catch(() => { if (revision.current === restoringRevision) clearSession(); })
      .finally(() => setAuthLoading(false));
    return () => { revision.current += 1; };
  }, [clearSession]);

  useEffect(() => {
    const renewed = (event: Event) => updateSession((event as CustomEvent<AuthSession>).detail);
    const closeMatchingSession = (sessionId?: string) => {
      if (!sessionId || accessClaims(sessionStorage.getItem(AUTH_TOKEN_STORAGE) ?? "")?.sid === sessionId) clearSession();
    };
    const closed = (event: Event) => closeMatchingSession((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId);
    window.addEventListener(SESSION_RENEWED_EVENT, renewed);
    window.addEventListener(SESSION_CLOSED_EVENT, closed);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("norium-session-events") : null;
    if (channel) channel.onmessage = (event) => { if (event.data?.type === "closed") closeMatchingSession(event.data.sessionId); };
    return () => {
      window.removeEventListener(SESSION_RENEWED_EVENT, renewed);
      window.removeEventListener(SESSION_CLOSED_EVENT, closed);
      channel?.close();
    };
  }, [clearSession, updateSession]);

  useEffect(() => {
    if (!authSession) return;
    let lastActivity = 0;
    const activity = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastActivity < 60_000) return;
      lastActivity = Date.now();
      const activityRevision = revision.current;
      void authJson("/api/auth/session-activity", undefined, { method: "POST" }).catch((error) => {
        if (error instanceof ApiError && error.status === 401 && revision.current === activityRevision) clearSession();
      });
    };
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    return () => { window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); };
  }, [authSession, clearSession]);

  return {
    appMode,
    authLoading,
    authSession,
    clearSession,
    setAppMode,
    updateSession,
  };
}
