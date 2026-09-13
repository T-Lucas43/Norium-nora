import { useCallback, useEffect, useRef, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { clearMailboxCacheForUser } from "../mailboxCache";
import type { GmailLabel, GmailStatus } from "../types";

type UseGmailConnectionOptions = {
  active?: boolean;
  userId: string;
  onError: (message: string) => void;
  /** Limpeza de estado que pertence ao dashboard (mensagens, selecoes, paineis). */
  onDisconnected?: () => void;
};

type OAuthNavigator = (url: string) => void;

function validatedGoogleOAuthUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("O backend devolveu um link de autorizacao invalido.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") {
    throw new Error("O backend devolveu um destino OAuth nao autorizado.");
  }
  return parsed.href;
}

/** Usa o popup reservado pelo clique ou navega na aba atual quando ele foi bloqueado. */
export function routeGoogleOAuth(
  popup: Window | null,
  authUrl: string,
  navigateCurrentWindow: OAuthNavigator = (url) => window.location.assign(url),
) {
  const destination = validatedGoogleOAuthUrl(authUrl);
  if (popup && !popup.closed) {
    popup.location.replace(destination);
    popup.focus();
    return "popup" as const;
  }
  navigateCurrentWindow(destination);
  return "current-window" as const;
}

/** Conexao com o Gmail: status da conta, rotulos e o par conectar/desconectar. */
export function useGmailConnection({ active = true, userId, onError, onDisconnected }: UseGmailConnectionOptions) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    const data = await apiJson<GmailStatus>(`/api/emails/gmail/status?user_id=${userId}`);
    setStatus(data);
    return data;
  }, [userId]);

  const fetchLabels = useCallback(async () => {
    const data = await apiJson<GmailStatus & { labels: GmailLabel[] }>(`/api/emails/gmail/labels?user_id=${userId}`);
    setLabels(data.labels || []);
    setStatus((prev) => ({ ...(prev || data), ...data }));
  }, [userId]);

  useEffect(() => {
    if (!active) return undefined;
    const refreshAfterOAuth = () => {
      if (document.visibilityState === "visible") {
        void fetchStatus().catch(() => undefined);
      }
    };
    window.addEventListener("focus", refreshAfterOAuth);
    document.addEventListener("visibilitychange", refreshAfterOAuth);
    return () => {
      window.removeEventListener("focus", refreshAfterOAuth);
      document.removeEventListener("visibilitychange", refreshAfterOAuth);
    };
  }, [active, fetchStatus]);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    onError("");
    let popup: Window | null = null;
    try {
      // Reservar a janela durante o gesto do clique evita que o navegador a
      // classifique como popup assíncrono depois que a API responder.
      popup = window.open("about:blank", "gmail_oauth", "width=980,height=760");
      const data = await apiJson<{ auth_url: string }>(`/api/emails/gmail/auth-url?user_id=${userId}`);
      routeGoogleOAuth(popup, data.auth_url);
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      onError(err instanceof Error ? err.message : "Nao consegui abrir o login do Gmail.");
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [onError, userId]);

  const disconnect = useCallback(async () => {
    onError("");
    try {
      await apiJson("/api/emails/gmail/disconnect", {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      });
      clearMailboxCacheForUser(userId);
      setLabels([]);
      onDisconnected?.();
      void fetchStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Nao consegui desconectar o Gmail.");
    }
  }, [fetchStatus, onDisconnected, onError, userId]);

  return { status, setStatus, labels, setLabels, connecting, fetchStatus, fetchLabels, connect, disconnect };
}
