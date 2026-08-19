import { useCallback, useEffect, useState } from "react";

import type { AppMode, AuthSession } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import { AUTH_TOKEN_STORAGE } from "../../core/api/config";


export function useAuthSession() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [appMode, setAppMode] = useState<AppMode>("app");

  const updateSession = useCallback((nextSession: AuthSession) => {
    setAuthSession(nextSession);
    sessionStorage.setItem(AUTH_TOKEN_STORAGE, nextSession.token);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
  }, []);

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE);
    localStorage.removeItem(AUTH_TOKEN_STORAGE);
    setAuthSession(null);
    setAppMode("app");
  }, []);

  useEffect(() => {
    const legacyToken = localStorage.getItem(AUTH_TOKEN_STORAGE);
    const token = sessionStorage.getItem(AUTH_TOKEN_STORAGE) || legacyToken;
    if (legacyToken) {
      sessionStorage.setItem(AUTH_TOKEN_STORAGE, legacyToken);
      localStorage.removeItem(AUTH_TOKEN_STORAGE);
    }
    if (!token) {
      setAuthLoading(false);
      return;
    }

    authJson<{ user: AuthSession["user"]; availableModes: AppMode[] }>("/api/auth/me", token)
      .then((data) => {
        const session: AuthSession = { token, user: data.user, availableModes: data.availableModes };
        setAuthSession(session);
        setAppMode(window.location.hash === "#/admin" && data.availableModes.includes("admin") ? "admin" : "app");
      })
      .catch(clearSession)
      .finally(() => setAuthLoading(false));
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
