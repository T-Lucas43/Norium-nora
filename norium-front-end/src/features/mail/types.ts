// Contratos de e-mail compartilhados entre lista, detalhe e composicao.
export type GmailStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  name?: string;
  picture?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  lastSync?: string;
  detail?: string;
};

export interface Email {
  id: number;
  sender: string;
  email: string;
  avatarColor: string;
  subject: string;
  preview: string;
  time: string;
  unread: boolean;
  starred: boolean;
  folder: string;
  dateFull?: string;
  content?: string;
  hasAttachment?: boolean;
  attachmentName?: string;
  attachmentSize?: string;
}

export type GmailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal: number;
  messagesUnread: number;
};

export type GmailAttachment = {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  draftId?: string;
  from: string;
  fromName: string;
  fromEmail: string;
  replyToEmail?: string;
  to?: string;
  cc?: string;
  subject: string;
  snippet: string;
  dateLabel: string;
  dateFull: string;
  timestamp: number;
  labels: string[];
  unread: boolean;
  starred: boolean;
  important: boolean;
  hasAttachment: boolean;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: GmailAttachment[];
};

export type MessageListResponse = GmailStatus & {
  messages: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate: number;
};

export type ComposeAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type ComposeState = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: ComposeAttachment[];
};

export type NoraEmailSuggestion = {
  target: "compose" | "reply";
  text: string;
};

export type AgentMessage = {
  role: "user" | "ai";
  text: string;
};

export const quickFilters = [
  { key: "all", label: "Todo o correio" },
  { key: "unread", label: "Nao lidos" },
  { key: "read", label: "Ler" },
  { key: "starred", label: "Com estrela" },
] as const;

export type MailQuickFilter = (typeof quickFilters)[number]["key"];

export type MailboxSnapshot = {
  messages: GmailMessage[];
  nextPageToken: string | null;
  resultSize: number;
  cachedAt: number;
};
