import { useCallback, useEffect, useRef, useState } from "react";
import { apiBlobRequest, apiRequest } from "../../core/api/client";
import { apiBaseUrl, authToken } from "../../core/api/config";

const INVALID_MEDIA_SOURCE = "Origem de mídia inválida.";

type MediaSourcePlan =
  | { kind: "direct"; source: string }
  | { kind: "fetch"; requestUrl: string }
  | { kind: "invalid" };

function isChatApiPath(pathname: string) {
  return pathname === "/api/chat" || pathname.startsWith("/api/chat/");
}

function mediaSourcePlan(source: string): MediaSourcePlan {
  if (!source) return { kind: "direct", source: "" };

  let url: URL;
  try {
    url = new URL(source, window.location.origin);
  } catch {
    return { kind: "invalid" };
  }

  if (url.protocol === "blob:" || url.protocol === "data:") {
    return { kind: "direct", source };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid" };
  }
  if (url.username || url.password) return { kind: "invalid" };

  const isPrivateChatMedia = isChatApiPath(url.pathname);
  if (url.origin === window.location.origin) {
    return isPrivateChatMedia
      ? { kind: "fetch", requestUrl: source }
      : { kind: "direct", source };
  }

  // Em desenvolvimento o backend usa uma origem própria. URLs que ele mesmo
  // publicou para /api/chat são reduzidas a relativas antes de chegar ao
  // cliente autenticado; nenhuma origem fornecida pela mídia é aceita aqui.
  let backendOrigin = "";
  try {
    backendOrigin = new URL(apiBaseUrl(), window.location.origin).origin;
  } catch {
    // Uma configuracao de backend invalida nao torna a origem da midia confiavel.
  }
  const localFrontend = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const legacyLocalBackend = localFrontend && ["http://127.0.0.1:8000", "http://localhost:8000"].includes(url.origin);
  if (isPrivateChatMedia && (url.origin === backendOrigin || legacyLocalBackend)) {
    return { kind: "fetch", requestUrl: `${url.pathname}${url.search}` };
  }

  return {
    kind: "fetch",
    requestUrl: `/api/chat/media-proxy?url=${encodeURIComponent(url.href)}`,
  };
}

/** Resolve uma mídia para o cliente autenticado sem permitir origem externa direta. */
export function authenticatedMediaRequestUrl(source: string) {
  const plan = mediaSourcePlan(source);
  if (plan.kind === "fetch") return plan.requestUrl;
  if (plan.kind === "invalid") throw new Error(INVALID_MEDIA_SOURCE);

  const url = new URL(plan.source, window.location.origin);
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin) {
    return url.href;
  }
  throw new Error(INVALID_MEDIA_SOURCE);
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
  const initialPlan = mediaSourcePlan(initial);
  const initialNeedsFetch = initialPlan.kind === "fetch";
  const [resolved, setResolved] = useState(initialPlan.kind === "direct" ? initialPlan.source : "");
  const [resolvedFor, setResolvedFor] = useState(initial);
  const [loading, setLoading] = useState(initialNeedsFetch);
  const [error, setError] = useState<string | null>(
    initialPlan.kind === "invalid" ? INVALID_MEDIA_SOURCE : null,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let revokedUrl = "";
    let cancelled = false;
    const value = source || "";
    const plan = mediaSourcePlan(value);

    if (plan.kind === "direct") {
      setResolved(plan.source);
      setResolvedFor(value);
      setLoading(false);
      setError(null);
      return undefined;
    }

    if (plan.kind === "invalid") {
      setResolved("");
      setResolvedFor(value);
      setLoading(false);
      setError(INVALID_MEDIA_SOURCE);
      return undefined;
    }

    setResolved("");
    setResolvedFor(value);
    setLoading(true);
    setError(null);
    // O servidor define a validade (ex.: privada por 5 min); o navegador reaproveita sem baixar de novo.
    void apiBlobRequest(plan.requestUrl, { cache: "default" })
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
    source: stateMatchesSource ? resolved : initialPlan.kind === "direct" ? initialPlan.source : "",
    loading: stateMatchesSource ? loading : initialNeedsFetch,
    error: stateMatchesSource ? error : initialPlan.kind === "invalid" ? INVALID_MEDIA_SOURCE : null,
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
