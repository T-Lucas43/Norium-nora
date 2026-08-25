import { useEffect, useState } from "react";
import { apiBlobRequest } from "../../core/api/client";

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
  return useAuthenticatedMediaState(source).source;
}

export type AuthenticatedMediaState = {
  source: string;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

/** Expõe loading/erro para uma mídia privada não se passar por conteúdo textual. */
export function useAuthenticatedMediaState(source?: string | null): AuthenticatedMediaState {
  const initial = source || "";
  const initialNeedsFetch = Boolean(initial && needsAuthenticatedFetch(initial));
  const [resolved, setResolved] = useState(initialNeedsFetch ? "" : initial);
  const [resolvedFor, setResolvedFor] = useState(initial);
  const [loading, setLoading] = useState(initialNeedsFetch);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let revokedUrl = "";
    let cancelled = false;
    const value = source || "";

    if (!value || !needsAuthenticatedFetch(value)) {
      setResolved(value);
      setResolvedFor(value);
      setLoading(false);
      setError(null);
      return undefined;
    }

    setResolved("");
    setResolvedFor(value);
    setLoading(true);
    setError(null);
    void apiBlobRequest(value, { cache: "no-store" })
      .then((blob) => {
        if (cancelled) return;
        revokedUrl = URL.createObjectURL(blob);
        setResolved(revokedUrl);
        setLoading(false);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setResolved("");
          setLoading(false);
          setError(fetchError instanceof Error ? fetchError.message : "Mídia indisponível.");
        }
      });

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [attempt, source]);

  const stateMatchesSource = resolvedFor === initial;
  return {
    source: stateMatchesSource ? resolved : initialNeedsFetch ? "" : initial,
    loading: stateMatchesSource ? loading : initialNeedsFetch,
    error: stateMatchesSource ? error : null,
    retry: () => setAttempt((current) => current + 1),
  };
}
