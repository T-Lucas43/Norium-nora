import type { TeamThreadScope } from "./useTeamCall";
export type TeamAttachment = { id: string; name: string; mimeType: string; size: number; url: string; expiresAt?: string };
export type TeamResourceRef = { type: "task" | "client" | "proposal" | "contract" | "budget" | "meeting" | "finance"; id: string };
export type TeamResourceCard = TeamResourceRef & { title: string; label?: string; restricted: boolean; status?: string; dueDate?: string; messageId?: string; deepLink?: { tab: string; entityType: string; entityId: string } };
export type TeamMessage = { id: string; threadId: string; scope: TeamThreadScope; senderId: string; senderName: string; senderAvatar?: string; recipientId?: string | null; subteamId?: string | null; text: string; attachments: TeamAttachment[]; metadata?: Record<string, unknown>; createdAt: string; quotedMessageId?: string | null; replyThreadId?: string; alsoInChannel?: boolean; resourceRefs?: TeamResourceRef[] };
