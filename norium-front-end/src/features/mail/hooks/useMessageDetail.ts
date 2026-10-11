import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { requestScope } from "../../../core/api/sessionScope";
import { mailApiRequest as apiJson } from "../api";
import { clearMailboxCacheForUser } from "../mailboxCache";
import type { GmailMessage, MailboxSnapshot } from "../types";

/** Acoes que tiram a mensagem da listagem atual. */
const REMOVING_ACTIONS = ["archive", "trash", "spam"];

type UseMessageDetailOptions = {
  userId: string;
  messages: GmailMessage[];
  setMessages: (updater: (prev: GmailMessage[]) => GmailMessage[]) => void;
  currentMailboxKey: string;
  cacheRef: MutableRefObject<Map<string, MailboxSnapshot>>;
  onError: (message: string) => void;
  onRefreshMessages: () => void;
  onRefreshLabels: () => void;
  /** Fecha o menu de contexto da mensagem ao executar uma acao. */
  onActionStart?: () => void;
};

/** Leitura de uma mensagem e acoes sobre ela (individuais e em lote). */
export function useMessageDetail({
  userId,
  messages,
  setMessages,
  currentMailboxKey,
  cacheRef,
  onError,
  onRefreshMessages,
  onRefreshLabels,
  onActionStart,
}: UseMessageDetailOptions) {
  const [selectedMessage, setSelectedMessageState] = useState<GmailMessage | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const requestRevision = useRef(0);
  const setSelectedMessage: Dispatch<SetStateAction<GmailMessage | null>> = useCallback((value) => {
    requestRevision.current += 1;
    setSelectedMessageState(value); setDetailError(""); setDetailLoading(false);
  }, []);
  useEffect(() => {
    requestRevision.current += 1;
    setSelectedMessageState(null); setDetailError(""); setDetailLoading(false);
    return () => { requestRevision.current += 1; };
  }, [userId, currentMailboxKey]);

  /** Marca como lida na lista, no cache e no servidor (sem bloquear a leitura). */
  const markReadLocally = useCallback((messageId: string) => {
    setMessages((prev) => prev.map((item) => (item.id === messageId ? { ...item, unread: false } : item)));
    const snapshot = cacheRef.current.get(currentMailboxKey);
    if (snapshot) {
      cacheRef.current.set(currentMailboxKey, {
        ...snapshot,
        messages: snapshot.messages.map((item) => (item.id === messageId ? { ...item, unread: false } : item)),
      });
    }
    void apiJson(`/api/emails/gmail/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ user_id: userId, action: "read" }),
    }).catch(() => undefined);
  }, [cacheRef, currentMailboxKey, setMessages, userId]);

  const openMessage = useCallback(async (message: GmailMessage) => {
    const revision = ++requestRevision.current;
    const scope = requestScope();
    const current = () => revision === requestRevision.current && scope === requestScope();
    setSelectedMessageState(message);
    setDetailLoading(true);
    setDetailError("");
    onError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${message.id}?user_id=${userId}`);
      if (!current()) return;
      setSelectedMessageState(data.message);
      if (message.unread) markReadLocally(message.id);
    } catch (err) {
      if (!current()) return;
      const message = err instanceof Error ? err.message : "Não consegui abrir este e-mail.";
      setDetailError(message); onError(message);
    } finally {
      if (current()) setDetailLoading(false);
    }
  }, [markReadLocally, onError, userId]);

  /** Abre por id vindo de fora (deep link). Usa a lista quando a mensagem ja esta carregada. */
  const openMessageById = useCallback(async (messageId: string) => {
    const existing = messages.find((message) => message.id === messageId);
    if (existing) {
      await openMessage(existing);
      return;
    }

    const revision = ++requestRevision.current;
    const scope = requestScope();
    const current = () => revision === requestRevision.current && scope === requestScope();
    setSelectedMessageState(null); setDetailError(""); setDetailLoading(true);
    onError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${messageId}?user_id=${userId}`);
      if (!current()) return;
      setSelectedMessageState(data.message);
      if (data.message?.unread) {
        void apiJson(`/api/emails/gmail/messages/${messageId}`, {
          method: "PATCH",
          body: JSON.stringify({ user_id: userId, action: "read" }),
        }).catch(() => undefined);
      }
    } catch (err) {
      if (!current()) return;
      const message = err instanceof Error ? err.message : "Não consegui abrir este e-mail.";
      setDetailError(message); onError(message);
    } finally {
      if (current()) setDetailLoading(false);
    }
  }, [messages, onError, openMessage, userId]);

  const runMessageAction = useCallback(async (messageId: string, action: string, closeAfter = false) => {
    onError("");
    onActionStart?.();
    try {
      await apiJson(`/api/emails/gmail/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ user_id: userId, action }),
      });
      clearMailboxCacheForUser(userId);

      if (REMOVING_ACTIONS.includes(action) || closeAfter) {
        setMessages((prev) => prev.filter((message) => message.id !== messageId));
        setSelectedMessageState((prev) => (prev?.id === messageId ? null : prev));
      } else if (action === "star" || action === "unstar") {
        const starred = action === "star";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, starred } : message)));
        setSelectedMessageState((prev) => (prev?.id === messageId ? { ...prev, starred } : prev));
      } else if (action === "important" || action === "unimportant") {
        const important = action === "important";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, important } : message)));
        setSelectedMessageState((prev) => (prev?.id === messageId ? { ...prev, important } : prev));
      } else {
        onRefreshMessages();
      }
      onRefreshLabels();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Acao nao concluida.");
    }
  }, [onActionStart, onError, onRefreshLabels, onRefreshMessages, setMessages, userId]);

  const runBulkAction = useCallback(async (action: string) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    await Promise.all(ids.map((id) => runMessageAction(id, action, true)));
    setSelectedIds(new Set());
  }, [runMessageAction, selectedIds]);

  return {
    selectedMessage,
    setSelectedMessage,
    selectedIds,
    setSelectedIds,
    detailLoading,
    detailError,
    openMessage,
    openMessageById,
    runMessageAction,
    runBulkAction,
  };
}
