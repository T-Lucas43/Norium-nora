import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, AtSign, CalendarDays, CalendarPlus, CheckCheck, Download, FileText, FolderOpen, Hash, ImageIcon, Images, Paperclip, Phone, PlayCircle, Send, Settings2, MessageSquare, PanelRight, Pin, PinOff, SmilePlus, Users, UserRound, Video, Volume2, X } from "lucide-react";
import { canUse, type AuthSession, type NoriumUser } from "../../types/auth";
import { apiBaseUrl, authToken } from "../../utils/api";
import { requestScope } from "../../core/api/sessionScope";
import { downloadWithAuth } from "../../utils/download";
import TeamConversationNavigation from "./TeamConversationNavigation";
import TeamMessageActions from "./TeamMessageActions";
import TeamChatDialog from "./TeamChatDialog";
import { Bold, Code, List, Maximize2, Search } from "lucide-react";
import TeamCollaborationPanel from "./TeamCollaborationPanel";
import TeamResourceCards from "./TeamResourceCards";
import TeamReplySummary from "./TeamReplySummary";
import { useTeamCollaboration, type TeamContentTab } from "./useTeamCollaboration";
import type { TeamMessage } from "./teamChatTypes";
import TeamChatProductivityDialog, { type ProductivityAction, type ScheduleItem } from "./TeamChatProductivityDialog";
import TeamNoraDialog, { type NoraDialogInput, type NoraSource } from "./TeamNoraDialog";
import TeamNoraMessageTools from "./TeamNoraMessageTools";
import TeamPollCard, { type TeamPoll } from "./TeamPollCard";
import { Clock3, Plus } from "lucide-react";
import TeamMessageText from "./TeamMessageText";
import TeamStatusDialog from "./TeamStatusDialog";
import { useTeamPresence } from "./useTeamPresence";
import { useMessageWindow } from "./useMessageWindow";
import { tabPath } from "../../app/navigation/tabs";
import { mentionQuery, type TeamConversation } from "./teamChatConversations";
import "./teamChat.css";
import "./teamChatV3.css";
import NoraAvatar from "../layout/NoraAvatar";
import { NoraMarkdown } from "../nora/NoraResponseContent";
import Button from "../shared/Button";
import TeamCallOverlay from "./TeamCallOverlay";
import TeamActiveCallCard from "./TeamActiveCallCard";
import MessageReadReceiptsDialog from "./MessageReadReceiptsDialog";
import TeamMemberPresenceDialog from "./TeamMemberPresenceDialog";
import TeamMeetingMessageCard from "./TeamMeetingMessageCard";
import TeamMeetingSchedulerDialog, { type TeamMeetingScheduleInput } from "./TeamMeetingSchedulerDialog";
import { prepareChatAttachments } from "./chatAttachments";
import TeamAudioControls from "./TeamAudioControls";
import TeamEmojiPicker from "./TeamEmojiPicker";
import TeamVoiceRecorder from "./TeamVoiceRecorder";
import { QUICK_REACTIONS } from "./emojiCatalog";
import {
  useCallSession,
  useTeamSocketEvents,
  type TeamSocketEvent,
  type TeamThreadScope,
} from "./CallSession";

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  expiresAt?: string;
};

type MessageReaction = { emoji: string; userIds: string[] };

type Subteam = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  noraEnabled?: boolean;
};

type TeamChatDrawerProps = {
  open: boolean;
  onClose: () => void;
  onOpen?: () => void;
  session: AuthSession;
  onUnread?: (count: number) => void;
  onOpenNora?: (prompt?: string) => void;
  onOpenCalendar?: () => void;
  variant?: "drawer" | "page";
  initialThreadId?: string | null;
  onInitialThreadHandled?: () => void;
};

const API_URL = `${apiBaseUrl()}/api/team-chat`;

function readReceiptsFor(message: TeamMessage) {
  const raw = message.metadata?.readBy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([userId, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const receipt = value as Record<string, unknown>;
      return { userId, userName: String(receipt.userName || "Membro"), viewedAt: String(receipt.viewedAt || "") };
    })
    .filter((receipt): receipt is { userId: string; userName: string; viewedAt: string } => Boolean(receipt));
}

function reactionsFor(message: TeamMessage): MessageReaction[] {
  const raw = message.metadata?.reactions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const emoji = String(item.emoji || "");
    const userIds = Array.isArray(item.userIds) ? item.userIds.map(String).filter(Boolean) : [];
    return emoji && userIds.length ? [{ emoji, userIds }] : [];
  });
}

function formatMessageDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

function authHeaders(extra?: HeadersInit, explicitToken?: string | null): HeadersInit {
  const token = explicitToken || authToken();
  return {
    ...(localStorage.getItem("norium-workspace-id") ? { "X-Norium-Workspace": localStorage.getItem("norium-workspace-id") || "primary" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {}),
  };
}

function isImageAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith("image/");
}

function isVideoAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith("video/");
}

function isAudioAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith("audio/");
}

function canPreviewAttachment(attachment: Attachment) {
  return isImageAttachment(attachment) || isVideoAttachment(attachment) || isAudioAttachment(attachment);
}

function formatBytes(value: number) {
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function extractQuoted(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.trim() || "";
}

function parseDetails(text: string) {
  return text
    .replace(/\.$/, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawLabel, ...rest] = item.split(":");
      return {
        label: rawLabel?.trim() || "Detalhe",
        value: rest.join(":").trim() || item,
      };
    });
}

type StructuredNoraContent = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  changes: string[];
  details: Array<{ label: string; value: string }>;
};

function parseNoraContent(message: TeamMessage): StructuredNoraContent | null {
  if (message.senderId !== "nora") return null;

  const text = message.text || "";
  const metadata = message.metadata || {};
  const action = stringValue(metadata.action);
  const summary = asRecord(metadata.summary);
  const state = asRecord(summary?.state);
  const isTaskMessage =
    action.startsWith("task_") ||
    action.startsWith("automation_task_") ||
    /Nora:\s+a tarefa/i.test(text) ||
    /Nora:\s+a automacao/i.test(text);

  if (!isTaskMessage) return null;

  const taskTitle =
    stringValue(summary?.taskTitle) ||
    stringValue(metadata.taskTitle) ||
    extractQuoted(text, /tarefa\s+"([^"]+)"/i) ||
    "Tarefa";
  const projectName =
    stringValue(summary?.projectName) ||
    stringValue(metadata.projectName) ||
    extractQuoted(text, /projeto\s+"([^"]+)"/i) ||
    "Projeto";
  const automationName = stringValue(summary?.automationName) || extractQuoted(text, /automacao\s+"([^"]+)"/i);

  const metadataChanges = stringList(summary?.changes).length ? stringList(summary?.changes) : stringList(metadata.changes);
  const textChanges = text.match(/Alteracoes:\s*(.*?)(?:\.\s*(Estado atual|Ultimo estado):|$)/i)?.[1];
  const changes =
    metadataChanges.length > 0
      ? metadataChanges
      : textChanges
        ? textChanges
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];

  const metadataDetails = state
    ? Object.entries(state)
        .map(([label, value]) => ({ label, value: String(value || "").trim() }))
        .filter((item) => item.value)
    : [];
  const stateText = text.match(/(?:Estado atual|Ultimo estado):\s*(.*)$/i)?.[1];
  const details = metadataDetails.length > 0 ? metadataDetails : stateText ? parseDetails(stateText) : [];

  if (action === "task_deleted" || /foi excluida/i.test(text)) {
    return {
      eyebrow: "Tarefa excluida",
      title: taskTitle,
      subtitle: `Projeto: ${projectName}`,
      changes: changes.length ? changes : ["A tarefa foi removida do quadro."],
      details,
    };
  }

  if (action.startsWith("automation_task_") || /automacao/i.test(text)) {
    return {
      eyebrow: "Automacao executada",
      title: taskTitle,
      subtitle: automationName ? `Automacao: ${automationName} | Projeto: ${projectName}` : `Projeto: ${projectName}`,
      changes: changes.length ? changes : ["A automacao criou ou atualizou uma tarefa."],
      details,
    };
  }

  return {
    eyebrow: "Tarefa atualizada",
    title: taskTitle,
    subtitle: `Projeto: ${projectName}`,
    changes,
    details,
  };
}

function NoraMessageContent({ message }: { message: TeamMessage }) {
  const parsed = parseNoraContent(message);

  if (!parsed) {
    if (message.senderId === "nora") return <NoraMarkdown allowImages={false} text={message.text} />;
    return <TeamMessageText text={message.text} mentions={message.metadata?.mentions} />;
  }

  return (
    <div className="space-y-2 leading-5">
      <div className="team-nora-block rounded-xl border border-white/10 bg-white/10 p-3">
        <p className="text-xs font-bold uppercase tracking-wide opacity-75">{parsed.eyebrow}</p>
        <p className="mt-1 text-sm font-bold">{parsed.title}</p>
        {parsed.subtitle && <p className="mt-1 text-xs font-bold opacity-80">{parsed.subtitle}</p>}
      </div>

      {parsed.changes.length > 0 && (
        <div className="team-nora-block rounded-xl border border-white/10 bg-black/10 p-3">
          <p className="text-xs font-bold uppercase tracking-wide opacity-70">Alteracoes</p>
          <ul className="mt-2 space-y-1.5">
            {parsed.changes.map((change) => (
              <li key={change} className="flex gap-2 text-xs font-semibold">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                <span>{change}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {parsed.details.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {parsed.details.map((detail) => (
            <div key={`${detail.label}-${detail.value}`} className="team-nora-block rounded-lg border border-white/10 bg-white/[0.08] px-2 py-1.5">
              <p className="text-xs font-bold uppercase opacity-60">{detail.label}</p>
              <p className="truncate text-xs font-bold" title={detail.value}>
                {detail.value}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageAvatar({ name, avatar, onClick }: { name: string; avatar?: string; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (avatar === "nora") return <NoraAvatar className="team-chat-avatar h-9 w-9 shrink-0" />;
  const avatarNode = <span className="team-chat-avatar grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] text-xs font-bold text-[var(--text)]">
      {avatar && !failed ? (
        <img src={avatar} alt={name} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        initials(name)
      )}
    </span>;
  return onClick ? <button type="button" onClick={onClick} aria-label={`Abrir perfil de ${name}`} className="shrink-0 rounded-xl transition hover:ring-2 hover:ring-cyan-400/50">{avatarNode}</button> : avatarNode;
}

function useAttachmentObjectUrl(attachment: Attachment | null, token?: string, thumbnail = false) {
  const [objectUrl, setObjectUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    let nextUrl = "";
    setObjectUrl("");
    if (!attachment || !canPreviewAttachment(attachment)) return undefined;

    const abort = new AbortController();
    const url = thumbnail && isImageAttachment(attachment) ? `${attachment.url}${attachment.url.includes("?") ? "&" : "?"}preview=true` : attachment.url;
    fetch(url, { headers: authHeaders(undefined, token), signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Falha ao carregar anexo.");
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl("");
      });

    return () => {
      cancelled = true;
      abort.abort();
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [attachment, token, thumbnail]);

  return objectUrl;
}

function TeamAttachmentCard({ attachment, onPreview, token }: { attachment: Attachment; onPreview: (attachment: Attachment) => void; token: string }) {
  const objectUrl = useAttachmentObjectUrl(attachment, token, true);
  const previewable = canPreviewAttachment(attachment);
  const Icon = isImageAttachment(attachment) ? ImageIcon : isVideoAttachment(attachment) ? PlayCircle : isAudioAttachment(attachment) ? Volume2 : FileText;

  return (
    <div className="team-attachment-card overflow-hidden rounded-xl border border-white/10 bg-black/12 text-xs font-bold">
      <div className="block w-full text-left">
        {isImageAttachment(attachment) && objectUrl ? (
          <button type="button" className="block w-full" onClick={() => onPreview(attachment)}><img src={objectUrl} alt={attachment.name} className="h-28 w-full object-cover" /></button>
        ) : isVideoAttachment(attachment) && objectUrl ? (
          <button type="button" className="block w-full" onClick={() => onPreview(attachment)}><video src={objectUrl} className="h-28 w-full bg-black object-cover" muted /></button>
        ) : isAudioAttachment(attachment) && objectUrl ? (
          <div className="p-2">
            <TeamAudioControls src={objectUrl} label={`Áudio ${attachment.name}`} />
          </div>
        ) : (
          <button type="button" onClick={() => (previewable ? onPreview(attachment) : void downloadWithAuth(attachment.url, attachment.name, token))} className="flex min-h-16 w-full items-center gap-2 px-3 py-2 text-left">
            <Icon size={16} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{attachment.name}</span>
              <span className="block text-xs opacity-70">{formatBytes(attachment.size)}</span>
            </span>
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => void downloadWithAuth(attachment.url, attachment.name, token)}
        className="flex w-full items-center gap-2 border-t border-white/10 px-3 py-2 text-left hover:bg-white/10"
      >
        <Download size={13} />
        <span className="truncate">{attachment.name}</span>
      </button>
    </div>
  );
}

function AttachmentPreviewModal({ attachment, onClose, token }: { attachment: Attachment; onClose: () => void; token: string }) {
  const objectUrl = useAttachmentObjectUrl(attachment, token);

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[88dvh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/20 bg-[var(--surface)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-[var(--text)]">{attachment.name}</p>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">{attachment.mimeType} · {formatBytes(attachment.size)}</p>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose}>
            <X size={18} />
          </Button>
        </header>
        <div className="max-h-[calc(88dvh-64px)] overflow-auto bg-black/20 p-4">
          {!objectUrl ? (
            <div className="grid h-56 place-items-center text-sm font-bold text-[var(--text-secondary)]">Carregando prévia...</div>
          ) : isImageAttachment(attachment) ? (
            <img src={objectUrl} alt={attachment.name} className="mx-auto max-h-[70dvh] rounded-xl object-contain" />
          ) : isVideoAttachment(attachment) ? (
            <video src={objectUrl} controls className="mx-auto max-h-[70dvh] w-full rounded-xl bg-black" />
          ) : (
            <TeamAudioControls src={objectUrl} label={`Áudio ${attachment.name}`} />
          )}
        </div>
      </div>
    </div>
  );
}

function PendingFilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return (
    <button onClick={onRemove} className="shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] text-left text-xs font-bold">
      {file.type.startsWith("image/") && url ? (
        <img src={url} alt={file.name} className="h-16 w-24 object-cover" />
      ) : (
        <span className="flex h-16 w-40 items-center gap-2 px-3">
          <FileText size={16} />
          <span className="min-w-0">
            <span className="block truncate">{file.name}</span>
            <span className="text-xs opacity-70">clique para remover</span>
          </span>
        </span>
      )}
    </button>
  );
}

function SubteamEditorDialog({
  value,
  members,
  currentUserId,
  saving,
  onClose,
  onSave,
}: {
  value: Subteam | "new";
  members: NoriumUser[];
  currentUserId: string;
  saving: boolean;
  onClose: () => void;
  onSave: (input: { name: string; description: string; memberIds: string[] }) => void;
}) {
  const editing = value !== "new";
  const [name, setName] = useState(editing ? value.name : "");
  const [description, setDescription] = useState(editing ? value.description : "");
  const [memberIds, setMemberIds] = useState<string[]>(editing ? value.memberIds : members.map((member) => member.id));

  return (
    <div className="fixed inset-0 z-[150] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <section className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div><p className="text-xs font-bold uppercase tracking-wide text-blue-400">Comunidade interna</p><h2 className="mt-1 text-xl font-semibold">{editing ? "Editar subequipe" : "Nova subequipe"}</h2></div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose}><X size={18} /></Button>
        </div>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]">Nome<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="h-11 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none" placeholder="Ex.: Comercial" /></label>
          <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]">Descricao<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} className="min-h-20 resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-[var(--text)] outline-none" placeholder="Objetivo e assuntos desta subequipe" /></label>
          <div><p className="text-xs font-bold text-[var(--text-secondary)]">Membros</p><div className="mt-2 grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
            {members.filter((member) => member.status === "ativo").map((member) => {
              const checked = memberIds.includes(member.id);
              const locked = member.id === currentUserId;
              return <label key={member.id} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-bold"><input type="checkbox" checked={checked} disabled={locked} onChange={() => setMemberIds((current) => checked ? current.filter((id) => id !== member.id) : [...current, member.id])} /><span className="truncate">{member.nome}</span></label>;
            })}
          </div></div>
        </div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={name.trim().length < 2} onClick={() => onSave({ name: name.trim(), description: description.trim(), memberIds: Array.from(new Set([...memberIds, currentUserId])) })}>{editing ? "Salvar alteracoes" : "Criar subequipe"}</Button></div>
      </section>
    </div>
  );
}

export default function TeamChatDrawer({ open, onClose, onOpen, session, onUnread, onOpenNora, onOpenCalendar, variant = "drawer", initialThreadId, onInitialThreadHandled }: TeamChatDrawerProps) {
  const [members, setMembers] = useState<NoriumUser[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [subteams, setSubteams] = useState<Subteam[]>([]);
  const [conversationSelected, setConversationSelected] = useState(false);
  const [threads, setThreads] = useState<TeamConversation[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [pinningId, setPinningId] = useState("");
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [urgentMention, setUrgentMention] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [scope, setScope] = useState<TeamThreadScope>("team");
  const [recipientId, setRecipientId] = useState("");
  const [subteamId, setSubteamId] = useState("");
  const [contentTab, setContentTab] = useState<TeamContentTab>("chat");
  const [subteamEditor, setSubteamEditor] = useState<Subteam | "new" | null>(null);
  const [selectedMemberId, setSelectedMemberState] = useState<string | null>(null);
  const [meetingSchedulerOpen, setMeetingSchedulerOpen] = useState(false);
  const [meetingDraft, setMeetingDraft] = useState<{ title: string; description: string; slots?: { startsAt: string; endsAt: string }[]; basis?: string } | undefined>();
  const [noraInput, setNoraInput] = useState<NoraDialogInput | null>(null);
  const pendingNoraSource = useRef<NoraSource | null>(null);
  const [meetingSaving, setMeetingSaving] = useState(false);
  const [readReceiptsMessageId, setReadReceiptsMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [quotedMessage, setQuotedMessage] = useState<TeamMessage | null>(null);
  const [editMessage, setEditMessage] = useState<TeamMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [deleteMessage, setDeleteMessage] = useState<TeamMessage | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [productivity, setProductivity] = useState<{ action: ProductivityAction; source?: TeamMessage; scheduled?: ScheduleItem } | null>(null);
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [scheduledItems, setScheduledItems] = useState<ScheduleItem[]>([]);
  const [shortcuts, setShortcuts] = useState<{ id: string; name: string; shortcut: string; body: string }[]>([]);
  const templateScope = requestScope(); const [shortcutsScope, setShortcutsScope] = useState("");
  const shortcutsGeneration = useRef(0); const [shortcutsRevision, setShortcutsRevision] = useState(0);
  useEffect(() => { const update = () => { shortcutsGeneration.current++; setShortcutsScope(""); setShortcutsRevision(value => value+1); }; window.addEventListener("norium:message-templates-changed", update); return () => window.removeEventListener("norium:message-templates-changed", update); }, []);
  const [shortcutDismissed, setShortcutDismissed] = useState(false);
  const [shortcutIndex, setShortcutIndex] = useState(0);
  const [mediaFilter, setMediaFilter] = useState("");
  const [mediaPage, setMediaPage] = useState<Attachment[]>([]);
  const [mediaMore, setMediaMore] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const mediaSequence = useRef(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const keepScroll = useRef<{ height: number; top: number } | null>(null);
  const nearBottom = useRef(true);
  const [subteamSaving, setSubteamSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [reactionMessageId, setReactionMessageId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messageWindow = useMessageWindow(messages, listRef, nearBottom, contentTab === "chat");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastScrolledThreadRef = useRef("");
  const handledIncomingCallRef = useRef("");
  const handledMessageLink = useRef("");
  const markedMessageIdsRef = useRef<Set<string>>(new Set());

  const selectedThreadId = !conversationSelected ? "" : scope === "team" ? "team" : scope === "subteam" ? `subteam:${subteamId}` : `direct:${[session.user.id, recipientId].sort().join(":")}`;
  const selectedThreadRef = useRef(selectedThreadId);
  selectedThreadRef.current = selectedThreadId;
  const collaboration = useTeamCollaboration({ threadId: selectedThreadId, token: session.token, messages, visibleMessageIds: messageWindow.items.map((message) => message.id), tab: contentTab, setError });
  const presence = useTeamPresence(open, session.token, collaboration.request);
  const presenceRef = useRef(presence); presenceRef.current = presence;
  function setSelectedMemberId(value: string | null) { if (value) collaboration.setContext(null); setSelectedMemberState(value); }
  const detailsOpen = collaboration.context === "details";
  const setContext = collaboration.setContext;
  const setDetailsOpen = useCallback((next: boolean | ((previous: boolean) => boolean)) => { setContext((current) => (typeof next === "function" ? next(current === "details") : next) ? "details" : null); }, [setContext]);
  const collaborationRef = useRef(collaboration); collaborationRef.current = collaboration;
  const loadSequence = useRef(0);
  const threadsSequence = useRef(0);
  const drafts = useRef(new Map<string, { text: string; files: File[]; mentionedUserIds: string[] }>());
  const draftRef = useRef({ text, files, mentionedUserIds });
  draftRef.current = { text, files, mentionedUserIds };
  const selectConversation = useCallback((next: { scope: TeamThreadScope; recipientId?: string | null; subteamId?: string | null } | null) => {
    const nextId = !next ? "" : next.scope === "team" ? "team" : next.scope === "subteam" ? `subteam:${next.subteamId}` : `direct:${[session.user.id, next.recipientId].sort().join(":")}`;
    if (nextId === selectedThreadRef.current) return;
    if (selectedThreadRef.current) drafts.current.set(selectedThreadRef.current, draftRef.current);
    selectedThreadRef.current = nextId;
    loadSequence.current += 1;
    setConversationSelected(Boolean(next));
    setScope(next?.scope || "team");
    setRecipientId(next?.recipientId || "");
    setSubteamId(next?.subteamId || "");
    setNoraInput(null);
    const draft = drafts.current.get(nextId);
    setText(draft?.text || "");
    setFiles(draft?.files || []);
    setMentionedUserIds(draft?.mentionedUserIds || []);
    setUrgentMention(false);
    setMessages([]);
    setError("");
    setLoading(Boolean(next));
    setContentTab("chat");
    setDetailsOpen(false);
    setMentionDismissed(true);
    setQuotedMessage(null); setHasMore(false); setLoadingEarlier(false);
    setProductivity(null); setScheduledOpen(false); setShortcutDismissed(false);
    setMediaFilter(""); setMediaPage([]); mediaSequence.current++;
    keepScroll.current = null; nearBottom.current = true;
  }, [session.user.id, setDetailsOpen]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const activeMembers = useMemo(() => members.filter((member) => member.status === "ativo"), [members]);
  const activeMemberIds = useMemo(() => new Set(activeMembers.map((member) => member.id)), [activeMembers]);
  const actualOnlineUserIds = useMemo(
    () => Array.from(new Set(onlineUserIds.filter((userId) => activeMemberIds.has(userId)))),
    [activeMemberIds, onlineUserIds],
  );
  const actualOnlineUserIdSet = useMemo(() => new Set(actualOnlineUserIds), [actualOnlineUserIds]);
  const selectedMember = selectedMemberId ? memberById.get(selectedMemberId) || null : null;
  const readReceiptsMessage = readReceiptsMessageId ? messages.find((message) => message.id === readReceiptsMessageId) || null : null;
  const selectedSubteam = useMemo(() => subteams.find((item) => item.id === subteamId) || null, [subteamId, subteams]);
  const noraAllowed = canUse(session.user, "nora") && (scope !== "subteam" || selectedSubteam?.noraEnabled !== false);
  const conversationMembers = useMemo(() => {
    if (scope === "team") return activeMembers;
    if (scope === "subteam") return activeMembers.filter((member) => selectedSubteam?.memberIds.includes(member.id));
    return activeMembers.filter((member) => member.id === session.user.id || member.id === recipientId);
  }, [activeMembers, recipientId, scope, selectedSubteam, session.user.id]);
  const threadTitle = scope === "team" ? "Time todo" : scope === "subteam" ? selectedSubteam?.name || "Subequipe" : memberById.get(recipientId)?.nome || "Mensagem direta";
  const callThread = useMemo(() => ({
    scope,
    title: threadTitle,
    recipientId: scope === "direct" ? recipientId : null,
    subteamId: scope === "subteam" ? subteamId : null,
  }), [recipientId, scope, subteamId, threadTitle]);
  const { snapshot: call, commands: callCommands } = useCallSession();
  const callPresence = call.active ? call.active.thread.scope === "direct" ? "call" : "meeting" : null;
  useEffect(() => { window.dispatchEvent(new CustomEvent("norium:presence-call", { detail: callPresence })); }, [callPresence]);
  const startCall = useCallback(
    (target = callThread) => callCommands.start(target),
    [callCommands, callThread],
  );
  const threadAttachments = useMemo(() => messages.flatMap((message) => message.attachments || []), [messages]);
  const photoAttachments = useMemo(() => threadAttachments.filter(isImageAttachment), [threadAttachments]);
  const mentionMatch = useMemo(() => mentionQuery(text, cursor), [text, cursor]);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch || mentionDismissed) return [];
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
    const query = normalize(mentionMatch.query);
    const options = conversationMembers.filter((member) => member.id !== session.user.id && normalize(member.nome).includes(query))
      .map((member) => ({ id: member.id, name: member.nome, avatar: member.fotoUrl || "" }));
    if (noraAllowed && "nora".includes(query)) options.push({ id: "nora", name: "nora", avatar: "nora" });
    return options.slice(0, 8);
  }, [mentionMatch, mentionDismissed, conversationMembers, noraAllowed, session.user]);
  const showMentionSuggestions = mentionOptions.length > 0;
  const loadThreads = useCallback(async () => {
    const sequence = ++threadsSequence.current;
    try {
      const response = await fetch(`${API_URL}/threads`, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Falha ao carregar conversas.");
      if (sequence === threadsSequence.current) setThreads(data.threads || []);
    } catch (loadError) { if (sequence === threadsSequence.current) setError(loadError instanceof Error ? loadError.message : "Falha ao carregar conversas."); }
    finally { if (sequence === threadsSequence.current) setThreadsLoading(false); }
  }, [session.token]);
  const conversationItems = useMemo(() => threads.map((thread) => ({ ...thread,
    title: thread.scope === "team" ? "Time todo" : thread.scope === "subteam" ? subteams.find((item) => item.id === thread.subteamId)?.name || "Subequipe" : memberById.get(thread.recipientId || "")?.nome || "Membro",
    avatar: thread.scope === "direct" ? memberById.get(thread.recipientId || "")?.fotoUrl : undefined,
    online: thread.scope === "direct" && actualOnlineUserIdSet.has(thread.recipientId || ""),
  })), [threads, subteams, memberById, actualOnlineUserIdSet]);
  useEffect(() => {
    if (threadsLoading || !selectedThreadId || threads.some((thread) => thread.id === selectedThreadId)) return;
    selectConversation(null);
    setError("Esta conversa não está mais disponível para você.");
  }, [threads, threadsLoading, selectedThreadId, selectConversation]);
  async function togglePin(thread: TeamConversation) {
    if (pinningId) return;
    setPinningId(thread.id);
    try {
      const response = await fetch(`${API_URL}/threads/pin`, { method: "PATCH", headers: authHeaders({ "Content-Type": "application/json" }, session.token), body: JSON.stringify({ threadId: thread.id, pinned: !thread.pinned }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível fixar a conversa.");
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, pinned: data.pinned } : item));
    } catch (pinError) { setError(pinError instanceof Error ? pinError.message : "Não foi possível fixar a conversa."); }
    finally { setPinningId(""); }
  }
  useEffect(() => {
    if (!open || !initialThreadId || threadsLoading) return;
    const thread = threads.find((item) => item.id === initialThreadId);
    if (thread) selectConversation(thread);
    else setError("Esta conversa não está mais disponível para você.");
    onInitialThreadHandled?.();
  }, [open, initialThreadId, threadsLoading, threads, selectConversation, onInitialThreadHandled]);

  const loadMembers = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/members`, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao carregar membros.");
      setMembers(data.members || []);
      setOnlineUserIds(data.onlineUserIds || []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Falha ao carregar membros.");
    }
  }, [session.token]);

  const loadSubteams = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/subteams`, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao carregar subequipes.");
      setSubteams(data.subteams || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Falha ao carregar subequipes.");
    }
  }, [session.token]);

  const markMessagesRead = useCallback(async (items: TeamMessage[]) => {
    const messageIds = items
      .filter((message) => message.senderId !== session.user.id && !markedMessageIdsRef.current.has(message.id))
      .map((message) => message.id)
      .filter(Boolean);
    if (!messageIds.length) return;
    try {
      for (let offset = 0; offset < messageIds.length; offset += 100) {
        const batch = messageIds.slice(offset, offset + 100);
        const response = await fetch(`${API_URL}/messages/read`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }, session.token),
          body: JSON.stringify({ messageIds: batch }),
        });
        if (response.ok) batch.forEach((messageId) => markedMessageIdsRef.current.add(messageId));
      }
      void loadThreads();
    } catch {
      // A confirmacao atrasada sera tentada novamente quando a conversa atualizar.
    }
  }, [loadThreads, session.token, session.user.id]);

  const loadMessages = useCallback(async () => {
    const requestedThread = selectedThreadId;
    const sequence = ++loadSequence.current;
    if (!requestedThread) { setMessages([]); setLoading(false); return; }
    const isCurrent = () => selectedThreadRef.current === requestedThread && loadSequence.current === sequence;
    const params = new URLSearchParams({ scope, limit: "50" });
    if (scope === "direct" && recipientId) params.set("recipientId", recipientId);
    if (scope === "subteam" && subteamId) params.set("subteamId", subteamId);
    if (scope === "direct" && !recipientId) {
      setMessages([]);
      return;
    }
    if (scope === "subteam" && !subteamId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    try {
      const messagesUrl = scope === "subteam" ? `${API_URL}/subteams/${subteamId}/messages?limit=50` : `${API_URL}/messages?${params.toString()}`;
      const response = await fetch(messagesUrl, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao carregar chat interno.");
      if (!isCurrent()) return;
      let loadedMessages = (data.messages || []) as TeamMessage[];
      if (pendingNoraSource.current?.threadId === requestedThread) {
        const target = pendingNoraSource.current;
        const context = await collaborationRef.current.request(`/messages/${encodeURIComponent(target.messageId)}/context`);
        if (!isCurrent()) return;
        loadedMessages = context.messages.filter((message: TeamMessage) => !message.replyThreadId || message.alsoInChannel);
        data.hasMore = context.hasMore;
        pendingNoraSource.current = null;
        if (context.message.replyThreadId) void collaborationRef.current.openReply(context.message);
        requestAnimationFrame(() => document.getElementById(`team-message-${context.message.replyThreadId || target.messageId}`)?.scrollIntoView({ block: "center" }));
      }
      setHasMore(Boolean(data.hasMore));
      setMessages((current) => [...loadedMessages, ...current.filter((message) => message.threadId === requestedThread && !loadedMessages.some((item) => item.id === message.id))].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      void markMessagesRead(loadedMessages);
      setError("");

    } catch (loadError) {
      if (isCurrent()) setError(loadError instanceof Error ? loadError.message : "Falha ao carregar chat interno.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [markMessagesRead, recipientId, scope, session.token, subteamId, selectedThreadId]);

  useEffect(() => {
    if (!open) return;
    void loadMembers();
    void loadSubteams();
    void loadThreads();
  }, [loadMembers, loadSubteams, loadThreads, open]);

  useEffect(() => {
    if (!open) return;
    void loadMessages();
    return () => { loadSequence.current += 1; };
  }, [loadMessages, open]);

  useEffect(() => {
    const incoming = call.incoming;
    if (!incoming || handledIncomingCallRef.current === incoming.callId) return;
    handledIncomingCallRef.current = incoming.callId;
    const nextScope = incoming.thread.scope;
    selectConversation({
      scope: nextScope,
      recipientId: nextScope === "direct" ? incoming.thread.recipientId || incoming.fromUserId : null,
      subteamId: nextScope === "subteam" ? incoming.thread.subteamId : null,
    });
    setContentTab("chat");
  }, [call.incoming, selectConversation]);

  const socketHandlersRef = useRef({ open, selectedThreadId, loadSubteams, loadThreads, markMessagesRead, onUnread });
  socketHandlersRef.current = { open, selectedThreadId, loadSubteams, loadThreads, markMessagesRead, onUnread };

  useTeamSocketEvents((payload: TeamSocketEvent) => {
    presenceRef.current.handle(payload);
    const handlers = socketHandlersRef.current;
    if (payload.type === "PRESENCE" || payload.type === "CONNECTED") setOnlineUserIds(payload.onlineUserIds || []);
    if (payload.type === "SUBTEAM_UPDATED") {
      void handlers.loadSubteams();
      void handlers.loadThreads();
    }
    if (payload.type === "TEAM_THREADS_UPDATED" || payload.type === "CONNECTED") void handlers.loadThreads();
    if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) {
      const message = payload.message as TeamMessage;
      collaborationRef.current.handleMessage(message);
      void handlers.loadThreads();
      if (handlers.selectedThreadId && message.threadId === handlers.selectedThreadId && (!message.replyThreadId || message.alsoInChannel)) {
        setMessages((current) => [...current.filter((item) => item.id !== message.id), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        if (handlers.open) void handlers.markMessagesRead([message]);
      } else if (handlers.open && !["call_started", "call_ended"].includes(String(message.metadata?.action || ""))) handlers.onUnread?.(1);
    }
    if (payload.type === "TEAM_RESOURCE_CHANGED") collaborationRef.current.invalidate();
    if (payload.type === "TEAM_MESSAGE_READ" && payload.messageId) {
      const readBy = payload.readBy && typeof payload.readBy === "object" ? payload.readBy : {};
      setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, metadata: { ...(message.metadata || {}), readBy } } : message));
    }
    if (payload.type === "TEAM_MESSAGE_REACTION" && payload.messageId) {
      const reactions = Array.isArray(payload.reactions) ? payload.reactions : [];
      setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, metadata: { ...(message.metadata || {}), reactions } } : message));
    }
  });

  useEffect(() => {
    if (!open || loading || !selectedThreadId) return undefined;
    const threadKey = scope === "team" ? "team" : scope === "subteam" ? `subteam:${subteamId}` : `direct:${recipientId}`;
    const initialForThread = lastScrolledThreadRef.current !== threadKey;
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      if (keepScroll.current) { list.scrollTop = list.scrollHeight - keepScroll.current.height + keepScroll.current.top; keepScroll.current = null; return; }
      if (!initialForThread && !nearBottom.current) return;
      list.scrollTo({ top: list.scrollHeight, behavior: initialForThread ? "auto" : "smooth" });
      lastScrolledThreadRef.current = threadKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, messages.length, open, recipientId, scope, subteamId, selectedThreadId]);

  async function sendMessage(overrideText?: string, overrideFiles?: File[]) {
    const outgoingThreadId = selectedThreadRef.current;
    if (!outgoingThreadId) return;
    const outgoingText = overrideText ?? text;
    if (overrideText === undefined && /^\/nora(?:\s|$)/i.test(outgoingText.trim())) {
      if (!noraAllowed) { setError("A Nora não está disponível nesta conversa."); return; }
      const command = outgoingText.trim().replace(/^\/nora\s*/i, "");
      const source = quotedMessage || messages[messages.length-1];
      if (/^buscar(?:\s|$)/i.test(command)) setNoraInput({ mode: "search", question: command.replace(/^buscar\s*/i, "") });
      else if (source) setNoraInput({ mode: "ask", source, question: /^tarefa(?:\s|$)/i.test(command) ? "Proponha um título e uma descrição de tarefa a partir desta conversa. Não crie nada; vou revisar." : /^agendar(?:\s|$)/i.test(command) ? "Proponha uma pauta de reunião a partir desta conversa. Não crie nada nem invente horários livres." : /^relatorio(?:\s|$)/i.test(command) ? "Prepare um relatório desta conversa com resumo, decisões, responsáveis e pendências, somente com o contexto disponível. " + command.replace(/^relatorio\s*/i, "") : "Resuma esta conversa, decisões e pendências. " + command.replace(/^resumir\s*/i, "") });
      else setError("Abra uma conversa com mensagens para dar contexto à Nora.");
      return;
    }
    if (outgoingText.length > 2000) { setError("A mensagem tem mais de 2.000 caracteres. Ajuste o texto antes de enviar."); return; }
    if (overrideText === undefined && outgoingText.trim().toLowerCase() === "/enquete") { setProductivity({ action: "poll" }); return; }
    if (overrideText === undefined && outgoingText.trim().toLowerCase() === "/lembrar") { const source = quotedMessage || messages[messages.length-1]; if (queueEnabled && source) setProductivity({ action: "reminder", source }); else setError("Selecione uma mensagem e ative os lembretes internos."); return; }
    if (/\{\{[a-z_]+\}\}/.test(outgoingText)) { setError("Preencha as variáveis do modelo antes de enviar."); return; }
    const outgoingFiles = overrideFiles ?? (overrideText === undefined ? files : []);
    const outgoingScope = scope;
    const outgoingRecipientId = outgoingScope === "direct" ? recipientId : null;
    const outgoingSubteamId = outgoingScope === "subteam" ? subteamId : null;
    if ((!outgoingText.trim() && outgoingFiles.length === 0) || sending) return;
    setSending(true);
    setError("");
    try {
      const attachments = await prepareChatAttachments(outgoingFiles);
      const response = await fetch(outgoingScope === "subteam" ? `${API_URL}/subteams/${outgoingSubteamId}/messages` : `${API_URL}/messages`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }, session.token),
        body: JSON.stringify(outgoingScope === "subteam" ? {
          text: outgoingText,
          mentionedUserIds: overrideText === undefined ? mentionedUserIds : [],
          attachments,
          quotedMessageId: overrideText === undefined ? quotedMessage?.id : undefined,
          urgentMention: overrideText === undefined && urgentMention,
        } : {
          scope: outgoingScope,
          recipientId: outgoingRecipientId,
          text: outgoingText,
          mentionedUserIds: overrideText === undefined ? mentionedUserIds : [],
          attachments,
          quotedMessageId: overrideText === undefined ? quotedMessage?.id : undefined,
          urgentMention: overrideText === undefined && urgentMention,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao enviar mensagem.");
      if (selectedThreadRef.current === outgoingThreadId) {
        setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
        if (overrideText === undefined && overrideFiles === undefined && draftRef.current.text === outgoingText && draftRef.current.files === outgoingFiles) {
          setText(""); setFiles([]); setMentionedUserIds([]); setQuotedMessage(null); setUrgentMention(false);
        }
      }
      if (drafts.current.get(outgoingThreadId)?.text === outgoingText) drafts.current.delete(outgoingThreadId);
      void loadThreads();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Falha ao enviar mensagem.");
    } finally {
      setSending(false);
    }
  }

  async function loadEarlier() {
    if (!hasMore || loadingEarlier || !messages.length) return;
    const requestedThread = selectedThreadRef.current;
    setLoadingEarlier(true);
    const params = new URLSearchParams({ scope, limit: "50", before: messages[0].id });
    if (scope === "direct") params.set("recipientId", recipientId);
    try {
      const url = scope === "subteam" ? `${API_URL}/subteams/${subteamId}/messages?limit=50&before=${encodeURIComponent(messages[0].id)}` : `${API_URL}/messages?${params}`;
      const response = await fetch(url, { headers: authHeaders(undefined, session.token) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Não foi possível carregar mensagens anteriores.");
      if (requestedThread !== selectedThreadRef.current) return;
      if (listRef.current) keepScroll.current = { height: listRef.current.scrollHeight, top: listRef.current.scrollTop };
      setMessages((current) => [...data.messages, ...current.filter((item) => !data.messages.some((old: TeamMessage) => old.id === item.id))]);
      setHasMore(Boolean(data.hasMore));
      void markMessagesRead(data.messages);
    } catch (reason) { if (requestedThread === selectedThreadRef.current) setError(reason instanceof Error ? reason.message : "Falha ao carregar mensagens."); }
    finally { if (requestedThread === selectedThreadRef.current) setLoadingEarlier(false); }
  }

  async function sendReply(replyText: string, alsoInChannel: boolean) {
    const root = collaboration.root;
    if (!root || sending || !replyText.trim()) return false;
    const selected = selectedThreadRef.current;
    setSending(true);
    try {
      const path = scope === "subteam" ? `/subteams/${subteamId}/messages` : "/messages";
      const data = await collaboration.request(path, { method: "POST", body: JSON.stringify({ ...(scope === "subteam" ? {} : { scope, recipientId: scope === "direct" ? recipientId : null }), text: replyText, replyThreadId: root.replyThreadId || root.id, alsoInChannel, attachments: [], mentionedUserIds: conversationMembers.filter((member) => replyText.includes(`@${member.nome}`)).map((member) => member.id) }) });
      if (selected !== selectedThreadRef.current) return false;
      collaboration.handleMessage(data.message);
      if (alsoInChannel) setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
      void loadThreads(); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível responder no fio."); return false; }
    finally { setSending(false); }
  }
  const jumpToMessage = useCallback(async (message: TeamMessage) => {
    const selected = selectedThreadRef.current;
    try {
      const data = await collaborationRef.current.request(`/messages/${encodeURIComponent(message.id)}/context`);
      if (selected !== selectedThreadRef.current) return;
      setMessages(data.messages.filter((item: TeamMessage) => !item.replyThreadId || item.alsoInChannel)); setHasMore(Boolean(data.hasMore)); setContentTab("chat"); nearBottom.current = false;
      if (message.replyThreadId) void collaborationRef.current.openReply(message);
      requestAnimationFrame(() => document.getElementById(`team-message-${message.replyThreadId || message.id}`)?.scrollIntoView({ block: "center" }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir o contexto."); }
  }, []);
  useEffect(() => {
    if (!open || variant !== "page" || threadsLoading) return;
    const params = new URLSearchParams(window.location.search);
    const targetThread = params.get("teamThread"), targetMessage = params.get("teamMessage");
    if (!targetThread || !targetMessage || handledMessageLink.current === targetMessage) return;
    const target = threads.find((item) => item.id === targetThread);
    if (!target) { handledMessageLink.current = targetMessage; setError("Esta conversa não está mais disponível para você."); return; }
    if (selectedThreadId !== targetThread) { selectConversation(target); return; }
    if (loading) return;
    handledMessageLink.current = targetMessage;
    void jumpToMessage({ id: targetMessage } as TeamMessage);
  }, [open, variant, threadsLoading, threads, selectedThreadId, loading, selectConversation, jumpToMessage]);
  useEffect(() => { if (collaboration.context === "reply" && collaboration.replies.length) void markMessagesRead(collaboration.replies); }, [collaboration.context, collaboration.replies, markMessagesRead]);
  useEffect(() => { if (open && selectedThreadId) window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: { type: "conversation", id: selectedThreadId } })); return () => { if (open && selectedThreadId) window.dispatchEvent(new CustomEvent("norium:presence-context", { detail: null })); }; }, [open, selectedThreadId]);
  async function setNotifications(mode: "all" | "mentions" | "none", mutedUntil?: string) { try { await collaboration.request(`/threads/${encodeURIComponent(selectedThreadId)}/notifications`, { method: "PATCH", body: JSON.stringify({ mode, mutedUntil: mutedUntil ? new Date(mutedUntil).toISOString() : null }) }); void loadThreads(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar notificações."); } }
  useEffect(() => { if (!open) return; let cancelled = false; void collaborationRef.current.request("/collaboration-capabilities").then((data) => { if (!cancelled) setQueueEnabled(Boolean(data.scheduledMessages)); }).catch(() => { if (!cancelled) setQueueEnabled(false); }); return () => { cancelled = true; }; }, [open, session.token]);
  const slashActive = text.startsWith("/");
  useEffect(() => { if (!slashActive || shortcutsScope === templateScope || !selectedThreadId) return; let cancelled = false;
    const generation = shortcutsGeneration.current;
    void collaborationRef.current.request("/shortcuts").then((data) => { if (!cancelled && generation === shortcutsGeneration.current && requestScope() === templateScope) { setShortcuts(data.templates || []); setShortcutsScope(templateScope); } })
      .catch((error) => { if (!cancelled && generation === shortcutsGeneration.current && requestScope() === templateScope) setError(error.message); });
    return () => { cancelled = true; };
  }, [slashActive, shortcutsScope, templateScope, selectedThreadId, shortcutsRevision]);
  type SlashOption = { id: string; name: string; shortcut: string; body: string; action?: "poll" | "reminder" };
  const slashCommands: SlashOption[] = [
    ...(noraAllowed ? [{ shortcut: "nora resumir", name: "Resumir conversa" }, { shortcut: "nora tarefa", name: "Preparar tarefa" },
      { shortcut: "nora agendar", name: "Preparar reunião" }, { shortcut: "nora relatorio", name: "Preparar relatório" },
      { shortcut: "nora buscar", name: "Buscar com a Nora" }].map(item => ({ ...item, id: `command-${item.shortcut}`, body: `/${item.shortcut} ` })) : []),
    ...(shortcutsScope === templateScope ? shortcuts : []),
    { id: "command-poll", name: "Criar enquete", shortcut: "enquete", body: "", action: "poll" },
    ...(queueEnabled && messages.length ? [{ id: "command-reminder", name: "Lembrar a última mensagem", shortcut: "lembrar", body: "", action: "reminder" as const }] : []),
  ];
  const shortcutOptions = slashActive && !shortcutDismissed ? slashCommands.filter(item =>
    `${item.shortcut} ${item.name}`.toLocaleLowerCase("pt-BR").includes(text.slice(1).toLocaleLowerCase("pt-BR"))).slice(0, 12) : [];
  function applyShortcut(item: SlashOption) {
    if (item.action === "poll") setProductivity({ action: "poll" });
    else if (item.action === "reminder" && messages.length && queueEnabled) setProductivity({ action: "reminder", source: messages[messages.length-1] });
    else setText(item.body.replaceAll("{{sender_name}}", session.user.nome));
    setShortcutDismissed(true); setShortcutIndex(0); inputRef.current?.focus();
  }
  function productivityDone(data: Record<string, unknown>) { const message = data.message as TeamMessage | undefined; if (message?.threadId === selectedThreadRef.current) { setMessages((current) => [...current.filter((item) => item.id !== message.id), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt))); collaboration.handleMessage(message); } if (data.scheduled && !productivity?.scheduled) { setText(""); setFiles([]); } collaboration.invalidate(); void loadThreads(); }
  async function showScheduled() { try { const data = await collaboration.request(`/scheduled-messages?threadId=${encodeURIComponent(selectedThreadId)}`); setScheduledItems(data.scheduled || []); setScheduledOpen(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao abrir agendadas."); } }
  async function cancelScheduled(job: ScheduleItem) { try { await collaboration.request(`/scheduled-messages/${encodeURIComponent(job.id)}`, { method: "DELETE" }); setScheduledItems((current) => current.filter((item) => item.id !== job.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao cancelar."); } }
  async function openNoraSource(source: NoraSource) {
    try {
      setNoraInput(null);
      const data = await collaboration.request(`/messages/${encodeURIComponent(source.messageId)}/context`);
      const target = conversationItems.find(item => item.id === source.threadId);
      if (!target) throw new Error("Esta conversa deixou de estar disponível.");
      if (source.threadId === selectedThreadRef.current) await jumpToMessage(data.message);
      else { pendingNoraSource.current = source; selectConversation(target); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir a fonte."); }
  }
  async function noraSchedule(message: TeamMessage) { try { const data = await collaboration.request(`/messages/${encodeURIComponent(message.id)}/nora-slots`); setNoraInput(null); setMeetingDraft({ title: "Alinhamento da equipe", description: message.text.slice(0, 1200), slots: data.slots, basis: data.basis }); setMeetingSchedulerOpen(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao sugerir horários."); } }
  async function changeNora(enabled: boolean) {
    if (!selectedSubteam) return;
    try { const data = await collaboration.request(`/subteams/${selectedSubteam.id}/nora`, { method: "PATCH", body: JSON.stringify({ enabled }) }); setSubteams(current => current.map(item => item.id === data.subteam.id ? data.subteam : item)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao alterar a Nora."); }
  }
  async function vote(message: TeamMessage, optionIds: string[]) { try { const data = await collaboration.request(`/messages/${encodeURIComponent(message.id)}/vote`, { method: "POST", body: JSON.stringify({ optionIds }) }); productivityDone(data); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao votar."); } }
  async function pinMessage(message: TeamMessage) { const changed = await collaboration.pin(message); if (changed) setMessages((current) => current.map((item) => item.id === changed.id ? changed : item)); }
  const loadMedia = useCallback(async (more = false) => {
    const sequence = ++mediaSequence.current; setMediaLoading(true);
    const params = new URLSearchParams({ threadId: selectedThreadId, q: mediaFilter, photos: String(contentTab === "photos"), offset: more ? String(mediaPage.length) : "0" });
    try { const data = await collaborationRef.current.request(`/conversation-attachments?${params}`); if (sequence !== mediaSequence.current) return; setMediaPage((current) => more ? [...current, ...data.attachments] : data.attachments || []); setMediaMore(Boolean(data.hasMore)); }
    catch (reason) { if (sequence === mediaSequence.current) setError(reason instanceof Error ? reason.message : "Falha ao carregar arquivos."); }
    finally { if (sequence === mediaSequence.current) setMediaLoading(false); }
  }, [selectedThreadId, mediaFilter, contentTab, mediaPage.length]);
  const loadMediaRef = useRef(loadMedia); loadMediaRef.current = loadMedia;
  const invalidateMedia = useCallback(() => { mediaSequence.current++; }, []);
  useEffect(() => { if (selectedThreadId && ["files", "photos"].includes(contentTab)) void loadMediaRef.current(); return invalidateMedia; }, [selectedThreadId, mediaFilter, contentTab, invalidateMedia]);

  function quoteMessage(message: TeamMessage) { setQuotedMessage(message); setContentTab("chat"); requestAnimationFrame(() => inputRef.current?.focus()); }
  function beginEdit(message: TeamMessage) { setEditMessage(message); setEditText(message.text); }
  async function mutateMessage(message: TeamMessage, edited?: string) {
    if (sending) return;
    setSending(true);
    try {
      const response = await fetch(`${API_URL}/messages/${encodeURIComponent(message.id)}`, { method: edited === undefined ? "DELETE" : "PATCH", headers: authHeaders({ "Content-Type": "application/json" }, session.token), body: edited === undefined ? undefined : JSON.stringify({ text: edited }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Não foi possível alterar a mensagem.");
      if (data.message.threadId === selectedThreadRef.current) setMessages((current) => current.map((item) => item.id === message.id ? data.message : item));
      setEditMessage(null); setDeleteMessage(null); void loadThreads();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao alterar a mensagem."); }
    finally { setSending(false); }
  }
  async function copyMessageLink(message: TeamMessage) {
    const url = new URL(tabPath("Chat da Equipe"), window.location.origin); url.searchParams.set("teamThread", message.threadId); url.searchParams.set("teamMessage", message.id);
    try { await navigator.clipboard.writeText(url.href); } catch { setError("Não foi possível copiar o link. Permita acesso à área de transferência."); }
  }
  function formatComposer(before: string, after = "") {
    const start = inputRef.current?.selectionStart ?? text.length, end = inputRef.current?.selectionEnd ?? start;
    setText(text.slice(0, start) + before + text.slice(start, end) + after + text.slice(end));
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(start + before.length, end + before.length); });
  }
  function expandDrawer() { window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: { tab: "Chat da Equipe", metadata: { threadId: selectedThreadId } } })); onClose(); }

  function insertEmoji(emoji: string) {
    const position = inputRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, position)}${emoji}${text.slice(position)}`;
    setText(next);
    setCursor(position + emoji.length);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position + emoji.length, position + emoji.length);
    });
  }

  async function toggleReaction(messageId: string, emoji: string) {
    setError("");
    try {
      const response = await fetch(`${API_URL}/messages/${messageId}/reactions`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }, session.token),
        body: JSON.stringify({ emoji }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao reagir à mensagem.");
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, metadata: { ...(message.metadata || {}), reactions: data.reactions || [] } } : message));
      setReactionMessageId(null);
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : "Falha ao reagir à mensagem.");
    }
  }

  async function saveSubteam(input: { name: string; description: string; memberIds: string[] }) {
    if (!subteamEditor || subteamSaving) return;
    setSubteamSaving(true);
    setError("");
    try {
      const editing = subteamEditor !== "new";
      const response = await fetch(`${API_URL}/subteams${editing ? `/${subteamEditor.id}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        headers: authHeaders({ "Content-Type": "application/json" }, session.token),
        body: JSON.stringify(input),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao salvar subequipe.");
      await loadSubteams();
      await loadThreads();
      selectConversation({ scope: "subteam", subteamId: data.subteam.id });
      setSubteamEditor(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar subequipe.");
    } finally {
      setSubteamSaving(false);
    }
  }

  async function saveMeeting(input: TeamMeetingScheduleInput) {
    if (meetingSaving) return;
    setMeetingSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/meetings`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }, session.token),
        body: JSON.stringify({
          ...input,
          scope,
          recipientId: scope === "direct" ? recipientId : null,
          subteamId: scope === "subteam" ? subteamId : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao agendar reunião.");
      if (data.message) setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
      setMeetingSchedulerOpen(false);
      setMeetingDraft(undefined);
      setContentTab("chat");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao agendar reunião.");
    } finally {
      setMeetingSaving(false);
    }
  }

  async function addMeetingToCalendar(meetingId: string) {
    setError("");
    try {
      const response = await fetch(`${API_URL}/meetings/${encodeURIComponent(meetingId)}/calendar`, {
        method: "POST",
        headers: authHeaders(undefined, session.token),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Não consegui adicionar a reunião à agenda.");
      if (data.message) setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
    } catch (addError) {
      const message = addError instanceof Error ? addError.message : "Não consegui adicionar a reunião à agenda.";
      setError(message);
      throw addError;
    }
  }

  function selectMention(option: { id: string; name: string }) {
    if (!mentionMatch) return;
    const token = `@${option.name} `;
    const nextText = text.slice(0, mentionMatch.start) + token + text.slice(mentionMatch.end);
    const nextCursor = mentionMatch.start + token.length;
    setText(nextText);
    setCursor(nextCursor);
    if (option.id !== "nora") setMentionedUserIds((current) => Array.from(new Set([...current, option.id])));
    setMentionDismissed(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(nextCursor, nextCursor); });
  }

  const canStartCall = conversationSelected && !call.busy && !call.active && (scope === "team" || (scope === "direct" && Boolean(recipientId)) || (scope === "subteam" && Boolean(selectedSubteam)));
  const selectedConversation = threads.find((item) => item.id === selectedThreadId);
  const activeMeeting = call.availableCalls.find((meeting) => meeting.threadId === selectedThreadId);
  const startOrJoinCall = useCallback(
    () => activeMeeting ? callCommands.join(activeMeeting) : startCall(),
    [activeMeeting, callCommands, startCall],
  );
  const conversationMemberCount = conversationMembers.length;
  const conversationOnlineCount = conversationMembers.filter((member) => actualOnlineUserIdSet.has(member.id)).length;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="team-chat"
          initial={variant === "drawer" ? { x: 420, opacity: 0 } : { opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={variant === "drawer" ? { x: 420, opacity: 0 } : { opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          className={"team-chat-v3 " + (variant === "drawer"
            ? `team-chat-drawer team-chat-professional ${conversationSelected ? "has-conversation" : "no-conversation"} fixed right-4 top-20 z-[95] flex h-[min(760px,calc(100dvh-104px))] w-[390px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] text-[var(--text)] shadow-2xl shadow-black/50 backdrop-blur-2xl`
            : `team-chat-drawer team-chat-page team-chat-professional ${conversationSelected ? "has-conversation" : "no-conversation"} ${collaboration.context ? "with-details" : ""} mx-4 mb-4 mt-3 min-h-0 overflow-hidden rounded-lg border border-[var(--border)] text-[var(--text)]`
          )}
        >
          <header className="team-chat-header">
            {variant === "drawer" && <button type="button" className="team-icon-button" aria-label="Expandir chat na mesma conversa" title="Expandir chat" onClick={expandDrawer}><Maximize2 size={16} /></button>}
            <div className="team-chat-heading"><span className="team-chat-heading-icon"><MessageSquare size={20} /></span><div><h1>Chat da equipe</h1><p><i />{actualOnlineUserIds.length} online · Colabore em tempo real</p></div></div>
            <div className="team-chat-header-actions">{canUse(session.user, "nora") && <button type="button" className="nx-btn is-sm" onClick={() => setNoraInput({ mode: "catch-up" })}>O que você perdeu</button>}{onOpenCalendar && <Button variant="ghost" size="sm" iconOnly onClick={onOpenCalendar} aria-label="Abrir calendário" title="Abrir calendário"><CalendarDays size={17} /></Button>}{variant === "drawer" ? <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar chat"><X size={18} /></Button> : <Button variant="secondary" size="sm" onClick={onClose} icon={<Users size={15} />}>Equipe</Button>}</div>
          </header>
          {!conversationSelected && error && <div role="alert" className="team-chat-feedback px-4 py-2 text-xs">{error}</div>}
          <div className="team-chat-body">
          <TeamConversationNavigation user={session.user} states={presence.states} onStatus={() => setStatusOpen(true)} items={conversationItems} selectedId={selectedThreadId} loading={threadsLoading} pinningId={pinningId} onSelect={selectConversation} onPin={(item) => void togglePin(item)} onCreate={() => setSubteamEditor("new")} onNora={canUse(session.user, "nora") && onOpenNora ? () => onOpenNora() : undefined} />
          {!conversationSelected ? <main className="team-chat-unselected"><div className="team-chat-welcome-icon"><MessageSquare size={32} /></div><h2>Uma equipe. Boas conversas.</h2><p>Selecione uma conversa para trocar mensagens,<br />compartilhar arquivos e tomar decisões em equipe.</p><div className="team-chat-welcome-hints"><span><Pin size={15} /> Fixe as mais importantes</span><span><AtSign size={16} /> Mencione e notifique pessoas</span></div><Button variant="primary" size="md" onClick={() => selectConversation({ scope: "team" })} icon={<Users size={16} />}>Conversar com o time</Button></main> : <main className="team-chat-conversation">
          <div className="team-chat-thread-header"><div className="team-chat-thread-title"><button type="button" className="team-icon-button team-chat-back" onClick={() => selectConversation(null)} aria-label="Voltar às conversas"><ArrowLeft size={18} /></button><span className="team-chat-thread-icon">{scope === "team" ? <Users size={19} /> : scope === "subteam" ? <Hash size={19} /> : <UserRound size={19} />}</span><div><h2>{threadTitle}</h2><p>{scope === "direct" ? conversationOnlineCount > 1 ? "Online agora" : "Conversa privada" : `${conversationMemberCount} participantes · ${conversationOnlineCount} online`}</p></div></div><div className="team-v3-header-people" aria-label="Participantes da conversa">{conversationMembers.slice(0, 4).map((member) => <span key={member.id} data-presence={presence.states[member.id]?.state || (actualOnlineUserIdSet.has(member.id) ? "online" : "offline")} title={member.nome + " · " + (presence.states[member.id]?.label || "Membro")}><MessageAvatar name={member.nome} avatar={member.fotoUrl || ""} onClick={() => setSelectedMemberId(member.id)} /></span>)}</div><div className="team-chat-thread-actions">
            {selectedConversation && <button type="button" className={`team-icon-button ${selectedConversation.pinned ? "is-pinned" : ""}`} disabled={Boolean(pinningId)} onClick={() => void togglePin(selectedConversation)} aria-label={selectedConversation.pinned ? "Desafixar conversa atual" : "Fixar conversa atual"} title={selectedConversation.pinned ? "Desafixar conversa" : "Fixar conversa"}>{selectedConversation.pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
            <button type="button" className="team-icon-button" aria-label="Buscar na conversa" title="Buscar mensagens" onClick={() => collaboration.setContext(collaboration.context === "search" ? null : "search")}><Search size={16} /></button>
            {queueEnabled && <button type="button" className="team-icon-button" aria-label="Ver meus envios agendados" title="Meus envios agendados" onClick={() => void showScheduled()}><Clock3 size={16} /></button>}
            <button type="button" className="nx-btn is-sm team-thread-button" onClick={() => setMeetingSchedulerOpen(true)} disabled={!canStartCall} aria-label="Agendar reunião" title="Agendar reunião"><CalendarPlus size={14} /><span>Agendar reunião</span></button>
            <button type="button" className="nx-btn is-sm team-thread-button team-call-action" disabled={!canStartCall} onClick={() => void startOrJoinCall()} aria-label={activeMeeting ? "Ingressar na reunião" : "Iniciar reunião"} title="Reunião por vídeo"><Video size={14} /><span>{activeMeeting ? "Ingressar" : "Chamada"}</span></button>
            <button type="button" className="team-icon-button" onClick={() => setDetailsOpen((current) => !current)} aria-label="Detalhes da conversa" aria-expanded={detailsOpen} title="Detalhes da conversa"><PanelRight size={17} /></button>
            <button type="button" className="team-icon-button team-chat-deselect" onClick={() => selectConversation(null)} aria-label="Fechar conversa" title="Fechar conversa"><X size={18} /></button>
          </div></div>
          <nav className="team-chat-tabs flex items-end gap-5 border-b border-[var(--border)] px-4">
            <button type="button" aria-label="Chat" aria-pressed={contentTab === "chat"} onClick={() => setContentTab("chat")} className={contentTab === "chat" ? "active" : ""}>Mensagens</button>
            <button type="button" aria-pressed={contentTab === "replies"} className={contentTab === "replies" ? "active" : ""} onClick={() => setContentTab("replies")}>Fios</button>
            <button type="button" aria-pressed={contentTab === "files"} onClick={() => setContentTab("files")} className={contentTab === "files" ? "active" : ""}>Arquivos <span>{threadAttachments.length}</span></button>
            <button type="button" aria-pressed={contentTab === "photos"} onClick={() => setContentTab("photos")} className={contentTab === "photos" ? "active" : ""}>Fotos <span>{photoAttachments.length}</span></button>
            {([['pins', 'Fixadas'], ['tasks', 'Tarefas']] as const).map(([id, title]) => <button type="button" key={id} aria-pressed={contentTab === id} className={contentTab === id ? "active" : ""} onClick={() => setContentTab(id)}>{title}</button>)}
          </nav>

          {activeMeeting && <div className="shrink-0 border-b border-[var(--border)] px-4 py-3"><TeamActiveCallCard meeting={activeMeeting} busy={call.busy || Boolean(call.active)} joined={call.active?.callId === activeMeeting.callId} onJoin={() => void callCommands.join(activeMeeting)} /></div>}
          {["files", "photos"].includes(contentTab) && <label className="team-v3-media-filter"><Search size={15} /><input aria-label="Filtrar arquivos da conversa" value={mediaFilter} placeholder="Buscar pelo nome do arquivo" onChange={(event) => setMediaFilter(event.target.value)} maxLength={150} /></label>}
          <div ref={listRef} onScroll={() => { const list = listRef.current; if (!list) return; nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 100; messageWindow.onScroll(); if (list.scrollTop < 50 && !loading) void loadEarlier(); }} className="team-chat-list min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {["files", "photos"].includes(contentTab) && <>{mediaLoading && <p role="status">Carregando arquivos…</p>}{mediaMore && <button type="button" className="nx-btn" disabled={mediaLoading} onClick={() => void loadMedia(true)}>Carregar mais arquivos</button>}</>}
            {hasMore && <button type="button" className="nx-btn is-sm" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? "Carregando anteriores…" : "Carregar mensagens anteriores"}</button>}
            {loading && <p className="text-center text-xs font-bold text-[var(--text-secondary)]">Carregando conversa...</p>}
            {contentTab === "chat" && !loading && messages.length === 0 && !activeMeeting && (
              <div className="grid h-full place-items-center text-center text-[var(--text-secondary)]">
                <div>
                  <UserRound className="mx-auto mb-3" size={34} />
                  <p className="text-sm font-bold">Nenhuma mensagem ainda.</p>
                </div>
              </div>
            )}
            {contentTab === "chat" && messageWindow.top > 0 && <div style={{ height: messageWindow.top }} aria-hidden="true" />}
            {contentTab === "chat" && !loading && messageWindow.items.map((message, localIndex) => {
              const index = messageWindow.start+localIndex;
              const mine = message.senderId === session.user.id;
              const member = memberById.get(message.senderId);
              const senderAvatar = message.senderAvatar || member?.fotoUrl || (message.senderId === "nora" ? "nora" : "");
              const isNora = message.senderId === "nora";
              const readReceipts = mine ? readReceiptsFor(message) : [];
              const reactions = reactionsFor(message);
              const quoted = messages.find((item) => item.id === message.quotedMessageId);
              const day = new Date(message.createdAt).toLocaleDateString("pt-BR");
              const previousDay = index ? new Date(messages[index-1].createdAt).toLocaleDateString("pt-BR") : "";
              const deleted = Boolean(message.metadata?.deletedAt);
              return (
                <div key={message.id} ref={(node) => messageWindow.measure(message.id, node)} data-virtual-id={message.id}>{day !== previousDay && <div className="team-v3-day">{day}</div>}<div id={`team-message-${message.id}`} className={`team-chat-row ${mine ? "is-mine" : ""} flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
                  {!mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} onClick={member ? () => setSelectedMemberId(member.id) : undefined} />}
                  <div className={`team-chat-message ${isNora ? "team-chat-message-nora max-w-[94%]" : "max-w-[78%]"} ${Array.isArray(message.metadata?.mentionedUserIds) && message.metadata.mentionedUserIds.includes(session.user.id) ? "mentions-me" : ""} rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "team-chat-message-mine" : "team-chat-message-other"}`}>
                    <div className={`mb-1 flex items-center justify-between gap-3 text-xs font-bold ${mine ? "team-chat-message-meta-mine" : "team-chat-message-meta-other"}`}>
                      <span className="min-w-0 truncate">{message.senderName}{isNora && <b className="team-v3-assistant">Assistente</b>}</span>
                      <span className="shrink-0 text-right">{formatMessageDateTime(message.createdAt)}</span>
                    </div>
                    {!deleted && <TeamMessageActions mine={mine && !message.metadata?.action} onTask={canUse(session.user, "tarefas") ? () => setProductivity({ action: "task", source: message }) : undefined} onReminder={queueEnabled ? () => setProductivity({ action: "reminder", source: message }) : undefined} onNora={noraAllowed ? () => setNoraInput({ mode: "ask", source: message }) : undefined} onClient={noraAllowed && canUse(session.user, "central") ? () => setNoraInput({ mode: "client", source: message }) : undefined} onForward={() => setProductivity({ action: "forward", source: message })} onThread={() => void collaboration.openReply(message)} pinned={Boolean(message.metadata?.pinnedAt)} onPin={() => void pinMessage(message)} onReply={() => quoteMessage(message)} onReact={(emoji) => void toggleReaction(message.id, emoji)} onMoreReaction={() => setReactionMessageId(message.id)} onCopy={() => void copyMessageLink(message)} onEdit={() => beginEdit(message)} onDelete={() => setDeleteMessage(message)} />}
                    {message.quotedMessageId && <div className="team-v3-quote"><div><strong>{quoted?.senderName || "Mensagem anterior"}</strong><p>{quoted?.metadata?.deletedAt ? "Mensagem apagada" : quoted?.text || "Abra o contexto para ler a mensagem citada."}</p></div></div>}
                    {deleted ? <em className="text-xs">Mensagem apagada</em> : message.metadata?.poll ? <TeamPollCard poll={message.metadata.poll as TeamPoll} userId={session.user.id} onVote={(choices) => vote(message, choices)} /> : message.text && <NoraMessageContent message={message} />}
                    {Boolean(message.metadata?.editedAt) && !deleted && <small>editada</small>}
                    <TeamResourceCards cards={collaboration.cards[message.id] || []} />
                    <TeamNoraMessageTools message={message} request={collaboration.request} onSource={source => void openNoraSource(source)} enabled={noraAllowed} onTask={canUse(session.user, "tarefas") ? () => setProductivity({ action: "task", source: message }) : undefined} onSchedule={() => noraSchedule(message)} />
                    {Boolean(message.metadata?.pinnedAt) && <small className="team-v3-pin-label"><Pin size={11} />Fixada</small>}
                    {Number(message.metadata?.replyCount || 0) > 0 && <button type="button" className="team-v3-reply-count" onClick={() => void collaboration.openReply(message)}><TeamReplySummary message={message} members={conversationMembers} /></button>}
                    {message.metadata?.action === "meeting_scheduled" && <TeamMeetingMessageCard metadata={message.metadata} currentUserId={session.user.id} onAddToCalendar={addMeetingToCalendar} onStart={() => void startCall()} />}
                    {message.attachments?.length > 0 && (
                      <div className="mt-2 grid gap-2">
                        {message.attachments.map((attachment) => (
                          <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />
                        ))}
                      </div>
                    )}
                    <div className="team-message-reactions">
                      {reactions.map((reaction) => (
                        <button key={reaction.emoji} type="button" className={reaction.userIds.includes(session.user.id) ? "is-mine" : ""} onClick={() => void toggleReaction(message.id, reaction.emoji)} aria-label={`${reaction.userIds.length} reação ${reaction.emoji}`} title={`${reaction.userIds.length} pessoa(s)`}>
                          <span>{reaction.emoji}</span><strong>{reaction.userIds.length}</strong>
                        </button>
                      ))}
                      <button type="button" className="team-reaction-add" onClick={() => setReactionMessageId((current) => current === message.id ? null : message.id)} aria-label="Reagir com emoji" title="Reagir"><SmilePlus size={15} /></button>
                      {reactionMessageId === message.id && (
                        <div className="team-reaction-menu">
                          <div className="team-quick-reactions">
                            {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void toggleReaction(message.id, emoji)} aria-label={`Reagir com ${emoji}`}>{emoji}</button>)}
                          </div>
                          <TeamEmojiPicker title="Reagir à mensagem" onSelect={(emoji) => void toggleReaction(message.id, emoji)} onClose={() => setReactionMessageId(null)} />
                        </div>
                      )}
                    </div>
                    {mine && <button type="button" onClick={() => setReadReceiptsMessageId(message.id)} className="mt-2 flex items-center gap-1 text-[11px] font-bold text-blue-100/75 transition hover:text-white" aria-label={`Ver confirmações de leitura: ${readReceipts.length} pessoa(s) viram`}><CheckCheck size={14} /> {readReceipts.length ? `${readReceipts.length} viram` : "Ninguém viu ainda"}</button>}
                  </div>
                  {mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} onClick={member ? () => setSelectedMemberId(member.id) : undefined} />}
                </div></div>
              );
            })}
            {contentTab === "chat" && messageWindow.bottom > 0 && <div style={{ height: messageWindow.bottom }} aria-hidden="true" />}
            {contentTab === "files" && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {mediaPage.map((attachment) => <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />)}
                {!mediaPage.length && !mediaLoading && <div className="col-span-full grid min-h-72 place-items-center text-center text-[var(--text-secondary)]"><div><FolderOpen className="mx-auto" size={38} /><p className="mt-3 text-sm font-bold">Nenhum arquivo nesta conversa.</p></div></div>}
              </div>
            )}
            {contentTab === "photos" && (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {mediaPage.map((attachment) => <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />)}
                {!mediaPage.length && !mediaLoading && <div className="col-span-full grid min-h-72 place-items-center text-center text-[var(--text-secondary)]"><div><Images className="mx-auto" size={38} /><p className="mt-3 text-sm font-bold">Nenhuma foto nesta conversa.</p></div></div>}
              </div>
            )}
            {(["pins", "replies"] as TeamContentTab[]).includes(contentTab) && <div className="team-v3-collection">{collaboration.collection.map((message) => <article key={message.id}><strong>{message.senderName}</strong><NoraMessageContent message={message} />{contentTab === "replies" && <TeamReplySummary message={message} members={conversationMembers} />}<button type="button" className="nx-btn is-sm" onClick={() => contentTab === "replies" ? void collaboration.openReply(message) : void jumpToMessage(message)}>{contentTab === "replies" ? "Abrir fio" : "Ver no contexto"}</button>{contentTab === "pins" && <button type="button" className="nx-btn is-sm" onClick={() => void pinMessage(message)}>Desafixar</button>}</article>)}{!collaboration.collection.length && <p>{contentTab === "pins" ? "Nenhuma mensagem fixada." : "Você ainda não participa de um fio nesta conversa."}</p>}</div>}
            {contentTab === "tasks" && <div><TeamResourceCards cards={collaboration.tasks} />{!collaboration.tasks.length && <p>Nenhuma tarefa criada a partir desta conversa.</p>}</div>}
          </div>

          {contentTab === "chat" && files.length > 0 && (
            <>
            <div className="team-chat-pending-files flex gap-2 overflow-x-auto border-t border-[var(--border)] px-3 py-2">
              {files.map((file) => (
                <PendingFilePreview key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles((current) => current.filter((item) => item !== file))} />
              ))}
            </div>
            </>
          )}

          {contentTab === "chat" && showMentionSuggestions && <div className="team-chat-mention-panel" role="listbox" id="team-mention-options" aria-label="Mencionar participante"><p><AtSign size={14} /> Mencionar na conversa</p>{mentionOptions.map((option, index) => <button key={option.id} id={`team-mention-${index}`} type="button" role="option" aria-selected={index === Math.min(mentionIndex, mentionOptions.length - 1)} className={index === Math.min(mentionIndex, mentionOptions.length - 1) ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(option)}><MessageAvatar name={option.name} avatar={option.avatar} /><span><strong>{option.id === "nora" ? "Nora" : option.name}</strong><small>{option.id === "nora" ? "Assistente da equipe" : "Receberá uma notificação"}</small></span><AtSign size={14} /></button>)}</div>}

          {error && (
            <div role="alert" className="team-chat-error team-chat-feedback mx-3 mt-2 shrink-0 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
              {error}
            </div>
          )}
          {!call.active && call.status && (
            <div className="team-chat-error mx-3 mt-2 shrink-0 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-100">{call.status}</div>
          )}

          {contentTab === "chat" && <footer className="team-chat-footer">
            {mentionedUserIds.length > 0 && <label className="team-v3-urgent"><input type="checkbox" checked={urgentMention} onChange={(event) => setUrgentMention(event.target.checked)} />Marcar menção como urgente</label>}
            {shortcutOptions.length > 0 && <div className="team-v3-shortcuts" id="team-quick-replies" role="listbox" aria-label="Comandos e respostas rápidas">
              {shortcutOptions.map((item, index) => <button type="button" role="option" id={`team-quick-reply-${index}`} aria-selected={index === Math.min(shortcutIndex, shortcutOptions.length-1)} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => applyShortcut(item)}><strong>/{item.shortcut}</strong><span><small>{item.name}</small>{!item.id.startsWith("command-") && <small className="team-v3-shortcut-preview">{item.body.slice(0, 100)}</small>}</span></button>)}
            </div>}
            {quotedMessage && <div className="team-v3-quote"><div><strong>Respondendo a {quotedMessage.senderName}</strong><p>{quotedMessage.text}</p></div><button type="button" className="team-icon-button" aria-label="Cancelar resposta citada" onClick={() => setQuotedMessage(null)}><X size={14} /></button></div>}
            {emojiPickerOpen && <div className="team-composer-emoji-picker"><TeamEmojiPicker onSelect={insertEmoji} onClose={() => setEmojiPickerOpen(false)} /></div>}
            <div className="team-chat-composer">
            <textarea ref={inputRef} value={text} rows={2} maxLength={2000} aria-label="Mensagem para a conversa" aria-autocomplete="list" aria-controls={showMentionSuggestions ? "team-mention-options" : shortcutOptions.length ? "team-quick-replies" : undefined} aria-activedescendant={showMentionSuggestions ? `team-mention-${Math.min(mentionIndex, mentionOptions.length - 1)}` : shortcutOptions.length ? `team-quick-reply-${Math.min(shortcutIndex, shortcutOptions.length - 1)}` : undefined}
              onChange={(event) => { setText(event.target.value); setCursor(event.target.selectionStart); setMentionDismissed(false); setMentionIndex(0); setShortcutDismissed(false); setShortcutIndex(0); }}
              onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" && shortcutOptions.length) { event.preventDefault(); setShortcutDismissed(true); return; }
                if (shortcutOptions.length && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setShortcutIndex(current => (current + (event.key === "ArrowDown" ? 1 : -1) + shortcutOptions.length) % shortcutOptions.length); return; }
                if (shortcutOptions.length && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) { event.preventDefault(); applyShortcut(shortcutOptions[Math.min(shortcutIndex, shortcutOptions.length - 1)]); return; }
                if (event.key === "ArrowUp" && !text && !showMentionSuggestions) { const last = messages.findLast((message) => message.senderId === session.user.id && !message.metadata?.deletedAt && !message.metadata?.action); if (last) { event.preventDefault(); beginEdit(last); return; } }
                if (showMentionSuggestions && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length); return; }
                if (showMentionSuggestions && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); selectMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)]); return; }
                if (showMentionSuggestions && event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); return; }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
              }} placeholder={`Mensagem para ${threadTitle}. Use @ para mencionar.`} className="team-chat-input" />
            <div className="team-chat-composer-actions"><div>
              <button type="button" className="team-icon-button" aria-label="Criar enquete" title="Criar enquete" onClick={() => setProductivity({ action: "poll" })}><Plus size={16} /></button>
              <button type="button" className="team-icon-button" aria-label="Negrito" onClick={() => formatComposer("**", "**")}><Bold size={16} /></button><button type="button" className="team-icon-button" aria-label="Lista" onClick={() => formatComposer("\n- ")}><List size={16} /></button><button type="button" className="team-icon-button" aria-label="Código" onClick={() => formatComposer("`", "`")}><Code size={16} /></button>
              <label className="team-icon-button" aria-label="Anexar imagem ou arquivo" title="Anexar imagem ou arquivo"><Paperclip size={18} /><input type="file" multiple className="sr-only" aria-label="Anexar arquivos" onChange={(event) => { const next = [...files, ...Array.from(event.target.files || [])]; if (next.length > 8) setError("Envie até 8 arquivos por mensagem."); else setFiles(next); event.currentTarget.value = ""; }} /></label>
              <button type="button" className="team-icon-button" aria-label="Mencionar membro" title="Mencionar membro" onClick={() => { const pos = inputRef.current?.selectionStart ?? text.length; const prefix = pos > 0 && !/\s/.test(text[pos - 1]) ? " @" : "@"; setText(text.slice(0, pos) + prefix + text.slice(pos)); setCursor(pos + prefix.length); setMentionIndex(0); setMentionDismissed(false); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos + prefix.length, pos + prefix.length); }); }}><AtSign size={18} /></button>
              <button type="button" className="team-icon-button" aria-label="Escolher emoji" title="Emojis" aria-expanded={emojiPickerOpen} onClick={() => setEmojiPickerOpen((current) => !current)}><SmilePlus size={18} /></button>
              <TeamVoiceRecorder disabled={sending} onSend={(file) => void sendMessage("", [file])} onError={setError} />
              {queueEnabled && <button type="button" className="team-icon-button" aria-label="Agendar envio" title="Agendar envio" onClick={() => setProductivity({ action: "schedule" })}><Clock3 size={16} /></button>}
            </div><Button variant="primary" size="sm" onClick={() => void sendMessage()} disabled={sending || (!text.trim() && !files.length)} icon={<Send size={15} />} className="team-chat-send"><span className="team-chat-send-label">{sending ? "Enviando..." : "Enviar"}</span></Button></div>
            </div><p className="team-chat-composer-hint"><span>Enter envia · Shift + Enter quebra a linha</span><span>{text.length}/2000</span></p>
          </footer>}
          </main>}
          {conversationSelected && detailsOpen && (
            <aside className="team-chat-context border-l border-[var(--border)] p-4">
              <div className="team-chat-details-heading"><p>Detalhes da conversa</p><button type="button" className="team-icon-button" onClick={() => setDetailsOpen(false)} aria-label="Fechar detalhes"><X size={16} /></button></div>
              <div className="mt-2 flex items-start justify-between gap-2"><h2 className="text-lg font-semibold">{threadTitle}</h2>{scope === "subteam" && selectedSubteam && (selectedSubteam.createdBy === session.user.id || session.user.id === (session.user.teamOwnerId || session.user.id) || session.user.systemAdmin) && <Button variant="ghost" size="sm" iconOnly onClick={() => setSubteamEditor(selectedSubteam)} aria-label="Editar subequipe"><Settings2 size={15} /></Button>}</div>
              <p className="mt-1 text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                {scope === "team" ? "Canal interno para decisoes, atualizacoes e colaboracao entre todos os membros." : scope === "subteam" ? selectedSubteam?.description || "Comunidade reservada para os membros desta subequipe." : "Conversa reservada entre os participantes selecionados."}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2"><Button className="w-full" variant="secondary" size="sm" onClick={() => void startOrJoinCall()} disabled={!canStartCall} icon={<Video size={14} />}>{activeMeeting ? "Ingressar" : "Iniciar reunião"}</Button><Button className="w-full" variant="ghost" size="sm" onClick={() => setMeetingSchedulerOpen(true)} disabled={!canStartCall} icon={<CalendarPlus size={14} />}>Agendar</Button></div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">Participantes</span>
                  <strong className="mt-1 block text-xl">{conversationMemberCount}</strong>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">Online agora</span>
                  <strong className="mt-1 block text-xl text-emerald-300">{conversationOnlineCount}</strong>
                </div>
              </div>
              {canUse(session.user, "nora") && (
                <section className="mt-5 rounded-lg border border-cyan-400/25 bg-cyan-400/8 p-4">
                  <div className="flex items-center gap-3">
                    <NoraAvatar className="h-10 w-10" />
                    <div><strong className="block text-sm">Nora na conversa</strong><small className="text-[var(--text-secondary)]">{noraAllowed ? "Ativa quando mencionada" : "Desativada nesta subequipe"}</small></div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { const source = messages[messages.length-1]; if (source) setNoraInput({ mode: "ask", source, question: "Resuma decisões e próximos passos desta conversa." }); }}
                    disabled={sending || !noraAllowed || !messages.length}
                    className="mt-3 flex h-10 w-full items-center justify-center rounded-lg border border-cyan-400/25 text-xs font-bold text-cyan-200 hover:bg-cyan-400/10"
                  >
                    {sending ? "Enviando para a Nora..." : "Resumir conversa com a Nora"}
                  </button>
                  {selectedSubteam && (session.user.systemAdmin || (session.user.teamOwnerId || session.user.id) === session.user.id || selectedSubteam.createdBy === session.user.id) && <label className="team-v3-check"><input type="checkbox" checked={selectedSubteam.noraEnabled !== false} onChange={event => void changeNora(event.target.checked)} />Nora pode responder aqui</label>}
                </section>
              )}
              <div className="mt-5">
                <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Agora na equipe</p>
                <div className="mt-3 space-y-2">
                  {conversationMembers.map((member) => (
                    <div key={member.id} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 hover:bg-[var(--surface-hover)]">
                      <button type="button" onClick={() => setSelectedMemberId(member.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Ver presença e último acesso de ${member.nome}`}>
                        <MessageAvatar name={member.nome} avatar={member.fotoUrl || ""} />
                        <span className="min-w-0 flex-1"><strong className="block truncate text-xs">{member.nome}</strong><small className={actualOnlineUserIdSet.has(member.id) ? "text-emerald-300" : "text-[var(--text-secondary)]"}>{actualOnlineUserIdSet.has(member.id) ? "Online agora" : "Offline"}</small></span>
                      </button>
                      {member.id !== session.user.id && <button type="button" onClick={() => { selectConversation({ scope: "direct", recipientId: member.id }); void startCall({ scope: "direct", title: member.nome, recipientId: member.id, subteamId: null }); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--primary)] hover:bg-[var(--surface)]" aria-label={`Ligar individualmente para ${member.nome}`}><Phone size={15} /></button>}
                      {presence.states[member.id] && <small className="team-v3-member-context">{presence.states[member.id].emoji} {[presence.states[member.id].label, presence.states[member.id].context].filter(Boolean).join(" · ")}</small>}
                    </div>
                  ))}
                </div>
              </div>
              <section className="team-v3-notifications"><h3>Notificações</h3><label>Receber<select aria-label="Notificações desta conversa" value={selectedConversation?.notificationMode || "all"} onChange={(event) => void setNotifications(event.target.value as "all" | "mentions" | "none")}><option value="all">Tudo</option><option value="mentions">Menções</option><option value="none">Nada</option></select></label><label>Silenciar até<input aria-label="Silenciar conversa até" type="datetime-local" onChange={(event) => void setNotifications(selectedConversation?.notificationMode || "all", event.target.value)} /></label></section>
            </aside>
          )}
          {conversationSelected && ["reply", "search"].includes(collaboration.context || "") && <TeamCollaborationPanel key={selectedThreadId + (collaboration.root?.id || "") + collaboration.context} collaboration={collaboration} members={conversationMembers} userId={session.user.id} sending={sending} renderMessage={(message) => <>{message.metadata?.deletedAt ? <em>Mensagem apagada</em> : <><NoraMessageContent message={message} /><TeamNoraMessageTools message={message} request={collaboration.request} onSource={source => void openNoraSource(source)} enabled={noraAllowed} onAsk={noraAllowed ? () => setNoraInput({ mode: "ask", source: message }) : undefined} onTask={canUse(session.user, "tarefas") ? () => setProductivity({ action: "task", source: message }) : undefined} onSchedule={() => void noraSchedule(message)} /></>}{message.attachments?.map((attachment) => <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />)}</>} onSendReply={sendReply} onContext={(message) => void jumpToMessage(message)} />}
          </div>
          {previewAttachment && <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} token={session.token} />}
          {editMessage && <TeamChatDialog title="Editar mensagem" onClose={() => setEditMessage(null)}><textarea aria-label="Texto da mensagem editada" maxLength={2000} rows={5} value={editText} onChange={(event) => setEditText(event.target.value)} /><footer><button type="button" className="nx-btn" onClick={() => setEditMessage(null)}>Cancelar</button><button type="button" className="nx-btn is-primary" disabled={sending || !editText.trim()} onClick={() => void mutateMessage(editMessage, editText)}>Salvar mensagem</button></footer></TeamChatDialog>}
          {deleteMessage && <TeamChatDialog title="Apagar mensagem" onClose={() => setDeleteMessage(null)}><p>Apagar esta mensagem para os participantes da conversa?</p><blockquote>{deleteMessage.text}</blockquote><footer><button type="button" className="nx-btn" onClick={() => setDeleteMessage(null)}>Cancelar</button><button type="button" className="nx-btn" disabled={sending} onClick={() => void mutateMessage(deleteMessage)}>Confirmar exclusão</button></footer></TeamChatDialog>}
          {productivity && <TeamChatProductivityDialog action={productivity.action} source={productivity.source} scheduled={productivity.scheduled} draft={text} members={conversationMembers} conversations={conversationItems} target={{ scope, recipientId: scope === "direct" ? recipientId : null, subteamId: scope === "subteam" ? subteamId : null }} request={collaboration.request} onClose={() => setProductivity(null)} onDone={productivityDone} attachments={() => prepareChatAttachments(files)} />}
          {noraInput && <TeamNoraDialog input={noraInput} request={collaboration.request} onClose={() => setNoraInput(null)} onSource={source => void openNoraSource(source)} onMessage={message => productivityDone({ message })} onTask={canUse(session.user, "tarefas") ? message => { setNoraInput(null); setProductivity({ action: "task", source: message }); } : undefined} onSchedule={noraSchedule} />}
          {scheduledOpen && <TeamChatDialog title="Meus envios agendados" onClose={() => setScheduledOpen(false)}>{!scheduledItems.length && <p>Nenhum envio agendado nesta conversa.</p>}{scheduledItems.map((job) => <article key={job.id} className="team-v3-scheduled"><strong>{new Date(job.dueAt).toLocaleString("pt-BR")}</strong><p>{job.message.text}</p><small>{job.message.attachments?.length || 0} anexo(s) · só você pode ver</small><footer><button type="button" className="nx-btn is-sm" onClick={() => { setScheduledOpen(false); setProductivity({ action: "schedule", scheduled: job }); }}>Editar</button><button type="button" className="nx-btn is-sm" onClick={() => void cancelScheduled(job)}>Cancelar envio</button></footer></article>)}</TeamChatDialog>}
          {subteamEditor && <SubteamEditorDialog value={subteamEditor} members={members} currentUserId={session.user.id} saving={subteamSaving} onClose={() => setSubteamEditor(null)} onSave={(input) => void saveSubteam(input)} />}
          {selectedMember && <TeamMemberPresenceDialog
            member={selectedMember}
            presence={presence.states[selectedMember.id]}
            online={actualOnlineUserIdSet.has(selectedMember.id)}
            isCurrentUser={selectedMember.id === session.user.id}
            token={session.token}
            onClose={() => setSelectedMemberId(null)}
            onSchedule={!canStartCall || selectedMember.id === session.user.id ? undefined : () => { selectConversation({ scope: "direct", recipientId: selectedMember.id }); setSelectedMemberId(null); setMeetingSchedulerOpen(true); }}
            onMessage={() => { selectConversation({ scope: "direct", recipientId: selectedMember.id }); setSelectedMemberId(null); }}
            onCall={() => { selectConversation({ scope: "direct", recipientId: selectedMember.id }); setSelectedMemberId(null); void startCall({ scope: "direct", title: selectedMember.nome, recipientId: selectedMember.id, subteamId: null }); }}
          />}
          {statusOpen && <TeamStatusDialog preferences={presence.preferences} onSave={presence.save} onClose={() => setStatusOpen(false)} />}
          {meetingSchedulerOpen && <TeamMeetingSchedulerDialog
            scopeLabel={threadTitle}
            initialDraft={meetingDraft}
            members={conversationMembers}
            currentUserId={session.user.id}
            saving={meetingSaving}
            onClose={() => { setMeetingSchedulerOpen(false); setMeetingDraft(undefined); }}
            onSave={(input) => void saveMeeting(input)}
          />}
          {readReceiptsMessage && <MessageReadReceiptsDialog
            messageText={readReceiptsMessage.text}
            readBy={readReceiptsFor(readReceiptsMessage)}
            onClose={() => setReadReceiptsMessageId(null)}
          />}
        </motion.aside>
      )}
          <TeamCallOverlay
            key="team-call-overlay"
            snapshot={call}
            commands={callCommands}
            members={members}
            currentUserId={session.user.id}
            attachmentToken={session.token}
            onReplyIncoming={() => {
              const thread = call.incoming?.thread;
              if (!thread) return;
              const id = thread.scope === "team" ? "team" : thread.scope === "subteam" ? `subteam:${thread.subteamId}` : `direct:${[session.user.id, thread.recipientId].sort().join(":")}`;
              const destinationText = selectedThreadRef.current === id ? draftRef.current.text : drafts.current.get(id)?.text;
              selectConversation(thread);
              if (!destinationText) setText("Não consigo entrar agora. Podemos conversar por aqui?");
              onOpen?.();
            }}
            onDownloadAttachment={(attachment) => { void downloadWithAuth(attachment.url, attachment.name, session.token); }}
          />
    </AnimatePresence>
  );
}
