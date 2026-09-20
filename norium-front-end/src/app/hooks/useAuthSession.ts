import { useCallback, useEffect, useRef, useState } from "react";

import type { AppMode, AuthSession } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import { AUTH_TOKEN_STORAGE } from "../../core/api/config";
import { preferredAppMode } from "../navigation/view";
import { mailboxSessionCache } from "../../features/mail/mailboxCache";

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
    revision.current += 1;
    if (sessionUserId.current !== nextSession.user.id) clearPrivateSnapshots();
    sessionUserId.current = nextSession.user.id;
    setAuthSession(nextSession);
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, nextSession.token);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
  }, []);

  const clearSession = useCallback(() => {
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
    if (!token) {
      setAuthLoading(false);
      return;
    }

    authJson<{ user: AuthSession["user"]; availableModes: AppMode[] }>("/api/auth/me", token)
      .then((data) => {
        if (revision.current !== restoringRevision) return;
        const session: AuthSession = { token, user: data.user, availableModes: data.availableModes };
        sessionUserId.current = data.user.id;
        setAuthSession(session);
        setAppMode(preferredAppMode() === "admin" && data.availableModes.includes("admin") ? "admin" : "app");
      })
      .catch(() => { if (revision.current === restoringRevision) clearSession(); })
      .finally(() => setAuthLoading(false));
    return () => { revision.current += 1; };
  }, [clearSession]);

  return {
    appMode,
    authLoading,
    authSession,
    clearSession,
    setAppMode,
    updateSession,
  };
}
