// Cache em memoria da caixa de entrada, compartilhado durante a sessao.
// Extraido de EmailDashboard.tsx sem alteracao de comportamento.
import type { MailQuickFilter, MailboxSnapshot } from "./types";
import { resolveMailboxFolder } from "./queryBuilder";

export const mailboxSessionCache = new Map<string, MailboxSnapshot>();

export function mailboxCacheKey(userId: string, folder: string, filter: MailQuickFilter, query: string) {
  return `${userId}::${resolveMailboxFolder(folder, filter)}::${filter}::${query.trim()}`;
}

/** Invalida so as entradas do usuario informado, preservando as dos demais. */
export function clearMailboxCacheForUser(userId: string) {
  const prefix = `${userId}::`;
  for (const key of mailboxSessionCache.keys()) {
    if (key.startsWith(prefix)) mailboxSessionCache.delete(key);
  }
}
