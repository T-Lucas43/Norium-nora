import { useCallback, useEffect, useRef, useState } from "react";
import { requestScope } from "../../core/api/sessionScope";
import type { ChatConversa } from "./types";
import { whatsappApi } from "./whatsappApi";

type Result = { key: string; items: ChatConversa[]; nextOffset: number | null; total: number };

export function useConversationSearch(text: string, onFound?: (items: ChatConversa[]) => void) {
  const scope = requestScope(); const query = text.trim(); const key = `${scope}:${query}`;
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const active = useRef(key); active.current = key;
  const callback = useRef(onFound); callback.current = onFound;
  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    if (!query || typeof whatsappApi.conversationPage !== "function") return;
    setLoading(true); setError("");
    try {
      const page = await whatsappApi.conversationPage(offset, query, signal);
      if (signal?.aborted || active.current !== key || requestScope() !== scope) return;
      setResult(current => ({ key, items: offset && current?.key === key ? [...current.items, ...page.items] : page.items,
        nextOffset: page.nextOffset, total: page.total }));
      callback.current?.(page.items);
    } catch (err) {
      if (!signal?.aborted && active.current === key) setError(err instanceof Error ? err.message : "Busca indisponível. Mostrando o cache local.");
    } finally { if (!signal?.aborted && active.current === key) setLoading(false); }
  }, [query, key, scope]);
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setError(""); setLoading(false);
    const timer = query ? setTimeout(() => void load(0, controller.signal), 300) : undefined;
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load, query]);
  const current = result?.key === key ? result : null;
  return { matching: current ? new Set(current.items.map(item => item.id)) : null, loading, error,
    total: current?.total, hasMore: current?.nextOffset != null,
    more: () => { if (current?.nextOffset != null && !loading) void load(current.nextOffset); } };
}
