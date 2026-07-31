import type { ReactNode } from "react";
import { Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";
import Button from "../../shared/Button";
import AttachmentPreview from "../AttachmentPreview";
import type { ComposeState } from "../../../features/mail/types";

type ComposeModalProps = {
  compose: ComposeState;
  sending: boolean;
  canUseNora: boolean;
  /** Alvo em geracao no momento; trava os botoes de sugestao enquanto houver um. */
  noraSuggesting: "compose" | "reply" | null;
  /** Painel de sugestao da Nora, montado pelo dashboard. */
  suggestionPanel?: ReactNode;
  onChange: (compose: ComposeState) => void;
  onAddFiles: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onAskNora: () => void;
  onSaveDraft: () => void;
  onSend: () => void;
  onClose: () => void;
};

/** Janela de nova mensagem. */
export default function ComposeModal({
  compose,
  sending,
  canUseNora,
  noraSuggesting,
  suggestionPanel,
  onChange,
  onAddFiles,
  onRemoveAttachment,
  onAskNora,
  onSaveDraft,
  onSend,
  onClose,
}: ComposeModalProps) {
  const semDestinatario = !compose.to.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/45 p-6">
      <div className="mail-modal flex h-[680px] w-[680px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
        <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
          <h2 className="text-sm font-bold">Nova mensagem</h2>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="hover:bg-white/7" aria-label="Fechar">
            <X size={17} />
          </Button>
        </div>

        <div className="grid gap-0 border-b border-white/10">
          <input
            value={compose.to}
            onChange={(event) => onChange({ ...compose, to: event.target.value })}
            placeholder="Para"
            className="h-11 border-b border-white/8 bg-transparent px-4 text-sm outline-none placeholder:text-white/35"
          />
          <div className="grid grid-cols-2 border-b border-white/8">
            <input
              value={compose.cc}
              onChange={(event) => onChange({ ...compose, cc: event.target.value })}
              placeholder="Cc"
              className="h-11 border-r border-white/8 bg-transparent px-4 text-sm outline-none placeholder:text-white/35"
            />
            <input
              value={compose.bcc}
              onChange={(event) => onChange({ ...compose, bcc: event.target.value })}
              placeholder="Cco"
              className="h-11 bg-transparent px-4 text-sm outline-none placeholder:text-white/35"
            />
          </div>
          <input
            value={compose.subject}
            onChange={(event) => onChange({ ...compose, subject: event.target.value })}
            placeholder="Assunto"
            className="h-11 bg-transparent px-4 text-sm outline-none placeholder:text-white/35"
          />
        </div>

        <textarea
          value={compose.body}
          onChange={(event) => onChange({ ...compose, body: event.target.value })}
          placeholder="Digite sua mensagem"
          className="min-h-0 flex-1 resize-none bg-transparent p-4 text-sm leading-6 outline-none placeholder:text-white/35"
        />

        {compose.attachments.length > 0 && (
          <AttachmentPreview attachments={compose.attachments} onRemove={onRemoveAttachment} />
        )}
        {suggestionPanel}

        <div className="flex items-center justify-between border-t border-white/10 p-3">
          <div className="flex items-center gap-2">
            <label className="mail-hover flex h-10 w-10 items-center justify-center rounded-lg border border-white/12 text-white/75 hover:bg-white/7">
              <Paperclip size={18} />
              <span className="sr-only">Anexar arquivo</span>
              <input type="file" multiple className="hidden" onChange={(event) => onAddFiles(event.target.files)} />
            </label>
            {canUseNora && (
              <Button
                onClick={onAskNora}
                disabled={noraSuggesting !== null}
                className="mail-hover border-cyan-400/25 text-cyan-300 hover:bg-cyan-400/10"
              >
                {noraSuggesting === "compose" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                Gerar sugestao
              </Button>
            )}
            <Button
              onClick={onSaveDraft}
              disabled={sending || semDestinatario}
              className="mail-hover border-white/12 text-white/75 hover:bg-white/7"
            >
              Salvar rascunho
            </Button>
          </div>
          <Button variant="ghost" onClick={onSend} disabled={sending || semDestinatario} className="mail-primary bg-[#0EA5E9]">
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Enviar
          </Button>
        </div>
      </div>
    </div>
  );
}
