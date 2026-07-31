import { FileText, X } from "lucide-react";
import Button from "../shared/Button";
import { formatBytes, isImage } from "../../features/mail/formatters";
import type { ComposeAttachment } from "../../features/mail/types";

type AttachmentPreviewProps = {
  attachments: ComposeAttachment[];
  onRemove: (id: string) => void;
};

/** Lista de anexos em edicao, usada na nova mensagem e na resposta. */
export default function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  return (
    <div className="grid max-h-44 gap-2 overflow-y-auto border-t border-white/10 p-3">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="mail-card flex items-center justify-between rounded-lg border border-white/10 bg-[#101014] p-2">
          <div className="flex min-w-0 items-center gap-3">
            {isImage(attachment.mimeType) ? (
              <img src={attachment.dataUrl} alt={attachment.fileName} className="h-12 w-12 rounded-md object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-white/8">
                <FileText size={18} />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{attachment.fileName}</p>
              <p className="text-xs font-semibold text-white/45">{formatBytes(attachment.size)}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onRemove(attachment.id)}
            className="text-white/55 hover:bg-white/7"
            aria-label={`Remover anexo ${attachment.fileName}`}
          >
            <X size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
