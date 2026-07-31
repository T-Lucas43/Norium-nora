import { useCallback, useState, type MutableRefObject } from "react";
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
  const [selectedMessage, setSelectedMessage] = useState<GmailMessage | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailLoading, setDetailLoading] = useState(false);

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
    setSelectedMessage(message);
    setDetailLoading(true);
    onError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${message.id}?user_id=${userId}`);
      setSelectedMessage(data.message);
      if (message.unread) markReadLocally(message.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Nao consegui abrir este e-mail.");
    } finally {
      setDetailLoading(false);
    }
  }, [markReadLocally, onError, userId]);

  /** Abre por id vindo de fora (deep link). Usa a lista quando a mensagem ja esta carregada. */
  const openMessageById = useCallback(async (messageId: string) => {
    const existing = messages.find((message) => message.id === messageId);
    if (existing) {
      await openMessage(existing);
      return;
    }

    setDetailLoading(true);
    onError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${messageId}?user_id=${userId}`);
      setSelectedMessage(data.message);
      if (data.message?.unread) {
        void apiJson(`/api/emails/gmail/messages/${messageId}`, {
          method: "PATCH",
          body: JSON.stringify({ user_id: userId, action: "read" }),
        }).catch(() => undefined);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Nao consegui abrir este e-mail.");
    } finally {
      setDetailLoading(false);
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
        setSelectedMessage((prev) => (prev?.id === messageId ? null : prev));
      } else if (action === "star" || action === "unstar") {
        const starred = action === "star";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, starred } : message)));
        setSelectedMessage((prev) => (prev?.id === messageId ? { ...prev, starred } : prev));
      } else if (action === "important" || action === "unimportant") {
        const important = action === "important";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, important } : message)));
        setSelectedMessage((prev) => (prev?.id === messageId ? { ...prev, important } : prev));
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
    openMessage,
    openMessageById,
    runMessageAction,
    runBulkAction,
  };
}
