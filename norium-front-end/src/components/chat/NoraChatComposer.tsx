import { useEffect, useRef, useState } from "react";
import { Copy, FilePenLine, ListCollapse, LoaderCircle, MessageSquareText, Sparkles, X } from "lucide-react";

import NoraAvatar from "../layout/NoraAvatar";
import Button from "../shared/Button";
import { noraChatApi } from "./noraChatApi";
import { noraDraftForInsertion } from "./noraDraft";

type NoraAction = "suggest" | "summary" | "custom";

type NoraChatComposerProps = {
  conversationId: string;
  disabled?: boolean;
  onInsertDraft: (text: string) => void;
};

const ACTION_LABELS: Record<NoraAction, string> = {
  suggest: "Sugerir resposta com a Nora",
  summary: "Resumir conversa",
  custom: "Ação personalizada",
};

export default function NoraChatComposer({ conversationId, disabled = false, onInsertDraft }: NoraChatComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [action, setAction] = useState<NoraAction>("suggest");
  const [customInstruction, setCustomInstruction] = useState("");
  const [draft, setDraft] = useState("");
  const [improvement, setImprovement] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summaryCopied, setSummaryCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const closePanels = () => {
    setMenuOpen(false);
    setCustomOpen(false);
    setReviewOpen(false);
    setError("");
    setDraft("");
    setImprovement("");
    setSummaryCopied(false);
  };

  const cancelPendingRequestAndClose = () => {
    requestIdRef.current += 1;
    busyRef.current = false;
    setLoading(false);
    closePanels();
  };

  useEffect(() => {
    requestIdRef.current += 1;
    busyRef.current = false;
    setLoading(false);
    closePanels();
    setCustomInstruction("");
  }, [conversationId]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node) && !loading) closePanels();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) closePanels();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [loading]);

  const requestDraft = async (selectedAction: NoraAction, instruction = "") => {
    if (busyRef.current) return;
    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    setAction(selectedAction);
    setLoading(true);
    setError("");
    setDraft("");
    setImprovement("");
    setMenuOpen(false);
    try {
      const result = selectedAction === "suggest"
        ? await noraChatApi.suggestReply(conversationId)
        : selectedAction === "summary"
          ? await noraChatApi.summarizeConversation(conversationId)
          : await noraChatApi.runCustomAction(conversationId, instruction);
      if (requestIdRef.current !== requestId) return;
      setDraft(result);
      setCustomOpen(false);
      setReviewOpen(true);
    } catch (requestError) {
      if (requestIdRef.current !== requestId) return;
      setError(requestError instanceof Error ? requestError.message : "Não foi possível consultar a Nora.");
      if (selectedAction !== "custom") setReviewOpen(true);
    } finally {
      if (requestIdRef.current === requestId) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  };

  const improveDraft = async () => {
    if (busyRef.current || !draft.trim() || !improvement.trim()) return;
    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await noraChatApi.improveDraft(conversationId, draft, improvement);
      if (requestIdRef.current !== requestId) return;
      setDraft(result);
      setImprovement("");
    } catch (requestError) {
      if (requestIdRef.current !== requestId) return;
      setError(requestError instanceof Error ? requestError.message : "Não foi possível melhorar o texto.");
    } finally {
      if (requestIdRef.current === requestId) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  };

  const acceptDraft = () => {
    const reviewedDraft = noraDraftForInsertion(draft);
    if (!reviewedDraft || action === "summary") return;
    onInsertDraft(reviewedDraft);
    closePanels();
    setDraft("");
    setImprovement("");
  };

  const copySummary = async () => {
    const summary = draft.trim();
    if (!summary || action !== "summary") return;
    await navigator.clipboard?.writeText(summary);
    setSummaryCopied(true);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => {
          setMenuOpen((open) => !open);
          setCustomOpen(false);
          setReviewOpen(false);
          setError("");
        }}
        aria-label="Abrir ações da Nora"
        aria-expanded={menuOpen || customOpen || reviewOpen}
        className={`grid h-11 w-11 place-items-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-50 ${menuOpen || customOpen || reviewOpen ? "border-cyan-400/60 bg-cyan-400/10" : "border-[var(--border)] bg-[var(--background)] hover:border-cyan-400/45 hover:bg-cyan-400/[0.07]"}`}
      >
        <NoraAvatar className="h-7 w-7" />
      </button>

      {menuOpen && (
        <div role="menu" aria-label="Ações da Nora" className="absolute bottom-full right-0 z-[80] mb-2 w-64 overflow-hidden rounded-xl border border-cyan-400/25 bg-[#05080d] p-1.5 text-[var(--text)] shadow-2xl shadow-black/70">
          <p className="px-3 pb-1.5 pt-1 text-[10px] font-black uppercase tracking-[0.14em] text-cyan-300">Nora na conversa</p>
          <button role="menuitem" onClick={() => void requestDraft("suggest")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-bold hover:bg-white/[0.06]">
            <MessageSquareText size={16} className="text-cyan-300" /> Sugerir resposta com a Nora
          </button>
          <button role="menuitem" onClick={() => void requestDraft("summary")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-bold hover:bg-white/[0.06]">
            <ListCollapse size={16} className="text-cyan-300" /> Resumir conversa
          </button>
          <button role="menuitem" onClick={() => { setAction("custom"); setMenuOpen(false); setCustomOpen(true); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-bold hover:bg-white/[0.06]">
            <FilePenLine size={16} className="text-cyan-300" /> Ação personalizada
          </button>
        </div>
      )}

      {customOpen && (
        <section aria-label="Ação personalizada da Nora" className="absolute bottom-full right-0 z-[80] mb-2 w-[390px] max-w-[calc(100vw-24px)] rounded-2xl border border-cyan-400/25 bg-[#05080d] p-4 text-[var(--text)] shadow-2xl shadow-black/70">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-black"><Sparkles size={16} className="text-cyan-300" /> Ação personalizada</p>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Diga o que a Nora deve produzir usando esta conversa.</p>
            </div>
            <button type="button" onClick={cancelPendingRequestAndClose} aria-label="Fechar ação personalizada" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/[0.06]"><X size={15} /></button>
          </div>
          <label className="mt-4 block text-xs font-bold" htmlFor="nora-custom-instruction">Instrução para a Nora</label>
          <textarea
            id="nora-custom-instruction"
            value={customInstruction}
            onChange={(event) => setCustomInstruction(event.target.value)}
            placeholder="Ex.: crie uma resposta cordial confirmando o prazo para amanhã."
            className="mt-2 h-24 w-full resize-none rounded-xl border border-[var(--border)] bg-black/50 p-3 text-sm outline-none focus:border-cyan-400/60"
          />
          {error && <p role="alert" className="mt-2 text-xs font-bold text-red-400">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={cancelPendingRequestAndClose}>Cancelar</Button>
            <Button loading={loading} disabled={!customInstruction.trim()} onClick={() => void requestDraft("custom", customInstruction)} className="bg-cyan-600 hover:bg-cyan-500">Gerar para revisar</Button>
          </div>
        </section>
      )}

      {reviewOpen && (
        <section role="dialog" aria-modal="false" aria-labelledby="nora-review-title" className="absolute bottom-full right-0 z-[80] mb-2 w-[430px] max-w-[calc(100vw-24px)] rounded-2xl border border-cyan-400/25 bg-[#05080d] p-4 text-[var(--text)] shadow-2xl shadow-black/70">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p id="nora-review-title" className="flex items-center gap-2 text-sm font-black"><Sparkles size={16} className="text-cyan-300" /> {action === "summary" ? "Resumo para consulta" : "Revisão obrigatória"}</p>
              <p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">{action === "summary" ? "O resumo é somente para leitura e nunca será colocado no campo de mensagem." : `${ACTION_LABELS[action]}. Edite e confirme antes de colocar no campo de mensagem.`}</p>
            </div>
            <button type="button" onClick={closePanels} disabled={loading} aria-label="Fechar revisão da Nora" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/[0.06] disabled:opacity-50"><X size={15} /></button>
          </div>

          {loading && !draft && <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-cyan-400/[0.07] p-3 text-xs font-bold text-cyan-200"><LoaderCircle size={15} className="animate-spin" /> A Nora está preparando um texto para revisão...</p>}
          {error && <p role="alert" className="mt-3 rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-300">{error}</p>}

          {draft && (
            <>
              <label htmlFor="nora-reviewed-draft" className="mt-4 block text-xs font-bold text-cyan-200">{action === "summary" ? "Resumo da conversa" : "Texto sugerido"}</label>
              <textarea
                id="nora-reviewed-draft"
                value={draft}
                onChange={(event) => { if (action !== "summary") setDraft(event.target.value); }}
                readOnly={action === "summary"}
                disabled={loading}
                className="mt-2 h-36 w-full resize-y rounded-xl border border-[var(--border)] bg-black/50 p-3 text-sm font-medium leading-6 outline-none focus:border-cyan-400/60 disabled:opacity-60"
              />
              {action !== "summary" && <>
                <label htmlFor="nora-improvement" className="mt-3 block text-xs font-bold">Pedir melhoria à Nora</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="nora-improvement"
                    value={improvement}
                    onChange={(event) => setImprovement(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && improvement.trim() && !loading) void improveDraft(); }}
                    placeholder="Ex.: deixe mais curto e acolhedor"
                    disabled={loading}
                    className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-black/50 px-3 text-xs font-semibold outline-none focus:border-cyan-400/60"
                  />
                  <Button loading={loading} disabled={!improvement.trim()} onClick={() => void improveDraft()}>Melhorar</Button>
                </div>
              </>}
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-white/[0.07] pt-3">
                <Button variant="ghost" onClick={closePanels} disabled={loading}>Descartar</Button>
                {action === "summary"
                  ? <Button onClick={() => void copySummary()} disabled={loading || !draft.trim()} className="bg-cyan-600 hover:bg-cyan-500"><Copy size={14} /> {summaryCopied ? "Resumo copiado" : "Copiar resumo"}</Button>
                  : <Button onClick={acceptDraft} disabled={loading || !draft.trim()} className="bg-cyan-600 hover:bg-cyan-500">Confirmar e inserir</Button>}
              </div>
              <p className="mt-2 text-right text-[10px] font-semibold text-[var(--text-secondary)]">{action === "summary" ? "O resumo não altera nem prepara uma mensagem." : "A mensagem não será enviada automaticamente."}</p>
            </>
          )}
        </section>
      )}

      {loading && !reviewOpen && !customOpen && (
        <div role="status" className="absolute bottom-full right-0 z-[80] mb-2 flex w-64 items-center gap-2 rounded-xl border border-cyan-400/25 bg-[#05080d] p-3 text-xs font-bold text-cyan-200 shadow-2xl">
          <LoaderCircle size={15} className="animate-spin" /> Consultando a Nora...
        </div>
      )}
    </div>
  );
}
