import type { TeamThreadScope } from "./useTeamCall";

export type TeamConversation = {
  id: string;
  scope: TeamThreadScope;
  recipientId?: string;
  subteamId?: string;
  pinned: boolean;
  unreadCount: number;
  lastMessage?: { id: string; text: string; senderId: string; senderName: string; createdAt: string } | null;
};

export function mentionQuery(text: string, cursor: number) {
  const match = text.slice(0, cursor).match(/(^|\s)@([^@\n]{0,60})$/u);
  if (!match || match.index === undefined) return null;
  return { query: match[2].toLocaleLowerCase("pt-BR"), start: match.index + match[1].length, end: cursor };
}

export function mentionParts(text: string, mentions: unknown) {
  const names = Array.isArray(mentions) ? mentions.map((item) => item?.name).filter((name): name is string => typeof name === "string" && Boolean(name)) : [];
  const tokens = ["nora", ...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`((?<!\\w)@(?:${tokens.join("|")})(?!\\w))`, "giu"));
}
