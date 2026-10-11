import type { ReactNode } from "react";
import { Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";
import AttachmentPreview from "../AttachmentPreview";
import type { ComposeState } from "../../../features/mail/types";
import MessageTemplatePicker from "../../message-templates/MessageTemplatePicker";

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

/** Janela de nova mensagem (canto inferior direito, como no layout aprovado). */
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
    <div className="nx-mail-layer nx-mail-compose-wrap">
      <div className="nx-mail-compose-card" role="dialog" aria-label="Nova mensagem">
        <div className="nx-mail-compose-h">
          <h2>Nova mensagem</h2>
          <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="nx-mail-compose-row">
          <span>Para</span>
          <input
            value={compose.to}
            onChange={(event) => onChange({ ...compose, to: event.target.value })}
            placeholder="Para"
            aria-label="Para"
            className="nx-mail-field"
          />
        </div>
        <div className="nx-mail-compose-row">
          <span>Cc / Cco</span>
          <input
            value={compose.cc}
            onChange={(event) => onChange({ ...compose, cc: event.target.value })}
            placeholder="Cc"
            aria-label="Cc"
            className="nx-mail-field"
          />
          <input
            value={compose.bcc}
            onChange={(event) => onChange({ ...compose, bcc: event.target.value })}
            placeholder="Cco"
            aria-label="Cco"
            className="nx-mail-field"
          />
        </div>
        <div className="nx-mail-compose-row">
          <span>Assunto</span>
          <input
            value={compose.subject}
            onChange={(event) => onChange({ ...compose, subject: event.target.value })}
            placeholder="Assunto"
            aria-label="Assunto"
            className="nx-mail-field"
          />
        </div>

        <textarea
          value={compose.body}
          onChange={(event) => onChange({ ...compose, body: event.target.value })}
          placeholder="Digite sua mensagem"
          aria-label="Mensagem"
          className="nx-mail-compose-body"
        />

        {compose.attachments.length > 0 && (
          <AttachmentPreview attachments={compose.attachments} onRemove={onRemoveAttachment} />
        )}
        {suggestionPanel}

        <div className="nx-mail-compose-foot">
          <button type="button" onClick={onSend} disabled={sending || semDestinatario} className="nx-btn is-primary">
            {sending ? <Loader2 size={15} className="nx-mail-spin" /> : <Send size={15} />}
            Enviar
          </button>
          <button
            type="button"
            onClick={onSaveDraft}
            disabled={sending || semDestinatario}
            className="nx-btn is-sm is-ghost"
          >
            Salvar rascunho
          </button>
          <label className="nx-mail-attach-btn" title="Anexar arquivo">
            <Paperclip size={16} />
            <span className="sr-only">Anexar arquivo</span>
            <input type="file" multiple className="hidden" onChange={(event) => onAddFiles(event.target.files)} />
          </label>
          <MessageTemplatePicker channel="email" onApply={({ subject, body }) => onChange({ ...compose, subject: subject || compose.subject, body })} />
          {canUseNora && (
            <button
              type="button"
              onClick={onAskNora}
              disabled={noraSuggesting !== null}
              className="nx-btn is-sm nx-mail-push"
            >
              {noraSuggesting === "compose" ? <Loader2 size={14} className="nx-mail-spin" /> : <Sparkles size={14} />}
              Gerar sugestão
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
