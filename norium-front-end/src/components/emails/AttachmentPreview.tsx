import { FileText, X } from "lucide-react";
import { formatBytes, isImage } from "../../features/mail/formatters";
import type { ComposeAttachment } from "../../features/mail/types";

type AttachmentPreviewProps = {
  attachments: ComposeAttachment[];
  onRemove: (id: string) => void;
};

/** Lista de anexos em edicao, usada na nova mensagem e na resposta. */
export default function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  return (
    <div className="nx-mail-attach-list">
      {attachments.map((attachment) => (
        <div key={attachment.id}>
          {isImage(attachment.mimeType) ? (
            <img src={attachment.dataUrl} alt={attachment.fileName} className="h-9 w-9 rounded-md object-cover" />
          ) : (
            <span className="nx-mail-file-ic">
              <FileText size={16} />
            </span>
          )}
          <div>
            <p>{attachment.fileName}</p>
            <span className="nx-faint nx-small">{formatBytes(attachment.size)}</span>
          </div>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="nx-mail-iconbtn"
            aria-label={`Remover anexo ${attachment.fileName}`}
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
