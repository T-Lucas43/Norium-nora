import { useCallback, useEffect, useRef, useState } from "react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import { authToken } from "../../core/api/config";

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
const profilePhotoRequests = new Map<string, Promise<string>>();

function requestWhatsAppProfilePhoto(
  identifier: string,
  token: string | null,
  workspaceId: string,
): Promise<string> {
  const normalizedIdentifier = identifier.trim();
  if (!normalizedIdentifier) return Promise.resolve("");

  const requestKey = JSON.stringify([token || "", workspaceId, normalizedIdentifier]);
  const pending = profilePhotoRequests.get(requestKey);
  if (pending) return pending;

  let request: Promise<string>;
  request = Promise.resolve(
    apiRequest<{ photoUrl?: string | null }>(
      `/api/chat/foto-perfil?phone=${encodeURIComponent(normalizedIdentifier)}`,
      {
        cache: "no-store",
        timeoutMs: 30_000,
        token,
        headers: workspaceId !== "primary" ? { "X-Norium-Workspace": workspaceId } : undefined,
      },
    ),
  )
    .then((payload) => typeof payload?.photoUrl === "string" ? payload.photoUrl.trim() : "")
    .catch(() => "")
    .finally(() => {
      if (profilePhotoRequests.get(requestKey) === request) {
        profilePhotoRequests.delete(requestKey);
      }
    });

  profilePhotoRequests.set(requestKey, request);
  return request;
}

export type WhatsAppProfilePhotoState = {
  source: string;
  onError: () => void;
};

export function useWhatsAppProfilePhoto(
  identifier?: string | null,
  initialSource?: string | null,
): WhatsAppProfilePhotoState {
  const normalizedIdentifier = (identifier || "").trim();
  const initial = initialSource || "";
  const token = authToken();
  const workspaceId = window.localStorage.getItem("norium-workspace-id") || "primary";
  const inputKey = JSON.stringify([token || "", workspaceId, normalizedIdentifier, initial]);
  const [freshPhoto, setFreshPhoto] = useState({ inputKey, source: "" });
  const [failedPhoto, setFailedPhoto] = useState({ inputKey, failed: false });
  const attemptedRefresh = useRef<string | null>(null);
  const currentInputKey = useRef(inputKey);
  currentInputKey.current = inputKey;

  useEffect(() => {
    let cancelled = false;
    setFreshPhoto({ inputKey, source: "" });
    setFailedPhoto({ inputKey, failed: false });
    attemptedRefresh.current = null;
    if (!normalizedIdentifier || initial) return () => { cancelled = true; };

    attemptedRefresh.current = inputKey;
    void requestWhatsAppProfilePhoto(normalizedIdentifier, token, workspaceId).then((photoUrl) => {
      if (!cancelled && photoUrl) setFreshPhoto({ inputKey, source: photoUrl });
    });
    return () => { cancelled = true; };
  }, [initial, inputKey, normalizedIdentifier, token, workspaceId]);

  const freshSource = freshPhoto.inputKey === inputKey ? freshPhoto.source : "";
  const failed = failedPhoto.inputKey === inputKey && failedPhoto.failed;
  const currentSource = freshSource || initial;
  const source = useAuthenticatedMedia(failed ? "" : currentSource);
  const onError = useCallback(() => {
    setFailedPhoto({ inputKey, failed: true });
    if (!normalizedIdentifier || attemptedRefresh.current === inputKey) return;
    attemptedRefresh.current = inputKey;
    void requestWhatsAppProfilePhoto(normalizedIdentifier, token, workspaceId).then((photoUrl) => {
      if (photoUrl && photoUrl !== currentSource && currentInputKey.current === inputKey) {
        setFreshPhoto({ inputKey, source: photoUrl });
        setFailedPhoto({ inputKey, failed: false });
      }
    });
  }, [currentSource, inputKey, normalizedIdentifier, token, workspaceId]);

  return { source, onError };
}
