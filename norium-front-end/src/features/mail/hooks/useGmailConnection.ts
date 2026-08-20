import { useCallback, useEffect, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { clearMailboxCacheForUser } from "../mailboxCache";
import type { GmailLabel, GmailStatus } from "../types";

type UseGmailConnectionOptions = {
  userId: string;
  onError: (message: string) => void;
  /** Limpeza de estado que pertence ao dashboard (mensagens, selecoes, paineis). */
  onDisconnected?: () => void;
};

/** Conexao com o Gmail: status da conta, rotulos e o par conectar/desconectar. */
export function useGmailConnection({ userId, onError, onDisconnected }: UseGmailConnectionOptions) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [labels, setLabels] = useState<GmailLabel[]>([]);

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
  }, [fetchStatus]);

  const connect = useCallback(async () => {
    onError("");
    try {
      const data = await apiJson<{ auth_url: string }>(`/api/emails/gmail/auth-url?user_id=${userId}`);
      window.open(data.auth_url, "gmail_oauth", "width=980,height=760");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Nao consegui abrir o login do Gmail.");
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

  return { status, setStatus, labels, setLabels, fetchStatus, fetchLabels, connect, disconnect };
}
