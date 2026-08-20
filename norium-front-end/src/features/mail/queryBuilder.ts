// Montagem de rotas e queries de busca do Gmail.
// Extraido de EmailDashboard.tsx sem alteracao de comportamento.
import type { MailQuickFilter } from "./types";

export const GMAIL_PAGE_SIZE = 50;

export type AdvancedMailFilters = {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  excludes: string;
  newerThan: "" | "1d" | "7d" | "30d" | "365d";
  hasAttachment: boolean;
};

export const emptyAdvancedFilters: AdvancedMailFilters = {
  from: "",
  to: "",
  subject: "",
  hasWords: "",
  excludes: "",
  newerThan: "",
  hasAttachment: false,
};

/** "unread"/"starred" sao pastas virtuais: substituem a pasta escolhida. */
export function resolveMailboxFolder(folder: string, filter: MailQuickFilter) {
  return filter === "unread" || filter === "starred" ? filter : folder;
}

export function buildMessagesPath({
  userId,
  folder,
  filter,
  query,
  pageToken,
}: {
  userId: string;
  folder: string;
  filter: MailQuickFilter;
  query: string;
  pageToken?: string | null;
}) {
  const qParts: string[] = [];
  if (query.trim()) qParts.push(query.trim());
  if (filter === "read") qParts.push("is:read");
  const params = new URLSearchParams({
    user_id: userId,
    folder: resolveMailboxFolder(folder, filter),
    max_results: String(GMAIL_PAGE_SIZE),
  });
  if (qParts.length) params.set("q", qParts.join(" "));
  if (pageToken) params.set("page_token", pageToken);
  return `/api/emails/gmail/messages?${params.toString()}`;
}

export function buildGmailSearchQuery(base: string, filters: AdvancedMailFilters) {
  const parts = [base.trim()];
  if (filters.from.trim()) parts.push(`from:${filters.from.trim()}`);
  if (filters.to.trim()) parts.push(`to:${filters.to.trim()}`);
  if (filters.subject.trim()) parts.push(`subject:(${filters.subject.trim()})`);
  if (filters.hasWords.trim()) parts.push(filters.hasWords.trim());
  if (filters.excludes.trim()) {
    parts.push(...filters.excludes.trim().split(/\s+/).filter(Boolean).map((word) => `-${word}`));
  }
  if (filters.newerThan) parts.push(`newer_than:${filters.newerThan}`);
  if (filters.hasAttachment) parts.push("has:attachment");
  return parts.filter(Boolean).join(" ");
}
