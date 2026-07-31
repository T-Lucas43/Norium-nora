import { useCallback, useState } from "react";
import { mailApiRequest as apiJson } from "../api";
import { clearMailboxCacheForUser } from "../mailboxCache";
import { readFileAsDataUrl, splitRecipients } from "../formatters";
import type { ComposeAttachment, ComposeState, GmailMessage } from "../types";

export const emptyCompose: ComposeState = { to: "", cc: "", bcc: "", subject: "", body: "", attachments: [] };

export type ComposeTarget = "compose" | "reply";

type UseComposeOptions = {
  userId: string;
  selectedMessage: GmailMessage | null;
  onError: (message: string) => void;
  /** Navega para a caixa onde a mensagem acabou de cair (rascunhos ou enviados). */
  onSent: (folder: string) => void;
  /** Limpa a sugestao da Nora referente ao alvo enviado. */
  onClearSuggestion: (target: ComposeTarget) => void;
};

/** Redacao de e-mail: nova mensagem, resposta e anexos de ambas. */
export function useCompose({ userId, selectedMessage, onError, onSent, onClearSuggestion }: UseComposeOptions) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [replyText, setReplyText] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<ComposeAttachment[]>([]);
  const [sending, setSending] = useState(false);

  const addFiles = useCallback(async (files: FileList | null, target: ComposeTarget) => {
    if (!files?.length) return;
    const loaded = await Promise.all(
      Array.from(files).map(async (file) => ({
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })),
    );
    if (target === "compose") {
      setCompose((prev) => ({ ...prev, attachments: [...prev.attachments, ...loaded] }));
    } else {
      setReplyAttachments((prev) => [...prev, ...loaded]);
    }
  }, []);

  const sendEmail = useCallback(async (saveAsDraft = false) => {
    setSending(true);
    onError("");
    try {
      const payload = {
        user_id: userId,
        to: splitRecipients(compose.to),
        cc: splitRecipients(compose.cc),
        bcc: splitRecipients(compose.bcc),
        subject: compose.subject,
        body: compose.body,
        attachments: compose.attachments.map(({ fileName, mimeType, dataUrl }) => ({ fileName, mimeType, dataUrl })),
      };
      await apiJson(saveAsDraft ? "/api/emails/gmail/drafts" : "/api/emails/gmail/send", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      clearMailboxCacheForUser(userId);
      setCompose(emptyCompose);
      onClearSuggestion("compose");
      setComposeOpen(false);
      onSent(saveAsDraft ? "drafts" : "sent");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Falha ao enviar e-mail.");
    } finally {
      setSending(false);
    }
  }, [compose, onClearSuggestion, onError, onSent, userId]);

  const sendReply = useCallback(async () => {
    if (!selectedMessage || !replyText.trim()) return;
    setSending(true);
    onError("");
    try {
      await apiJson(`/api/emails/gmail/messages/${selectedMessage.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          body: replyText,
          attachments: replyAttachments.map(({ fileName, mimeType, dataUrl }) => ({ fileName, mimeType, dataUrl })),
        }),
      });
      clearMailboxCacheForUser(userId);
      setReplyText("");
      setReplyAttachments([]);
      onClearSuggestion("reply");
      onSent("sent");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Falha ao responder e-mail.");
    } finally {
      setSending(false);
    }
  }, [onClearSuggestion, onError, onSent, replyAttachments, replyText, selectedMessage, userId]);

  return {
    composeOpen,
    setComposeOpen,
    compose,
    setCompose,
    replyText,
    setReplyText,
    replyAttachments,
    setReplyAttachments,
    sending,
    addFiles,
    sendEmail,
    sendReply,
  };
}
