import { applyInterfacePreferences } from "../../utils/interfacePreferences";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppMode, AuthSession } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import { apiRequest } from "../../core/api/client";
import { applyNoriumTheme } from "../../utils/theme";


export function useOperatorProfile(authSession: AuthSession | null, appMode: AppMode) {
  const [profile, setProfile] = useState<PerfilOperador | null>(null);
  const [profileUserId, setProfileUserId] = useState(authSession?.user.id || "");
  const requestVersionRef = useRef(0);
  const activeUserIdRef = useRef(authSession?.user.id || "");
  activeUserIdRef.current = authSession?.user.id || "";

  const saveLocalProfile = useCallback((nextProfile: PerfilOperador) => {
    setProfileUserId(activeUserIdRef.current);
    setProfile(nextProfile);
    applyInterfacePreferences(nextProfile.interface_preferences);
    applyNoriumTheme(nextProfile.tema, nextProfile.tema_personalizado);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!authSession) return;
    const requestedUserId = authSession.user.id;
    const requestVersion = ++requestVersionRef.current;
    try {
      const params = new URLSearchParams({ user_id: requestedUserId });
      const data = await apiRequest<PerfilOperador>(`/api/perfil?${params.toString()}`, {
        token: authSession.token,
      });
      if (activeUserIdRef.current !== requestedUserId || requestVersionRef.current !== requestVersion) return;
      saveLocalProfile(data);
    } catch {
      if (activeUserIdRef.current !== requestedUserId || requestVersionRef.current !== requestVersion) return;
      setProfile(null);
    }
  }, [authSession, saveLocalProfile]);

  useEffect(() => {
    requestVersionRef.current += 1;
    setProfile(null);
    applyInterfacePreferences();
    setProfileUserId(authSession?.user.id || "");
  }, [authSession?.user.id]);

  useEffect(() => {
    if (!authSession || appMode !== "app") return;
    void refreshProfile();
  }, [appMode, authSession, refreshProfile]);

  const visibleProfile = profileUserId === (authSession?.user.id || "") ? profile : null;
  return { profile: visibleProfile, refreshProfile, saveLocalProfile };
}
