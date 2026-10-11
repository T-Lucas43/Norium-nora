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
    <div ref={rootRef} className="shrink-0">
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
        title="Ações da Nora"
        className={`ml-1 inline-flex h-[26px] items-center gap-1.5 rounded-full pl-1 pr-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${menuOpen || customOpen || reviewOpen ? "bg-[var(--nx-primary)] text-white" : "bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)] hover:brightness-95"}`}
      >
        <NoraAvatar className="h-5 w-5" />
        <span>Nora</span>
      </button>

      {menuOpen && (
        <div role="menu" aria-label="Ações da Nora" className="nx-conv-menu absolute bottom-full left-5 z-[80] mb-2 w-64 overflow-hidden p-1.5">
          <p className="nx-conv-menu-label px-3 pb-1.5 pt-1">Nora na conversa</p>
          <button role="menuitem" onClick={() => void requestDraft("suggest")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left">
            <MessageSquareText size={16} className="text-[var(--nx-primary-text)]" /> Sugerir resposta com a Nora
          </button>
          <button role="menuitem" onClick={() => void requestDraft("summary")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left">
            <ListCollapse size={16} className="text-[var(--nx-primary-text)]" /> Resumir conversa
          </button>
          <button role="menuitem" onClick={() => { setAction("custom"); setMenuOpen(false); setCustomOpen(true); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left">
            <FilePenLine size={16} className="text-[var(--nx-primary-text)]" /> Ação personalizada
          </button>
        </div>
      )}

      {customOpen && (
        <section aria-label="Ação personalizada da Nora" className="nx-conv-menu absolute bottom-full left-5 z-[80] mb-2 w-[390px] max-w-[calc(100vw-24px)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-[var(--nx-primary-text)]" /> Ação personalizada</p>
              <p className="mt-1 text-[12.5px] font-normal text-[var(--nx-text-2)]">Diga o que a Nora deve produzir usando esta conversa.</p>
            </div>
            <button type="button" onClick={cancelPendingRequestAndClose} aria-label="Fechar ação personalizada" className="nx-conv-iconbtn h-8 w-8"><X size={15} /></button>
          </div>
          <label className="nx-conv-label mt-4 block" htmlFor="nora-custom-instruction">Instrução para a Nora</label>
          <textarea
            id="nora-custom-instruction"
            value={customInstruction}
            onChange={(event) => setCustomInstruction(event.target.value)}
            placeholder="Ex.: crie uma resposta cordial confirmando o prazo para amanhã."
            className="nx-conv-field mt-2 h-24 w-full resize-none p-3 text-sm font-normal"
          />
          {error && <p role="alert" className="mt-2 text-xs text-[var(--nx-danger)]">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={cancelPendingRequestAndClose}>Cancelar</Button>
            <Button variant="primary" loading={loading} disabled={!customInstruction.trim()} onClick={() => void requestDraft("custom", customInstruction)}>Gerar para revisar</Button>
          </div>
        </section>
      )}

      {reviewOpen && (
        <section role="dialog" aria-modal="false" aria-labelledby="nora-review-title" className="nx-conv-menu absolute bottom-full left-5 z-[80] mb-2 w-[430px] max-w-[calc(100vw-24px)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p id="nora-review-title" className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-[var(--nx-primary-text)]" /> {action === "summary" ? "Resumo para consulta" : "Revisão obrigatória"}</p>
              <p className="mt-1 text-[12.5px] font-normal text-[var(--nx-text-2)]">{action === "summary" ? "O resumo é somente para leitura e nunca será colocado no campo de mensagem." : `${ACTION_LABELS[action]}. Edite e confirme antes de colocar no campo de mensagem.`}</p>
            </div>
            <button type="button" onClick={closePanels} disabled={loading} aria-label="Fechar revisão da Nora" className="nx-conv-iconbtn h-8 w-8"><X size={15} /></button>
          </div>

          {loading && !draft && <p role="status" className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--nx-primary-soft)] p-3 text-xs text-[var(--nx-primary-text)]"><LoaderCircle size={15} className="animate-spin" /> A Nora está preparando um texto para revisão...</p>}
          {error && <p role="alert" className="mt-3 rounded-lg bg-[var(--nx-danger-soft)] p-3 text-xs text-[var(--nx-danger)]">{error}</p>}

          {draft && (
            <>
              <label htmlFor="nora-reviewed-draft" className="nx-conv-label mt-4 block">{action === "summary" ? "Resumo da conversa" : "Texto sugerido"}</label>
              <textarea
                id="nora-reviewed-draft"
                value={draft}
                onChange={(event) => { if (action !== "summary") setDraft(event.target.value); }}
                readOnly={action === "summary"}
                disabled={loading}
                className="nx-conv-field mt-2 h-36 w-full resize-y p-3 text-sm font-normal leading-6 disabled:opacity-60"
              />
              {action !== "summary" && <>
                <label htmlFor="nora-improvement" className="nx-conv-label mt-3 block">Pedir melhoria à Nora</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="nora-improvement"
                    value={improvement}
                    onChange={(event) => setImprovement(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && improvement.trim() && !loading) void improveDraft(); }}
                    placeholder="Ex.: deixe mais curto e acolhedor"
                    disabled={loading}
                    className="nx-conv-field h-9 min-w-0 flex-1 px-3 text-[13px] font-normal"
                  />
                  <Button loading={loading} disabled={!improvement.trim()} onClick={() => void improveDraft()}>Melhorar</Button>
                </div>
              </>}
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-[var(--nx-border)] pt-3">
                <Button variant="ghost" onClick={closePanels} disabled={loading}>Descartar</Button>
                {action === "summary"
                  ? <Button variant="primary" onClick={() => void copySummary()} disabled={loading || !draft.trim()}><Copy size={14} /> {summaryCopied ? "Resumo copiado" : "Copiar resumo"}</Button>
                  : <Button variant="primary" onClick={acceptDraft} disabled={loading || !draft.trim()}>Confirmar e inserir</Button>}
              </div>
              <p className="mt-2 text-right text-[11px] font-normal text-[var(--nx-text-3)]">{action === "summary" ? "O resumo não altera nem prepara uma mensagem." : "A mensagem não será enviada automaticamente."}</p>
            </>
          )}
        </section>
      )}

      {loading && !reviewOpen && !customOpen && (
        <div role="status" className="nx-conv-menu absolute bottom-full left-5 z-[80] mb-2 flex w-64 items-center gap-2 p-3 text-xs text-[var(--nx-primary-text)]">
          <LoaderCircle size={15} className="animate-spin" /> Consultando a Nora...
        </div>
      )}
    </div>
  );
}
