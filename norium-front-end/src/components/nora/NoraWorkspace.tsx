import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, History, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { ApiError, apiRequest } from "../../core/api/client";
import type { EventSource, OmnichannelEvent, PerfilOperador } from "../../types/omnichannel";
import Nora, { type NoraConversationState } from "../layout/Nora";
import NoraAvatar from "../layout/NoraAvatar";
import Button from "../shared/Button";
import { showConfirm, showPrompt } from "../shared/AppDialogProvider";
import { ConversationWriter, draftConversation, type ConversationSummary, type SavedConversation } from "./conversationHistory";
import "./noraWorkspace.css";

export default function NoraWorkspace({ userId, profile, eventsBySource, onOpenEmail }: {
  userId: string; profile: PerfilOperador | null; eventsBySource: Partial<Record<EventSource, OmnichannelEvent[]>>; onOpenEmail: (id: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<SavedConversation>(() => draftConversation());
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(() => window.innerWidth > 900);
  const [fetching, setFetching] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Pronta para conversar");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writerRef = useRef<ConversationWriter | null>(null);
  const onSaved = useCallback((summary: ConversationSummary) => {
    if (!mounted.current) return;
    setConversations((current) => [summary, ...current.filter((item) => item.id !== summary.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);
  if (!writerRef.current) writerRef.current = new ConversationWriter(active, onSaved);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try { await writerRef.current?.flush(); if (mounted.current) { setError(""); setConflict(false); if (writerRef.current?.conversation.state.messages.length) setSaveStatus("Conversa salva"); } return true; }
    catch (reason) { if (mounted.current) { setConflict(reason instanceof ApiError && reason.status === 409); setSaveStatus("Alterações não salvas"); setError(reason instanceof Error ? reason.message : "Não foi possível salvar a conversa."); } return false; }
  }, []);
  const loadHistory = useCallback(async () => {
    setFetching(true);
    try { const records = await apiRequest<ConversationSummary[]>("/api/nora/conversations"); if (mounted.current) setConversations(records); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Não foi possível carregar o histórico."); }
    finally { if (mounted.current) setFetching(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void loadHistory();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (writerRef.current?.dirty) { event.preventDefault(); } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", beforeUnload); if (timer.current) clearTimeout(timer.current); void writerRef.current?.flush().catch(() => undefined); };
  }, [loadHistory]);

  const onStateChange = useCallback((state: NoraConversationState, running: boolean) => {
    setBusy(running);
    const writer = writerRef.current;
    if (!writer || !state.messages.length) return;
    writer.stage(state);
    if (!writer.dirty) return;
    setSaveStatus("Salvando conversa...");
    if (timer.current) clearTimeout(timer.current);
    // Store the user message and completed answer immediately; coalesce stream deltas.
    if (!running || state.messages.at(-1)?.role === "user") void flush();
    else timer.current = setTimeout(() => { void flush(); }, 800);
  }, [flush]);

  async function selectConversation(id?: string) {
    if (busy || switching) return;
    setSwitching(true);
    try {
      if (!await flush()) return;
      const next = id ? await apiRequest<SavedConversation>(`/api/nora/conversations/${id}`) : draftConversation();
      writerRef.current = new ConversationWriter(next, onSaved);
      setActive(next); setError(""); setSaveStatus(id ? "Conversa salva" : "Pronta para conversar");
      if (window.innerWidth <= 900) setHistoryOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir a conversa."); }
    finally { setSwitching(false); }
  }
  async function saveAsNewConversation() {
    const previous = writerRef.current?.conversation;
    if (!previous || busy) return;
    if (timer.current) clearTimeout(timer.current);
    const next = { ...draftConversation(), title: `${previous.title.slice(0, 140)} (cópia)` };
    const writer = new ConversationWriter(next, onSaved);
    writer.stage(previous.state);
    writerRef.current = writer;
    setActive({ ...next, state: previous.state });
    setConflict(false);
    await flush();
  }
  async function renameConversation() {
    const title = await showPrompt({ title: "Renomear conversa", defaultValue: writerRef.current?.conversation.title, required: true, confirmLabel: "Salvar nome" });
    if (!title) return;
    try { await writerRef.current?.rename(title.slice(0, 160)); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível renomear."); }
  }
  async function removeConversation(item: ConversationSummary) {
    if (!await showConfirm({ title: "Excluir conversa?", description: `O histórico de “${item.title}” será excluído.`, tone: "danger", confirmLabel: "Excluir" })) return;
    setSwitching(true);
    try {
      if (item.id === active.id) {
        if (timer.current) clearTimeout(timer.current);
        // Settle an in-flight save before deletion; failed edits do not block an explicit delete.
        await writerRef.current?.flush().catch(() => undefined);
      }
      await apiRequest(`/api/nora/conversations/${item.id}`, { method: "DELETE" });
      setConversations((current) => current.filter((record) => record.id !== item.id));
      if (item.id === active.id) { const next = draftConversation(); writerRef.current = new ConversationWriter(next, onSaved); setActive(next); setSaveStatus("Pronta para conversar"); }
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível excluir."); }
    finally { setSwitching(false); }
  }
  function exportConversation() {
    const record = writerRef.current?.conversation;
    if (!record) return;
    const content = `# ${record.title}\n\n${record.state.messages.map((message) => `## ${message.role === "user" ? "Você" : "Nora"}\n\n${message.text}`).join("\n\n")}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `nora-${record.id}.md`; link.click(); URL.revokeObjectURL(url);
  }
  const filtered = conversations.filter((item) => `${item.title} ${item.preview}`.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")));
  const activeSummary = conversations.find((item) => item.id === active.id);
  return <div className={`nora-workspace ${historyOpen ? "history-open" : ""}`}>
    {historyOpen && <button className="nora-history-backdrop" aria-label="Fechar histórico" onClick={() => setHistoryOpen(false)} />}
    <aside className="nora-history" aria-label="Histórico da Nora" aria-hidden={!historyOpen} inert={!historyOpen}>
      <div className="nora-history-brand"><NoraAvatar className="h-10 w-10 rounded-lg" /><div><strong>Nora</strong><span>Seu espaço de conversas</span></div><button className="nora-history-close" onClick={() => setHistoryOpen(false)} aria-label="Recolher histórico"><PanelLeftClose size={18} /></button></div>
      <Button variant="primary" className="nora-new-conversation" onClick={() => void selectConversation()} disabled={busy || switching}><Plus size={17} /> Nova conversa</Button>
      <label className="nora-history-search"><Search size={15} /><input aria-label="Buscar conversas" placeholder="Buscar conversas..." value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="nora-history-label"><History size={13} /> Histórico <span>{conversations.length}</span></div>
      <div className="nora-history-list">{fetching ? <div className="nora-history-empty"><Loader2 size={20} className="animate-spin" /> Carregando conversas...</div> : filtered.length === 0 ? <div className="nora-history-empty"><MessageSquare size={24} /><strong>{query ? "Nenhuma conversa encontrada" : "Sua próxima ideia começa aqui"}</strong><p>{query ? "Tente outro título ou termo recente." : "Suas conversas com a Nora aparecem aqui, salvas para quando precisar."}</p></div> : filtered.map((item, index) => {
        const day = new Date(item.updatedAt).toLocaleDateString("pt-BR");
        const previousDay = index ? new Date(filtered[index - 1].updatedAt).toLocaleDateString("pt-BR") : "";
        return <div key={item.id}>{day !== previousDay && <p className="nora-history-date">{day === new Date().toLocaleDateString("pt-BR") ? "Hoje" : day}</p>}<div className={`nora-history-item ${active.id === item.id ? "active" : ""}`}><button disabled={busy || switching} onClick={() => void selectConversation(item.id)} title={item.title} aria-current={active.id === item.id ? "page" : undefined}><MessageSquare size={15} /><span><strong>{item.title}</strong><small>{item.preview || "Conversa com a Nora"}</small></span></button><button className="nora-delete-conversation" aria-label={`Excluir conversa ${item.title}`} disabled={busy || switching} onClick={() => void removeConversation(item)}><Trash2 size={14} /></button></div></div>;
      })}</div><div className="nora-history-footer"><Sparkles size={15} /><span>Ideias, respostas e ações.<br /><strong>Conectadas ao seu Norium.</strong></span></div>
    </aside>
    <section className="nora-workspace-main" aria-label="Conversa com a Nora"><header className="nora-workspace-header"><Button variant="ghost" iconOnly onClick={() => setHistoryOpen(!historyOpen)} aria-label={historyOpen ? "Recolher histórico" : "Abrir histórico"} aria-expanded={historyOpen}>{historyOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</Button><div><h1>{activeSummary?.title || active.title}</h1><p aria-live="polite">{saveStatus === "Conversa salva" && <Check size={11} />}{saveStatus}</p></div><div className="nora-workspace-actions"><Button variant="ghost" iconOnly onClick={() => void renameConversation()} disabled={busy || switching || !activeSummary} aria-label="Renomear conversa"><Pencil size={16} /></Button><Button variant="ghost" iconOnly onClick={exportConversation} disabled={!activeSummary} aria-label="Exportar conversa"><Download size={16} /></Button></div></header>
      {error && <div className="nora-history-error" role="alert"><span>{error}</span>{conflict ? <button disabled={busy} onClick={() => void saveAsNewConversation()}>Salvar como nova conversa</button> : <button onClick={() => void (writerRef.current?.dirty ? flush() : loadHistory())}>Tentar novamente</button>}</div>}
      <div className="nora-workspace-chat" aria-busy={switching}>{switching && <div className="nora-switching"><Loader2 className="animate-spin" /></div>}<Nora key={active.id} open variant="page" onClose={() => undefined} userId={userId} profile={profile} eventsBySource={eventsBySource} activeTab="Nora" initialState={active.state} onStateChange={onStateChange} onOpenEmail={onOpenEmail} /></div>
    </section>
  </div>;
}
