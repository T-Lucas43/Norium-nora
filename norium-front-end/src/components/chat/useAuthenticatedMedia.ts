import { useEffect, useState } from "react";

function needsAuthenticatedFetch(source: string) {
  if (!source) return false;
  try {
    const url = new URL(source, window.location.origin);
    return url.pathname.startsWith("/api/chat/");
  } catch {
    return source.startsWith("/api/chat/");
  }
}

/**
 * Elementos img/audio/video nao enviam o Bearer do aplicativo. Para midias
 * privadas do chat, baixa o recurso com o fetch autenticado e entrega apenas
 * uma URL blob temporaria ao elemento visual.
 */
export function useAuthenticatedMedia(source?: string | null) {
  const [resolved, setResolved] = useState(source || "");

  useEffect(() => {
    let revokedUrl = "";
    let cancelled = false;
    const value = source || "";

    if (!value || !needsAuthenticatedFetch(value)) {
      setResolved(value);
      return undefined;
    }

    setResolved("");
    void fetch(value, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Midia privada indisponivel.");
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        revokedUrl = URL.createObjectURL(blob);
        setResolved(revokedUrl);
      })
      .catch(() => {
        if (!cancelled) setResolved("");
      });

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [source]);

  return resolved;
}
