import { useCallback, useEffect, useRef, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { mailboxCacheKey, mailboxSessionCache } from "../mailboxCache";
import { requestScope } from "../../../core/api/sessionScope";
import { MAIL_SYNC_PAGE_DELAY_MS, waitForMailRead as sleep } from "../readPacing";
import { buildMessagesPath } from "../queryBuilder";
import type { GmailMessage, MailQuickFilter, MailboxSnapshot, MailboxSyncState, MessageListResponse } from "../types";
import { initialMailboxSyncState } from "../types";

const AUTO_REFRESH_MS = 120_000;
const SYNC_RETRY_DELAY_MS = 800;

function isQuotaError(err: unknown) {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) return true;
  const text = String(err instanceof Error ? err.message : err || "").toLowerCase();
  return text.includes("quota") || text.includes("rate limit") || text.includes("rate-limit") || text.includes("too many requests");
}

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
 * Após a primeira página, sincroniza o restante em segundo plano até esgotar
 * o nextPageToken, com progresso, cancelamento ao trocar de caixa e cache
 * completo em memória (metadados da listagem; corpos/anexos não são baixados).
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
  const inFlightRef = useRef<Map<string, Promise<MessageListResponse>>>(new Map());
  const currentMailboxKey = mailboxCacheKey(userId, folder, filter, searchQuery);
  const activeKeyRef = useRef(currentMailboxKey);
  activeKeyRef.current = currentMailboxKey;
  const syncGenerationRef = useRef(0);
  const [syncState, setSyncState] = useState<MailboxSyncState>(initialMailboxSyncState);

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
    syncGenerationRef.current += 1;
    setSyncState(initialMailboxSyncState);
    setMessages([]);
  }, [userId]);

  const fetchPage = useCallback(
    async (args: { key: string; folder: string; filter: MailQuickFilter; query: string; pageToken?: string | null }) => {
      const requestId = `${args.key}::${args.pageToken || "first"}`;
      const pending = inFlightRef.current.get(requestId);
      if (pending) return pending;
      const promise = apiJson<MessageListResponse>(buildMessagesPath({
        userId,
        folder: args.folder,
        filter: args.filter,
        query: args.query,
        pageToken: args.pageToken,
      }));
      inFlightRef.current.set(requestId, promise);
      try {
        return await promise;
      } finally {
        inFlightRef.current.delete(requestId);
      }
    },
    [userId],
  );

  const fetchMessages = useCallback(
    async (append = false, pageToken?: string | null, silent = false) => {
      const requestKey = mailboxCacheKey(userId, folder, filter, searchQuery);
      const scope = requestScope();
      const cached = cacheRef.current.get(requestKey);
      const shouldShowLoader = !silent && !append && !cached;
      if (shouldShowLoader) setLoading(true);
      if (activeKeyRef.current === requestKey) onErrorRef.current("");
      try {
        const data = await fetchPage({ key: requestKey, folder, filter, query: searchQuery, pageToken });
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
          complete: !data.nextPageToken,
        };
        cacheRef.current.set(requestKey, snapshot);

        if (activeKeyRef.current === requestKey) {
          setMessages(snapshot.messages);
          setLoading(false);
          setNextPageToken(snapshot.nextPageToken);
          setResultSize(snapshot.resultSize);
        }
        onStatusPayloadRef.current(data);
      } catch (err) {
        if (activeKeyRef.current === requestKey) {
          onErrorRef.current(err instanceof Error ? err.message : "Nao foi possivel carregar os e-mails.");
        }
      } finally {
        if (shouldShowLoader && activeKeyRef.current === requestKey) setLoading(false);
      }
    },
    [fetchPage, filter, folder, searchQuery, userId],
  );

  const syncMailbox = useCallback(async () => {
    const requestKey = mailboxCacheKey(userId, folder, filter, searchQuery);
    const scope = requestScope();
    const generation = ++syncGenerationRef.current;
    const isStale = () => generation !== syncGenerationRef.current || activeKeyRef.current !== requestKey || scope !== requestScope();
    const shouldShowLoader = !cacheRef.current.get(requestKey);
    if (activeKeyRef.current === requestKey) onErrorRef.current("");
    if (shouldShowLoader) setLoading(true);
    setSyncState({ active: true, loaded: 0, estimated: 0, done: false, error: null });
    const collected = new Map<string, GmailMessage>();
    const partial = cacheRef.current.get(requestKey);
    if (partial && !partial.complete) for (const message of partial.messages) collected.set(message.id, message);
    let pageToken: string | null | undefined = partial && !partial.complete ? partial.nextPageToken : undefined;
    let estimated = 0;
    try {
      for (;;) {
        if (isStale()) return;
        let data: MessageListResponse;
        for (let attempt = 0; ; attempt += 1) {
          try {
            data = await fetchPage({ key: requestKey, folder, filter, query: searchQuery, pageToken });
            break;
          } catch (err) {
            if (isStale() || attempt >= (isQuotaError(err) ? 2 : 1)) throw err;
            // Leitura em segundo plano cede espaço ao e-mail aberto e à conta ativa.
            await sleep(isQuotaError(err) ? 30_000 * 2 ** attempt : SYNC_RETRY_DELAY_MS);
            if (isStale()) return;
          }
        }
        if (isStale()) return;
        for (const message of data.messages || []) collected.set(message.id, message);
        estimated = data.resultSizeEstimate || estimated;
        const snapshot: MailboxSnapshot = {
          messages: [...collected.values()],
          nextPageToken: data.nextPageToken || null,
          resultSize: estimated,
          cachedAt: Date.now(),
          complete: !data.nextPageToken,
        };
        cacheRef.current.set(requestKey, snapshot);
        if (activeKeyRef.current === requestKey) {
          setMessages(snapshot.messages);
          setNextPageToken(snapshot.nextPageToken);
          setResultSize(snapshot.resultSize);
          setSyncState({ active: true, loaded: collected.size, estimated, done: false, error: null });
          setLoading(false);
        }
        onStatusPayloadRef.current(data);
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
        await sleep(MAIL_SYNC_PAGE_DELAY_MS);
      }
      if (!isStale() && activeKeyRef.current === requestKey) {
        setSyncState({ active: false, loaded: collected.size, estimated, done: true, error: null });
      }
    } catch (err) {
      if (isStale()) return;
      if (activeKeyRef.current === requestKey) {
        if (!collected.size) onErrorRef.current(err instanceof Error ? err.message : "Nao foi possivel carregar os e-mails.");
        setSyncState({ active: false, loaded: collected.size, estimated, done: false, error: err instanceof Error ? err.message : "Falha parcial na sincronização." });
      }
    } finally {
      if (shouldShowLoader && !isStale()) setLoading(false);
    }
  }, [fetchPage, filter, folder, searchQuery, userId]);

  const refreshFirstPage = useCallback(async () => {
    const requestKey = mailboxCacheKey(userId, folder, filter, searchQuery);
    const scope = requestScope();
    try {
      const data = await fetchPage({ key: requestKey, folder, filter, query: searchQuery });
      if (scope !== requestScope() || activeKeyRef.current !== requestKey) return;
      const cached = cacheRef.current.get(requestKey);
      const merged = new Map((data.messages || []).map((message) => [message.id, message]));
      for (const message of cached?.messages || []) {
        if (!merged.has(message.id)) merged.set(message.id, message);
      }
      const snapshot: MailboxSnapshot = {
        messages: [...merged.values()],
        nextPageToken: data.nextPageToken || null,
        resultSize: data.resultSizeEstimate || cached?.resultSize || 0,
        cachedAt: Date.now(),
        complete: Boolean(cached?.complete) && !data.nextPageToken,
      };
      cacheRef.current.set(requestKey, snapshot);
      setMessages(snapshot.messages);
      setNextPageToken(snapshot.nextPageToken);
      setResultSize(snapshot.resultSize);
      onStatusPayloadRef.current(data);
    } catch {
      // Silencioso: a atualização automática tenta de novo no próximo ciclo.
    }
  }, [fetchPage, filter, folder, searchQuery, userId]);

  const prefetchMailbox = useCallback(async (targetFolder: string) => {
    const scope = requestScope();
    const requestKey = mailboxCacheKey(userId, targetFolder, "all", "");
    if (cacheRef.current.has(requestKey)) return;
    try {
      const data = await fetchPage({ key: requestKey, folder: targetFolder, filter: "all", query: "" });
      if (scope !== requestScope()) return;
      cacheRef.current.set(requestKey, {
        messages: data.messages || [],
        nextPageToken: data.nextPageToken || null,
        resultSize: data.resultSizeEstimate || 0,
        cachedAt: Date.now(),
        complete: !data.nextPageToken,
      });
    } catch {
      // O pre-carregamento e oportunista; a navegacao normal continua exibindo erros quando necessario.
    }
  }, [fetchPage, userId]);

  // Pastas são carregadas quando abertas. Aquecer sete caixas em paralelo com
  // a paginação gastava a cota necessária para abrir o corpo de uma mensagem.

  // Carrega a caixa atual com sincronização progressiva; caixas completas em
  // cache não refazem I/O. A atualização automática fica em efeito separado.
  useEffect(() => {
    if (!connected) return undefined;
    syncGenerationRef.current += 1;
    onMailboxChangedRef.current?.();
    const cached = cacheRef.current.get(currentMailboxKey);
    if (cached) {
      setMessages(cached.messages);
      setNextPageToken(cached.nextPageToken);
      setResultSize(cached.resultSize);
      setLoading(false);
      setSyncState({ active: false, loaded: cached.messages.length, estimated: cached.resultSize, done: Boolean(cached.complete), error: null });
      if (cached.complete) return undefined;
    } else {
      setMessages([]);
      setNextPageToken(null);
      setResultSize(0);
    }
    void syncMailbox();
    return () => { syncGenerationRef.current += 1; };
  }, [connected, currentMailboxKey, syncMailbox]);

  // Atualização automática barata: primeira página mesclada ao que está em
  // memória, sem baixar novamente as páginas já obtidas.
  useEffect(() => {
    if (!connected || !autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshFirstPage();
      onRefreshLabelsRef.current();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connected, refreshFirstPage]);

  // Outras telas avisam que o correio mudou (ex.: envio feito pela Nora).
  useEffect(() => {
    if (!connected) return undefined;
    const refresh = () => {
      void refreshFirstPage();
      onRefreshLabelsRef.current();
    };
    window.addEventListener("emails:changed", refresh);
    return () => window.removeEventListener("emails:changed", refresh);
  }, [connected, refreshFirstPage]);

  return {
    messages,
    setMessages,
    nextPageToken,
    resultSize,
    loading,
    setLoading,
    fetchMessages,
    syncMailbox,
    refreshFirstPage,
    syncState,
    prefetchMailbox,
    currentMailboxKey,
    cacheRef,
    inFlightRef,
  };
}
