import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../core/api/client";
import type { TeamMessage, TeamResourceCard } from "./teamChatTypes";

export type TeamContentTab = "chat" | "files" | "photos" | "replies" | "pins" | "tasks";
export type TeamContext = "details" | "reply" | "search" | null;
export type TeamSearchFilter = { q: string; authorId: string; withFile: boolean; since: string; until: string };

export function useTeamCollaboration({ threadId, token, messages, visibleMessageIds, tab, setError }: { threadId: string; token: string; messages: TeamMessage[]; visibleMessageIds?: string[]; tab: TeamContentTab; setError: (error: string) => void }) {
  const [context, setContext] = useState<TeamContext>(null);
  const [root, setRoot] = useState<TeamMessage | null>(null);
  const [replies, setReplies] = useState<TeamMessage[]>([]);
  const [replyMore, setReplyMore] = useState(false);
  const [replyLoading, setReplyLoading] = useState(false);
  const [cards, setCards] = useState<Record<string, TeamResourceCard[]>>({});
  const [collection, setCollection] = useState<TeamMessage[]>([]);
  const [tasks, setTasks] = useState<TeamResourceCard[]>([]);
  const [results, setResults] = useState<TeamMessage[]>([]);
  const [resultsMore, setResultsMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const thread = useRef(threadId); thread.current = threadId;
  const rootRef = useRef(root); rootRef.current = root;
  const searchSequence = useRef(0);
  const request = useCallback(async (path: string, init?: RequestInit) => {
    return apiRequest<Awaited<ReturnType<Response["json"]>>>(`/api/team-chat${path}`, { ...init, token, timeoutMs: path.includes("/nora") || path.includes("/transcription") ? 120000 : undefined });
  }, [token]);
  useEffect(() => { setContext(null); setRoot(null); setReplies([]); setCards({}); setCollection([]); setTasks([]); setResults([]); searchSequence.current++; }, [threadId, token]);
  const refIds = useMemo(() => { const visible = visibleMessageIds ? new Set(visibleMessageIds) : null; return [...messages.filter((message) => !visible || visible.has(message.id)), ...replies, ...(root ? [root] : [])].filter((message) => message.resourceRefs?.length || message.metadata?.taskId || message.metadata?.documentId || message.metadata?.meetingId).map((message) => message.id); }, [messages, visibleMessageIds, replies, root]);
  const cardKey = refIds.join(",");
  useEffect(() => {
    if (!cardKey) return;
    let cancelled = false;
    const requestedThread = threadId;
    void request("/resource-cards", { method: "POST", body: JSON.stringify({ messageIds: cardKey.split(",").slice(-100) }) }).then((data) => { if (!cancelled && requestedThread === thread.current) setCards(data.cards || {}); }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [cardKey, threadId, request, epoch, setError]);
  useEffect(() => {
    if (!threadId || !["replies", "pins", "tasks"].includes(tab)) return;
    let cancelled = false;
    const path = tab === "replies" ? "/reply-threads" : tab === "pins" ? "/pinned-messages" : "/conversation-tasks";
    void request(`${path}?threadId=${encodeURIComponent(threadId)}`).then((data) => { if (!cancelled) { setCollection(data.messages || []); setTasks(data.tasks || []); } }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [threadId, tab, request, epoch, setError]);
  async function openReply(message: TeamMessage, earlier = false) {
    const id = message.replyThreadId || message.id;
    const selected = thread.current;
    setContext("reply"); setReplyLoading(true);
    if (!earlier) { setRoot(message); setReplies([]); }
    rootRef.current = message;
    try {
      const data = await request(`/messages/${encodeURIComponent(id)}/replies${earlier && replies.length ? `?before=${encodeURIComponent(replies[0].id)}` : ""}`);
      if (selected !== thread.current || rootRef.current?.id !== message.id) return;
      setRoot(data.root); setReplies((current) => earlier ? [...data.messages, ...current] : data.messages || []); setReplyMore(Boolean(data.hasMore));
    } catch (error) { setError(error instanceof Error ? error.message : "Falha ao carregar o fio."); }
    finally { if (selected === thread.current) setReplyLoading(false); }
  }
  async function pin(message: TeamMessage) {
    try { const data = await request(`/messages/${encodeURIComponent(message.id)}/pin`, { method: "PATCH", body: JSON.stringify({ pinned: !message.metadata?.pinnedAt }) }); handleMessage(data.message); return data.message as TeamMessage; }
    catch (error) { setError(error instanceof Error ? error.message : "Falha ao fixar a mensagem."); }
  }
  async function search(filter: TeamSearchFilter, more = false) {
    const sequence = ++searchSequence.current;
    setSearchLoading(true);
    const params = new URLSearchParams({ q: filter.q, threadId, offset: more ? String(results.length) : "0" });
    if (filter.authorId) params.set("authorId", filter.authorId);
    if (filter.withFile) params.set("withFile", "true");
    if (filter.since) params.set("since", new Date(`${filter.since}T00:00:00`).toISOString());
    if (filter.until) params.set("until", new Date(`${filter.until}T23:59:59`).toISOString());
    try { const data = await request(`/search?${params}`); if (sequence !== searchSequence.current) return; setResults((current) => more ? [...current, ...data.messages] : data.messages || []); setResultsMore(Boolean(data.hasMore)); }
    catch (error) { if (sequence === searchSequence.current) setError(error instanceof Error ? error.message : "Falha ao buscar."); }
    finally { if (sequence === searchSequence.current) setSearchLoading(false); }
  }
  function handleMessage(message: TeamMessage) {
    if (message.replyThreadId && message.replyThreadId === rootRef.current?.id) setReplies((current) => [...current.filter((item) => item.id !== message.id), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    if (message.id === rootRef.current?.id) setRoot(message);
    if (message.threadId === thread.current) setEpoch((value) => value+1);
  }
  return { context, setContext, root, replies, replyMore, replyLoading, openReply, cards, collection, tasks, pin, search, results, resultsMore, searchLoading, handleMessage, invalidate: () => setEpoch((value) => value+1), request };
}
