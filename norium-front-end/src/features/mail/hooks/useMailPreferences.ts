import { useEffect, useRef, useState } from "react";
import type { MailPreferences } from "../../../components/emails/modals/MailSettingsDrawer";

const STORAGE_KEY = "norium-mail-preferences";

const DEFAULTS: MailPreferences = {
  autoRefresh: true,
  showPreview: true,
  compactMode: false,
  groupByCategory: false,
};

/**
 * Preferencias de exibicao do Norium Mail, persistidas no navegador.
 *
 * A gravacao so comeca depois da leitura inicial: sem essa trava, o primeiro
 * render salvaria os valores padrao por cima do que o usuario ja tinha.
 */
export function useMailPreferences() {
  const [preferences, setPreferences] = useState<MailPreferences>(DEFAULTS);
  const loadedRef = useRef(false);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Partial<MailPreferences>;
      setPreferences((prev) => ({
        autoRefresh: typeof stored.autoRefresh === "boolean" ? stored.autoRefresh : prev.autoRefresh,
        showPreview: typeof stored.showPreview === "boolean" ? stored.showPreview : prev.showPreview,
        compactMode: typeof stored.compactMode === "boolean" ? stored.compactMode : prev.compactMode,
        groupByCategory: typeof stored.groupByCategory === "boolean" ? stored.groupByCategory : prev.groupByCategory,
      }));
    } catch {
      // Preferencias invalidas nao devem impedir o carregamento do Gmail.
    }
    window.requestAnimationFrame(() => {
      loadedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const setPreference = <K extends keyof MailPreferences>(key: K, value: MailPreferences[K]) =>
    setPreferences((prev) => ({ ...prev, [key]: value }));

  return { preferences, setPreference };
}
