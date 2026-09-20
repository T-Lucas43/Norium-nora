// Deduplicação de notificações por identidade estável (tarefa 2).
// Caixa de entrada: mesma ocorrência lógica aparece uma vez, mesmo após
// sincronização, reconexão, entrega por dois canais, remount ou reload.
// Nunca deduz apenas por título/texto/janela de tempo: exige identidade
// estável do evento/ação com escopo por usuário.
import type { OmnichannelEvent, SystemNotification } from "../types/omnichannel";

export const DEDUP_STORE_CAP = 500;

function storageKey(kind: "notified" | "toasted" | "dismissed", userId: string): string {
  return `norium:notifications:${kind}:${userId}`;
}

function readIdSet(kind: "notified" | "toasted" | "dismissed", userId: string): Set<string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey(kind, userId)) : null;
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, DEDUP_STORE_CAP));
  } catch {
    return new Set();
  }
}

function writeIdSet(kind: "notified" | "toasted" | "dismissed", userId: string, ids: Set<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey(kind, userId), JSON.stringify([...ids].slice(-DEDUP_STORE_CAP)));
  } catch {
    // Persistência é melhor esforço; a deduplicação em memória continua valendo.
  }
}

export function rememberId(kind: "notified" | "toasted" | "dismissed", userId: string, id: string): Set<string> {
  const current = readIdSet(kind, userId);
  current.add(id);
  while (current.size > DEDUP_STORE_CAP) {
    const oldest = current.values().next().value as string | undefined;
    if (!oldest) break;
    current.delete(oldest);
  }
  writeIdSet(kind, userId, current);
  return current;
}

export function loadPersistedDedup(userId: string): {
  notified: Set<string>;
  toasted: Set<string>;
  dismissed: Set<string>;
} {
  return {
    notified: readIdSet("notified", userId),
    toasted: readIdSet("toasted", userId),
    dismissed: readIdSet("dismissed", userId),
  };
}

// Identidade estável da notificação derivada de um evento do inbox.
// Mensagem do chat da equipe usa messageId (mesma ocorrência chega pelo
// WebSocket omnichannel e pelo WebSocket do team-chat); demais canais usam
// o id do evento, que já é estável no backend (gmail_*, calendar_google_*,
// team_*, sistema_*).
export function notificationIdForEvent(event: Pick<OmnichannelEvent, "id" | "source" | "metadata">): string {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const action = String(metadata.action ?? "").toLocaleLowerCase("pt-BR");
  const messageId = String(metadata.messageId ?? "").trim();
  if (event.source === "equipe" && action === "team_message_created" && messageId) {
    return `notification_team_${messageId}`;
  }
  return `notification_${event.id}`;
}

// Identidade estável para avisos de sistema recebidos por WebSocket.
// Prefere id explícito do backend; senão deriva de approvalId/messageId/
// eventId + ação, sempre com escopo lógico. Sem identidade estável retorna
// null e o chamador não deve deduplicar (para não silenciar erros distintos).
export function systemMessageStableId(payload: {
  id?: string;
  metadata?: Record<string, unknown>;
  title?: string;
}): string | null {
  if (payload.id && payload.id.trim()) return payload.id.trim();
  const metadata = payload.metadata ?? {};
  const approvalId = String(metadata.approvalId ?? "").trim();
  if (approvalId) {
    const action = String(metadata.action ?? "approval").trim() || "approval";
    return `notification_approval_${action}_${approvalId}`;
  }
  const messageId = String(metadata.messageId ?? "").trim();
  if (messageId) return `notification_team_${messageId}`;
  const eventId = String(metadata.eventId ?? metadata.event_id ?? "").trim();
  if (eventId) {
    const action = String(metadata.action ?? "").trim();
    return action ? `notification_${action}_${eventId}` : `notification_${eventId}`;
  }
  return null;
}

// Ids sintéticos fixos para falhas locais recorrentes (mesma condição
// persistente, não ocorrências novas). Erros distintos mantêm títulos
// diferentes e continuam aparecendo.
export const SYNTHETIC_ERROR_IDS = {
  centralUnavailable: "sys_central_unavailable",
  websocketMalformed: "sys_ws_malformed",
} as const;

export function forgetIds(userId: string, ids: string[]): void {
  (["notified", "toasted", "dismissed"] as const).forEach((kind) => {
    const current = readIdSet(kind, userId);
    let changed = false;
    ids.forEach((id) => {
      if (current.delete(id)) changed = true;
    });
    if (changed) writeIdSet(kind, userId, current);
  });
}

export function isDuplicateNotification(
  current: Pick<SystemNotification, "id">[],
  candidateId: string,
): boolean {
  return current.some((notification) => notification.id === candidateId);
}

export function shouldShowToast(
  toasts: { id: string }[],
  candidateToastId: string,
  toastedIds: Set<string>,
  dismissedIds: Set<string>,
): boolean {
  if (toastedIds.has(candidateToastId) || dismissedIds.has(candidateToastId)) return false;
  return !toasts.some((toast) => toast.id === candidateToastId);
}
