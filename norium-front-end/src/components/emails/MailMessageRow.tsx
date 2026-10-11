import { Check, Paperclip, Star } from "lucide-react";
import { cn } from "../../utils/cn";
import { classifyEmailCategory, emailCategoryMeta } from "../../features/mail/formatters";
import type { GmailMessage } from "../../features/mail/types";
import { mailCategoryBadge } from "./mailCategoryTone";

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

/** Linha da lista de mensagens: remetente e hora, assunto e previa. */
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
  const category = classifyEmailCategory(message);
  const categoryMeta = emailCategoryMeta[category];

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "nx-mail-row",
        compactMode && "is-compact",
        selected && "mail-active",
        message.unread && "is-unread",
      )}
    >
      {/* Selecao e estrela ficam dentro da linha: paramos a propagacao para
          nao abrir a mensagem ao usar esses controles. */}
      <span
        onClick={(event) => {
          event.stopPropagation();
          onToggleCheck();
        }}
        className={cn("nx-mail-check", checked && "is-checked")}
      >
        {checked && <Check size={12} />}
      </span>

      <span
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
        className={cn("nx-mail-row-star", message.starred && "is-on")}
      >
        <Star size={15} fill={message.starred ? "currentColor" : "none"} />
      </span>

      <span className="nx-mail-row-sender">{message.fromName}</span>

      <span className="nx-mail-row-subject">
        <span>{message.subject}</span>
        {groupByCategory && (
          <span className={cn("nx-badge", mailCategoryBadge[category])}>{categoryMeta.label}</span>
        )}
      </span>

      {showPreview && <span className="nx-mail-row-preview">{message.snippet}</span>}

      <span className="nx-mail-row-date">
        {message.hasAttachment && <Paperclip size={13} />}
        {message.dateLabel}
      </span>
    </button>
  );
}
