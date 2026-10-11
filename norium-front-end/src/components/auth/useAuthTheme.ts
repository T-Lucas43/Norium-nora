import { useEffect, useState } from "react";
import type { PerfilTema } from "../../types/omnichannel";
import { readStoredTheme } from "../../utils/theme";

function currentTheme(): PerfilTema {
  try {
    return readStoredTheme();
  } catch {
    return document.documentElement.classList.contains("dark") ? "escuro" : "claro";
  }
}

/** Tema das telas de acesso: o escolhido pela pessoa ou, sem escolha salva, o do sistema. Não grava nada. */
export function useAuthTheme(): PerfilTema {
  const [theme, setTheme] = useState<PerfilTema>(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener?.("change", update);
    window.addEventListener("norium-theme-change", update);
    window.addEventListener("storage", update);
    return () => {
      media?.removeEventListener?.("change", update);
      window.removeEventListener("norium-theme-change", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return theme;
}
