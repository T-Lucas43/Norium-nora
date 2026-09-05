import { useCallback, useEffect, useRef, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { mailboxCacheKey, mailboxSessionCache } from "../mailboxCache";
import { requestScope } from "../../../core/api/sessionScope";
import { buildMessagesPath } from "../queryBuilder";
import type { GmailMessage, MailQuickFilter, MailboxSnapshot, MessageListResponse } from "../types";

/** Pastas pre-carregadas em segundo plano para a troca de caixa parecer instantanea. */
const PREFETCH_FOLDERS = ["sent", "drafts", "scheduled", "starred", "important", "spam", "trash"];
const PREFETCH_DELAY_MS = 700;
const AUTO_REFRESH_MS = 45000;

type UseMailboxOptions = {
  userId: string;
  folder: string;
  filter: MailQuickFilter;
  searchQuery: string;
  connected: boolean;
  autoRefresh: boolean;
  onError: (message: string) => void;
  /** Recebe o payload da listagem, que tambem carrega dados da conta. */
  onStatusPayload: (data: MessageListResponse) => void;
  onRefreshLabels: () => void;
  /** Disparado ao trocar de caixa, para o dashboard limpar suas selecoes. */
  onMailboxChanged?: () => void;
};

/**
 * Listagem da caixa de e-mail: busca, paginacao, cache por caixa, pre-carregamento
 * de pastas e atualizacao automatica.
 *
 * Requisicoes concorrentes sao descartadas por chave (mesma caixa + mesma pagina) e
 * respostas de uma caixa que nao esta mais em tela nao sobrescrevem o que o usuario ve.
 */
export function useMailbox({
  userId,
  folder,
  filter,
  searchQuery,
  connected,
  autoRefresh,
  onError,
  onStatusPayload,
  onRefreshLabels,
  onMailboxChanged,
}: UseMailboxOptions) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState(0);
  const [loading, setLoading] = useState(false);

  const cacheRef = useRef<Map<string, MailboxSnapshot>>(mailboxSessionCache);
  const inFlightRef = useRef<Set<string>>(new Set());
  const currentMailboxKey = mailboxCacheKey(userId, folder, filter, searchQuery);
  const activeKeyRef = useRef(currentMailboxKey);
  activeKeyRef.current = currentMailboxKey;

  // Callbacks em ref: evitam recriar fetchMessages a cada render do dashboard,
  // o que faria o efeito principal disparar em loop.
  const onErrorRef = useRef(onError);
  const onStatusPayloadRef = useRef(onStatusPayload);
  const onRefreshLabelsRef = useRef(onRefreshLabels);
  const onMailboxChangedRef = useRef(onMailboxChanged);
  onErrorRef.current = onError;
  onStatusPayloadRef.current = onStatusPayload;
  onRefreshLabelsRef.current = onRefreshLabels;
  onMailboxChangedRef.current = onMailboxChanged;

  useEffect(() => {
    inFlightRef.current.clear();
    setMessages([]);
  }, [userId]);

  const fetchMessages = useCallback(
    async (append = false, pageToken?: string | null, silent = false) => {
      const requestKey = mailboxCacheKey(userId, folder, filter, searchQuery);
      const scope = requestScope();
      const requestId = `${requestKey}::${pageToken || "first"}`;
      if (inFlightRef.current.has(requestId)) return;
      inFlightRef.current.add(requestId);

      const cached = cacheRef.current.get(requestKey);
      const shouldShowLoader = !silent && !append && !cached;
      if (shouldShowLoader) setLoading(true);
      if (activeKeyRef.current === requestKey) onErrorRef.current("");
      try {
        const data = await apiJson<MessageListResponse>(buildMessagesPath({
          userId,
          folder,
          filter,
          query: searchQuery,
          pageToken,
        }));
        if (scope !== requestScope()) return;
        const incomingMessages = data.messages || [];
        const previousMessages = append ? cacheRef.current.get(requestKey)?.messages || [] : [];
        const nextMessages = append
          ? Array.from(new Map([...previousMessages, ...incomingMessages].map((message) => [message.id, message])).values())
          : incomingMessages;
        const snapshot: MailboxSnapshot = {
          messages: nextMessages,
          nextPageToken: data.nextPageToken || null,
          resultSize: data.resultSizeEstimate || 0,
          cachedAt: Date.now(),
        };
        cacheRef.current.set(requestKey, snapshot);

        if (activeKeyRef.current === requestKey) {
          setMessages(snapshot.messages);
          setNextPageToken(snapshot.nextPageToken);
          setResultSize(snapshot.resultSize);
        }
        onStatusPayloadRef.current(data);
      } catch (err) {
        if (activeKeyRef.current === requestKey) {
          onErrorRef.current(err instanceof Error ? err.message : "Nao foi possivel carregar os e-mails.");
        }
      } finally {
        inFlightRef.current.delete(requestId);
        if (shouldShowLoader && activeKeyRef.current === requestKey) setLoading(false);
      }
    },
    [filter, folder, searchQuery, userId],
  );

  const prefetchMailbox = useCallback(async (targetFolder: string) => {
    const scope = requestScope();
    const requestKey = mailboxCacheKey(userId, targetFolder, "all", "");
    const requestId = `${requestKey}::first`;
    if (cacheRef.current.has(requestKey) || inFlightRef.current.has(requestId)) return;
    inFlightRef.current.add(requestId);
    try {
      const data = await apiJson<MessageListResponse>(buildMessagesPath({
        userId,
        folder: targetFolder,
        filter: "all",
        query: "",
      }));
      if (scope !== requestScope()) return;
      cacheRef.current.set(requestKey, {
        messages: data.messages || [],
        nextPageToken: data.nextPageToken || null,
        resultSize: data.resultSizeEstimate || 0,
        cachedAt: Date.now(),
      });
    } catch {
      // O pre-carregamento e oportunista; a navegacao normal continua exibindo erros quando necessario.
    } finally {
      inFlightRef.current.delete(requestId);
    }
  }, [userId]);

  // Pre-carrega as demais pastas pouco depois de conectar.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const target of PREFETCH_FOLDERS) {
          if (cancelled) return;
          await prefetchMailbox(target);
        }
      })();
    }, PREFETCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connected, prefetchMailbox]);

  // Carrega a caixa atual (do cache quando houver) e mantem a atualizacao automatica.
  useEffect(() => {
    if (!connected) return undefined;
    onMailboxChangedRef.current?.();
    const cached = cacheRef.current.get(currentMailboxKey);
    if (cached) {
      setMessages(cached.messages);
      setNextPageToken(cached.nextPageToken);
      setResultSize(cached.resultSize);
      setLoading(false);
    } else {
      setMessages([]);
      setNextPageToken(null);
      setResultSize(0);
    }
    void fetchMessages(false, null, Boolean(cached));
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void fetchMessages(false, null, true);
      onRefreshLabelsRef.current();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connected, currentMailboxKey, fetchMessages]);

  // Outras telas avisam que o correio mudou (ex.: envio feito pela Nora).
  useEffect(() => {
    if (!connected) return undefined;
    const refresh = () => {
      void fetchMessages(false, null, true);
      onRefreshLabelsRef.current();
    };
    window.addEventListener("emails:changed", refresh);
    return () => window.removeEventListener("emails:changed", refresh);
  }, [connected, fetchMessages]);

  return {
    messages,
    setMessages,
    nextPageToken,
    resultSize,
    loading,
    setLoading,
    fetchMessages,
    prefetchMailbox,
    currentMailboxKey,
    cacheRef,
    inFlightRef,
  };
}
