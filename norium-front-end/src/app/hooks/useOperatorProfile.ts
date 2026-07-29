import { useCallback, useEffect, useState } from "react";

import type { AppMode, AuthSession } from "../../types/auth";
import type { PerfilOperador } from "../../types/omnichannel";
import { apiRequest } from "../../core/api/client";
import { applyNoriumTheme } from "../../utils/theme";


export function useOperatorProfile(authSession: AuthSession | null, appMode: AppMode) {
  const [profile, setProfile] = useState<PerfilOperador | null>(null);

  const saveLocalProfile = useCallback((nextProfile: PerfilOperador) => {
    setProfile(nextProfile);
    applyNoriumTheme(nextProfile.tema, nextProfile.tema_personalizado);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!authSession) return;
    try {
      const params = new URLSearchParams({ user_id: authSession.user.id });
      const data = await apiRequest<PerfilOperador>(`/api/perfil?${params.toString()}`, {
        token: authSession.token,
      });
      saveLocalProfile(data);
    } catch {
      setProfile(null);
    }
  }, [authSession, saveLocalProfile]);

  useEffect(() => {
    if (!authSession || appMode !== "app") return;
    void refreshProfile();
  }, [appMode, authSession, refreshProfile]);

  return { profile, refreshProfile, saveLocalProfile };
}
