import type { ReactNode } from "react";
import { Loader2, Paperclip, Reply, Sparkles } from "lucide-react";
import Button from "../shared/Button";
import AttachmentPreview from "./AttachmentPreview";
import type { ComposeAttachment } from "../../features/mail/types";

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
}: MailReplyBoxProps) {
  return (
    <div className="mail-card mt-5 rounded-lg border border-white/10 bg-[#121217]">
      <textarea
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        placeholder="Escreva sua resposta..."
        className="h-28 w-full resize-none bg-transparent p-4 text-sm font-medium text-white outline-none placeholder:text-white/35"
      />
      {attachments.length > 0 && <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />}
      {suggestionPanel}
      <div className="flex items-center justify-between border-t border-white/10 p-3">
        <div className="flex items-center gap-2">
          <label className="flex h-9 w-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/7">
            <Paperclip size={17} />
            <span className="sr-only">Anexar arquivo a resposta</span>
            <input type="file" multiple className="hidden" onChange={(event) => onAddFiles(event.target.files)} />
          </label>
          {canUseNora && (
            <Button
              size="sm"
              onClick={onAskNora}
              disabled={noraSuggesting !== null}
              className="mail-hover border-cyan-400/25 text-cyan-300 hover:bg-cyan-400/10"
            >
              {noraSuggesting === "reply" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              Gerar sugestao
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={sending || !text.trim()}
          onClick={onSend}
          className="mail-primary bg-[#0EA5E9]"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Reply size={15} />}
          Responder
        </Button>
      </div>
    </div>
  );
}
