import { Check, Paperclip, Star } from "lucide-react";
import { cn } from "../../utils/cn";
import { classifyEmailCategory, emailCategoryMeta, initials } from "../../features/mail/formatters";
import type { GmailMessage } from "../../features/mail/types";

type MailMessageRowProps = {
  message: GmailMessage;
  selected: boolean;
  checked: boolean;
  compactMode: boolean;
  showPreview: boolean;
  groupByCategory: boolean;
  onOpen: () => void;
  onToggleCheck: () => void;
  onToggleStar: () => void;
};

/** Linha da lista de mensagens. */
export default function MailMessageRow({
  message,
  selected,
  checked,
  compactMode,
  showPreview,
  groupByCategory,
  onOpen,
  onToggleCheck,
  onToggleStar,
}: MailMessageRowProps) {
  const categoryMeta = emailCategoryMeta[classifyEmailCategory(message)];

  return (
    <button
      onClick={onOpen}
      className={cn(
        "mail-row grid w-full grid-cols-[42px_28px_minmax(160px,0.32fr)_1fr_96px] items-center gap-2 border-b border-white/9 px-4 text-left transition hover:bg-white/5",
        compactMode ? "min-h-[42px]" : "min-h-[54px]",
        selected && "mail-active bg-white/7",
        message.unread && "bg-white/[0.035]",
      )}
    >
      {/* Selecao e estrela ficam dentro da linha: paramos a propagacao para
          nao abrir a mensagem ao usar esses controles. */}
      <span
        onClick={(event) => {
          event.stopPropagation();
          onToggleCheck();
        }}
        className={cn(
          "mail-row-check",
          "flex h-5 w-5 items-center justify-center rounded border border-white/15",
          checked && "border-[#0EA5E9] bg-[#0EA5E9]",
        )}
      >
        {checked && <Check size={13} />}
      </span>

      <span
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
        className="mail-row-star text-white/45 hover:text-[#BAE6FD]"
      >
        <Star
          size={17}
          fill={message.starred ? "currentColor" : "none"}
          className={message.starred ? "text-[#BAE6FD]" : ""}
        />
      </span>

      <span className={cn("mail-row-sender truncate text-sm", message.unread ? "font-extrabold text-white" : "font-semibold text-white/65")}>
        {message.fromName}
      </span>

      <span className="mail-row-subject min-w-0 truncate text-sm">
        {message.unread && <span className="mail-row-unread-dot mr-3 inline-block h-2 w-2 rounded-full bg-[#38BDF8]" />}
        <span className={cn(message.unread ? "font-extrabold text-white" : "font-semibold text-white/80")}>
          {message.subject}
        </span>
        {groupByCategory && (
          <span className={cn("mail-row-category ml-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-black uppercase", categoryMeta.tone)}>
            {categoryMeta.label}
          </span>
        )}
        {showPreview && (
          <>
            <span className="mail-row-preview-separator mx-2 text-white/25">-</span>
            <span className="mail-row-preview text-white/45">{message.snippet}</span>
          </>
        )}
      </span>

      <span className="mail-row-date flex items-center justify-end gap-2 text-xs font-semibold text-white/55">
        {message.hasAttachment && <Paperclip size={14} />}
        {message.dateLabel}
      </span>

      <span className="mail-row-mobile-avatar" aria-hidden="true">
        {initials(message.fromName || message.fromEmail).slice(0, 2).toUpperCase()}
      </span>
    </button>
  );
}
