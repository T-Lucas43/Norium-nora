import type { ReactNode } from "react";
import { Loader2, Paperclip, Reply, Sparkles } from "lucide-react";
import AttachmentPreview from "./AttachmentPreview";
import type { ComposeAttachment } from "../../features/mail/types";
import MessageTemplatePicker from "../message-templates/MessageTemplatePicker";
import { useQuickReplies } from "../message-templates/useQuickReplies";

type MailReplyBoxProps = {
  text: string;
  attachments: ComposeAttachment[];
  sending: boolean;
  canUseNora: boolean;
  noraSuggesting: "compose" | "reply" | null;
  suggestionPanel?: ReactNode;
  onTextChange: (value: string) => void;
  onAddFiles: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onAskNora: () => void;
  onSend: () => void;
  templateVariables?: Record<string, string>;
};

/** Caixa de resposta rapida no rodape da leitura do e-mail. */
export default function MailReplyBox({
  text,
  attachments,
  sending,
  canUseNora,
  noraSuggesting,
  suggestionPanel,
  onTextChange,
  onAddFiles,
  onRemoveAttachment,
  onAskNora,
  onSend,
  templateVariables,
}: MailReplyBoxProps) {
  const quick = useQuickReplies({ channel: "email", text, variables: templateVariables, onApply: ({ body }) => onTextChange(body) });
  return (
    <div className="nx-mail-reply">
      <div className="nx-mail-reply-h">
        <Reply size={15} />
        Responder
      </div>
      {quick.panel}
      <textarea
        {...quick.inputProps}
        onKeyDown={quick.onKeyDown}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        placeholder="Escreva sua resposta..."
        aria-label="Resposta"
        className="nx-mail-textarea"
      />
      {quick.missingVariables.length > 0 && <p role="status">Preencha antes de enviar: {quick.missingVariables.join(", ")}.</p>}
      {attachments.length > 0 && <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />}
      {suggestionPanel}
      <div className="nx-mail-reply-foot">
        <div>
          <button
            type="button"
            disabled={sending || !text.trim() || quick.missingVariables.length > 0}
            onClick={onSend}
            className="nx-btn is-sm is-primary"
          >
            {sending ? <Loader2 size={14} className="nx-mail-spin" /> : <Reply size={14} />}
            Responder
          </button>
          {canUseNora && (
            <button
              type="button"
              onClick={onAskNora}
              disabled={noraSuggesting !== null}
              className="nx-btn is-sm"
            >
              {noraSuggesting === "reply" ? <Loader2 size={14} className="nx-mail-spin" /> : <Sparkles size={14} />}
              Gerar sugestão
            </button>
          )}
        </div>
        <div>
          <label className="nx-mail-attach-btn" title="Anexar arquivo à resposta">
            <Paperclip size={16} />
            <span className="sr-only">Anexar arquivo à resposta</span>
            <input type="file" multiple className="hidden" onChange={(event) => onAddFiles(event.target.files)} />
          </label>
          <MessageTemplatePicker channel="email" templateVariables={templateVariables} onApply={({ body }) => onTextChange(body)} />
        </div>
      </div>
    </div>
  );
}
