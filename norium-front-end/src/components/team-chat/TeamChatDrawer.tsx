import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, AtSign, CalendarDays, CalendarPlus, CheckCheck, Download, FileText, FolderOpen, Hash, ImageIcon, Images, Paperclip, Phone, PlayCircle, Send, Settings2, MessageSquare, PanelRight, Pin, PinOff, Users, UserRound, Video, Volume2, X } from "lucide-react";
import { canUse, type AuthSession, type NoriumUser } from "../../types/auth";
import { apiBaseUrl, authToken } from "../../utils/api";
import { downloadWithAuth } from "../../utils/download";
import TeamConversationList from "./TeamConversationList";
import { mentionParts, mentionQuery, type TeamConversation } from "./teamChatConversations";
import "./teamChat.css";
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

type TeamMessage = {
  id: string;
  threadId: string;
  scope: TeamThreadScope;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  recipientId?: string | null;
  subteamId?: string | null;
  text: string;
  attachments: Attachment[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type Subteam = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type TeamChatDrawerProps = {
  open: boolean;
  onClose: () => void;
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
    if (message.senderId === "nora") return <NoraMarkdown text={message.text} />;
    const parts = mentionParts(message.text, message.metadata?.mentions);
    return (
      <p className="whitespace-pre-wrap leading-5">
        {parts.map((part, index) =>
          index % 2 === 1 ? (
            <span key={`${part}-${index}`} className="team-chat-mention-token">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </p>
    );
  }

  return (
    <div className="space-y-2 leading-5">
      <div className="rounded-xl border border-white/10 bg-white/10 p-3">
        <p className="text-xs font-bold uppercase tracking-wide opacity-75">{parsed.eyebrow}</p>
        <p className="mt-1 text-sm font-bold">{parsed.title}</p>
        {parsed.subtitle && <p className="mt-1 text-xs font-bold opacity-80">{parsed.subtitle}</p>}
      </div>

      {parsed.changes.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/10 p-3">
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
            <div key={`${detail.label}-${detail.value}`} className="rounded-lg border border-white/10 bg-white/[0.08] px-2 py-1.5">
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

function MessageAvatar({ name, avatar }: { name: string; avatar?: string }) {
  const [failed, setFailed] = useState(false);
  if (avatar === "nora") return <NoraAvatar className="h-9 w-9 shrink-0" />;
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] text-xs font-bold text-[var(--text)]">
      {avatar && !failed ? (
        <img src={avatar} alt={name} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}

function useAttachmentObjectUrl(attachment: Attachment | null, token?: string) {
  const [objectUrl, setObjectUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    let nextUrl = "";
    setObjectUrl("");
    if (!attachment || !canPreviewAttachment(attachment)) return undefined;

    fetch(attachment.url, { headers: authHeaders(undefined, token) })
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
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [attachment, token]);

  return objectUrl;
}

function TeamAttachmentCard({ attachment, onPreview, token }: { attachment: Attachment; onPreview: (attachment: Attachment) => void; token: string }) {
  const objectUrl = useAttachmentObjectUrl(attachment, token);
  const previewable = canPreviewAttachment(attachment);
  const Icon = isImageAttachment(attachment) ? ImageIcon : isVideoAttachment(attachment) ? PlayCircle : isAudioAttachment(attachment) ? Volume2 : FileText;

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/12 text-xs font-bold">
      <button
        type="button"
        onClick={() => (previewable ? onPreview(attachment) : void downloadWithAuth(attachment.url, attachment.name, token))}
        className="block w-full text-left"
      >
        {isImageAttachment(attachment) && objectUrl ? (
          <img src={objectUrl} alt={attachment.name} className="h-28 w-full object-cover" />
        ) : isVideoAttachment(attachment) && objectUrl ? (
          <video src={objectUrl} className="h-28 w-full bg-black object-cover" muted />
        ) : isAudioAttachment(attachment) && objectUrl ? (
          <div className="p-2">
            <audio src={objectUrl} controls className="w-full" />
          </div>
        ) : (
          <div className="flex min-h-16 items-center gap-2 px-3 py-2">
            <Icon size={16} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{attachment.name}</span>
              <span className="block text-xs opacity-70">{formatBytes(attachment.size)}</span>
            </span>
          </div>
        )}
      </button>
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
            <audio src={objectUrl} controls className="w-full" />
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
          <div><p className="text-xs font-bold uppercase tracking-wide text-blue-400">Comunidade interna</p><h2 className="mt-1 text-xl font-black">{editing ? "Editar subequipe" : "Nova subequipe"}</h2></div>
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

export default function TeamChatDrawer({ open, onClose, session, onUnread, onOpenCalendar, variant = "drawer", initialThreadId, onInitialThreadHandled }: TeamChatDrawerProps) {
  const [members, setMembers] = useState<NoriumUser[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [subteams, setSubteams] = useState<Subteam[]>([]);
  const [conversationSelected, setConversationSelected] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [threads, setThreads] = useState<TeamConversation[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [pinningId, setPinningId] = useState("");
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [scope, setScope] = useState<TeamThreadScope>("team");
  const [recipientId, setRecipientId] = useState("");
  const [subteamId, setSubteamId] = useState("");
  const [contentTab, setContentTab] = useState<"chat" | "files" | "photos">("chat");
  const [subteamEditor, setSubteamEditor] = useState<Subteam | "new" | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [meetingSchedulerOpen, setMeetingSchedulerOpen] = useState(false);
  const [meetingSaving, setMeetingSaving] = useState(false);
  const [readReceiptsMessageId, setReadReceiptsMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [subteamSaving, setSubteamSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastScrolledThreadRef = useRef("");
  const handledIncomingCallRef = useRef("");
  const markedMessageIdsRef = useRef<Set<string>>(new Set());

  const selectedThreadId = !conversationSelected ? "" : scope === "team" ? "team" : scope === "subteam" ? `subteam:${subteamId}` : `direct:${[session.user.id, recipientId].sort().join(":")}`;
  const selectedThreadRef = useRef(selectedThreadId);
  selectedThreadRef.current = selectedThreadId;
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
    const draft = drafts.current.get(nextId);
    setText(draft?.text || "");
    setFiles(draft?.files || []);
    setMentionedUserIds(draft?.mentionedUserIds || []);
    setMessages([]);
    setError("");
    setLoading(Boolean(next));
    setContentTab("chat");
    setDetailsOpen(false);
    setMentionDismissed(true);
  }, [session.user.id]);
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
    if (scope === "team" && canUse(session.user, "nora") && "nora".includes(query)) options.push({ id: "nora", name: "nora", avatar: "nora" });
    return options.slice(0, 8);
  }, [mentionMatch, mentionDismissed, conversationMembers, scope, session.user]);
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
    const params = new URLSearchParams({ scope });
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
      const messagesUrl = scope === "subteam" ? `${API_URL}/subteams/${subteamId}/messages` : `${API_URL}/messages?${params.toString()}`;
      const response = await fetch(messagesUrl, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao carregar chat interno.");
      if (!isCurrent()) return;
      const loadedMessages = (data.messages || []) as TeamMessage[];
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
    const handlers = socketHandlersRef.current;
    if (payload.type === "PRESENCE" || payload.type === "CONNECTED") setOnlineUserIds(payload.onlineUserIds || []);
    if (payload.type === "SUBTEAM_UPDATED") {
      void handlers.loadSubteams();
      void handlers.loadThreads();
    }
    if (payload.type === "TEAM_THREADS_UPDATED" || payload.type === "CONNECTED") void handlers.loadThreads();
    if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) {
      const message = payload.message as TeamMessage;
      void handlers.loadThreads();
      if (handlers.selectedThreadId && message.threadId === handlers.selectedThreadId) {
        setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
        if (handlers.open) void handlers.markMessagesRead([message]);
      } else if (handlers.open && !["call_started", "call_ended"].includes(String(message.metadata?.action || ""))) handlers.onUnread?.(1);
    }
    if (payload.type === "TEAM_MESSAGE_READ" && payload.messageId) {
      const readBy = payload.readBy && typeof payload.readBy === "object" ? payload.readBy : {};
      setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, metadata: { ...(message.metadata || {}), readBy } } : message));
    }
  });

  useEffect(() => {
    if (!open || loading || !selectedThreadId) return undefined;
    const threadKey = scope === "team" ? "team" : scope === "subteam" ? `subteam:${subteamId}` : `direct:${recipientId}`;
    const initialForThread = lastScrolledThreadRef.current !== threadKey;
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      list.scrollTo({ top: list.scrollHeight, behavior: initialForThread ? "auto" : "smooth" });
      lastScrolledThreadRef.current = threadKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, messages.length, open, recipientId, scope, subteamId, selectedThreadId]);

  async function sendMessage(overrideText?: string, overrideFiles?: File[]) {
    const outgoingThreadId = selectedThreadRef.current;
    if (!outgoingThreadId) return;
    const outgoingText = overrideText ?? text;
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
        } : {
          scope: outgoingScope,
          recipientId: outgoingRecipientId,
          text: outgoingText,
          mentionedUserIds: overrideText === undefined ? mentionedUserIds : [],
          attachments,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao enviar mensagem.");
      if (selectedThreadRef.current === outgoingThreadId) {
        setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
        if (overrideText === undefined && overrideFiles === undefined && draftRef.current.text === outgoingText && draftRef.current.files === outgoingFiles) {
          setText(""); setFiles([]); setMentionedUserIds([]);
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
          initial={variant === "drawer" ? { x: 420, opacity: 0 } : { opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={variant === "drawer" ? { x: 420, opacity: 0 } : { opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          className={variant === "drawer"
            ? `team-chat-drawer team-chat-professional ${conversationSelected ? "has-conversation" : "no-conversation"} fixed right-4 top-20 z-[95] flex h-[min(760px,calc(100dvh-104px))] w-[390px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] text-[var(--text)] shadow-2xl shadow-black/50 backdrop-blur-2xl`
            : `team-chat-drawer team-chat-page team-chat-professional ${conversationSelected ? "has-conversation" : "no-conversation"} ${detailsOpen ? "with-details" : ""} mx-4 mb-4 mt-3 min-h-0 overflow-hidden rounded-lg border border-[var(--border)] text-[var(--text)]`
          }
        >
          <header className="team-chat-header">
            <div className="team-chat-heading"><span className="team-chat-heading-icon"><MessageSquare size={20} /></span><div><h1>Chat da equipe</h1><p><i />{actualOnlineUserIds.length} online · Colabore em tempo real</p></div></div>
            <div className="team-chat-header-actions">{onOpenCalendar && <Button variant="ghost" size="sm" iconOnly onClick={onOpenCalendar} aria-label="Abrir calendário" title="Abrir calendário"><CalendarDays size={17} /></Button>}{variant === "drawer" ? <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar chat"><X size={18} /></Button> : <Button variant="secondary" size="sm" onClick={onClose} icon={<Users size={15} />}>Equipe</Button>}</div>
          </header>
          {!conversationSelected && error && <div role="alert" className="team-chat-feedback px-4 py-2 text-xs">{error}</div>}
          <div className="team-chat-body">
          <TeamConversationList items={conversationItems} selectedId={selectedThreadId} loading={threadsLoading} pinningId={pinningId} onSelect={selectConversation} onPin={(item) => void togglePin(item)} onCreate={() => setSubteamEditor("new")} />
          {!conversationSelected ? <main className="team-chat-unselected"><div className="team-chat-welcome-icon"><MessageSquare size={32} /></div><h2>Uma equipe. Boas conversas.</h2><p>Selecione uma conversa para trocar mensagens,<br />compartilhar arquivos e tomar decisões em equipe.</p><div className="team-chat-welcome-hints"><span><Pin size={15} /> Fixe as mais importantes</span><span><AtSign size={16} /> Mencione e notifique pessoas</span></div><Button variant="primary" size="md" onClick={() => selectConversation({ scope: "team" })} icon={<Users size={16} />}>Conversar com o time</Button></main> : <main className="team-chat-conversation">
          <div className="team-chat-thread-header"><div className="team-chat-thread-title"><button type="button" className="team-icon-button team-chat-back" onClick={() => selectConversation(null)} aria-label="Voltar às conversas"><ArrowLeft size={18} /></button><span className="team-chat-thread-icon">{scope === "team" ? <Users size={19} /> : scope === "subteam" ? <Hash size={19} /> : <UserRound size={19} />}</span><div><h2>{threadTitle}</h2><p>{scope === "direct" ? conversationOnlineCount > 1 ? "Online agora" : "Conversa privada" : `${conversationMemberCount} participantes · ${conversationOnlineCount} online`}</p></div></div><div className="team-chat-thread-actions">
            {selectedConversation && <button type="button" className={`team-icon-button ${selectedConversation.pinned ? "is-pinned" : ""}`} disabled={Boolean(pinningId)} onClick={() => void togglePin(selectedConversation)} aria-label={selectedConversation.pinned ? "Desafixar conversa atual" : "Fixar conversa atual"} title={selectedConversation.pinned ? "Desafixar conversa" : "Fixar conversa"}>{selectedConversation.pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
            <button type="button" className="team-icon-button" onClick={() => setMeetingSchedulerOpen(true)} disabled={!canStartCall} aria-label="Agendar reunião" title="Agendar reunião"><CalendarPlus size={17} /></button>
            <button type="button" className="team-icon-button team-call-action" disabled={!canStartCall} onClick={() => void startOrJoinCall()} aria-label={activeMeeting ? "Ingressar na reunião" : "Iniciar reunião"} title="Reunião por vídeo"><Video size={18} /></button>
            <button type="button" className="team-icon-button" onClick={() => setDetailsOpen((current) => !current)} aria-label="Detalhes da conversa" aria-expanded={detailsOpen} title="Detalhes da conversa"><PanelRight size={17} /></button>
            <button type="button" className="team-icon-button team-chat-deselect" onClick={() => selectConversation(null)} aria-label="Fechar conversa" title="Fechar conversa"><X size={18} /></button>
          </div></div>
          <nav className="team-chat-tabs flex items-end gap-5 border-b border-[var(--border)] px-4">
            <button type="button" aria-pressed={contentTab === "chat"} onClick={() => setContentTab("chat")} className={contentTab === "chat" ? "active" : ""}>Chat</button>
            <button type="button" aria-pressed={contentTab === "files"} onClick={() => setContentTab("files")} className={contentTab === "files" ? "active" : ""}>Arquivos <span>{threadAttachments.length}</span></button>
            <button type="button" aria-pressed={contentTab === "photos"} onClick={() => setContentTab("photos")} className={contentTab === "photos" ? "active" : ""}>Fotos <span>{photoAttachments.length}</span></button>
          </nav>

          {activeMeeting && <div className="shrink-0 border-b border-[var(--border)] px-4 py-3"><TeamActiveCallCard meeting={activeMeeting} busy={call.busy || Boolean(call.active)} joined={call.active?.callId === activeMeeting.callId} onJoin={() => void callCommands.join(activeMeeting)} /></div>}
          <div ref={listRef} className="team-chat-list min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {loading && <p className="text-center text-xs font-bold text-[var(--text-secondary)]">Carregando conversa...</p>}
            {contentTab === "chat" && !loading && messages.length === 0 && !activeMeeting && (
              <div className="grid h-full place-items-center text-center text-[var(--text-secondary)]">
                <div>
                  <UserRound className="mx-auto mb-3" size={34} />
                  <p className="text-sm font-bold">Nenhuma mensagem ainda.</p>
                </div>
              </div>
            )}
            {contentTab === "chat" && !loading && messages.map((message) => {
              const mine = message.senderId === session.user.id;
              const member = memberById.get(message.senderId);
              const senderAvatar = message.senderAvatar || member?.fotoUrl || (message.senderId === "nora" ? "nora" : "");
              const isNora = message.senderId === "nora";
              const readReceipts = mine ? readReceiptsFor(message) : [];
              return (
                <div key={message.id} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
                  {!mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} />}
                  <div className={`team-chat-message ${isNora ? "team-chat-message-nora max-w-[94%]" : "max-w-[78%]"} ${Array.isArray(message.metadata?.mentionedUserIds) && message.metadata.mentionedUserIds.includes(session.user.id) ? "mentions-me" : ""} rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "team-chat-message-mine" : "team-chat-message-other"}`}>
                    <div className={`mb-1 flex items-center justify-between gap-3 text-xs font-bold ${mine ? "team-chat-message-meta-mine" : "team-chat-message-meta-other"}`}>
                      <span className="min-w-0 truncate">{message.senderName}</span>
                      <span className="shrink-0 text-right">{formatMessageDateTime(message.createdAt)}</span>
                    </div>
                    {message.text && <NoraMessageContent message={message} />}
                    {message.metadata?.action === "meeting_scheduled" && <TeamMeetingMessageCard metadata={message.metadata} currentUserId={session.user.id} onAddToCalendar={addMeetingToCalendar} onStart={() => void startCall()} />}
                    {message.attachments?.length > 0 && (
                      <div className="mt-2 grid gap-2">
                        {message.attachments.map((attachment) => (
                          <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />
                        ))}
                      </div>
                    )}
                    {mine && <button type="button" onClick={() => setReadReceiptsMessageId(message.id)} className="mt-2 flex items-center gap-1 text-[11px] font-bold text-blue-100/75 transition hover:text-white" aria-label={`Ver confirmações de leitura: ${readReceipts.length} pessoa(s) viram`}><CheckCheck size={14} /> {readReceipts.length ? `${readReceipts.length} viram` : "Ninguém viu ainda"}</button>}
                  </div>
                  {mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} />}
                </div>
              );
            })}
            {contentTab === "files" && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {threadAttachments.map((attachment) => <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />)}
                {!threadAttachments.length && <div className="col-span-full grid min-h-72 place-items-center text-center text-[var(--text-secondary)]"><div><FolderOpen className="mx-auto" size={38} /><p className="mt-3 text-sm font-bold">Nenhum arquivo nesta conversa.</p></div></div>}
              </div>
            )}
            {contentTab === "photos" && (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {photoAttachments.map((attachment) => <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />)}
                {!photoAttachments.length && <div className="col-span-full grid min-h-72 place-items-center text-center text-[var(--text-secondary)]"><div><Images className="mx-auto" size={38} /><p className="mt-3 text-sm font-bold">Nenhuma foto nesta conversa.</p></div></div>}
              </div>
            )}
          </div>

          {contentTab === "chat" && files.length > 0 && (
            <div className="team-chat-pending-files flex gap-2 overflow-x-auto border-t border-[var(--border)] px-3 py-2">
              {files.map((file) => (
                <PendingFilePreview key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles((current) => current.filter((item) => item !== file))} />
              ))}
            </div>
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
            <div className="team-chat-composer">
            <textarea ref={inputRef} value={text} rows={2} maxLength={2000} aria-label="Mensagem para a conversa" aria-autocomplete="list" aria-controls={showMentionSuggestions ? "team-mention-options" : undefined} aria-activedescendant={showMentionSuggestions ? `team-mention-${Math.min(mentionIndex, mentionOptions.length - 1)}` : undefined}
              onChange={(event) => { setText(event.target.value); setCursor(event.target.selectionStart); setMentionDismissed(false); setMentionIndex(0); }}
              onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (showMentionSuggestions && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length); return; }
                if (showMentionSuggestions && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); selectMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)]); return; }
                if (showMentionSuggestions && event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); return; }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
              }} placeholder={`Mensagem para ${threadTitle}. Use @ para mencionar.`} className="team-chat-input" />
            <div className="team-chat-composer-actions"><div>
              <label className="team-icon-button" aria-label="Anexar imagem ou arquivo" title="Anexar imagem ou arquivo"><Paperclip size={18} /><input type="file" multiple className="sr-only" aria-label="Anexar arquivos" onChange={(event) => { const next = [...files, ...Array.from(event.target.files || [])]; if (next.length > 8) setError("Envie até 8 arquivos por mensagem."); else setFiles(next); event.currentTarget.value = ""; }} /></label>
              <button type="button" className="team-icon-button" aria-label="Mencionar membro" title="Mencionar membro" onClick={() => { const pos = inputRef.current?.selectionStart ?? text.length; const prefix = pos > 0 && !/\s/.test(text[pos - 1]) ? " @" : "@"; setText(text.slice(0, pos) + prefix + text.slice(pos)); setCursor(pos + prefix.length); setMentionIndex(0); setMentionDismissed(false); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos + prefix.length, pos + prefix.length); }); }}><AtSign size={18} /></button>
            </div><Button variant="primary" size="sm" onClick={() => void sendMessage()} disabled={sending || (!text.trim() && !files.length)} icon={<Send size={15} />} className="team-chat-send">{sending ? "Enviando..." : "Enviar"}</Button></div>
            </div><p className="team-chat-composer-hint"><span>Enter envia · Shift + Enter quebra a linha</span><span>{text.length}/2000</span></p>
          </footer>}
          </main>}
          {conversationSelected && detailsOpen && (
            <aside className="team-chat-context border-l border-[var(--border)] p-4">
              <div className="team-chat-details-heading"><p>Detalhes da conversa</p><button type="button" className="team-icon-button" onClick={() => setDetailsOpen(false)} aria-label="Fechar detalhes"><X size={16} /></button></div>
              <div className="mt-2 flex items-start justify-between gap-2"><h2 className="text-lg font-black">{threadTitle}</h2>{scope === "subteam" && selectedSubteam && (selectedSubteam.createdBy === session.user.id || session.user.id === (session.user.teamOwnerId || session.user.id) || session.user.systemAdmin) && <Button variant="ghost" size="sm" iconOnly onClick={() => setSubteamEditor(selectedSubteam)} aria-label="Editar subequipe"><Settings2 size={15} /></Button>}</div>
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
              {scope === "team" && canUse(session.user, "nora") && (
                <section className="mt-5 rounded-lg border border-cyan-400/25 bg-cyan-400/8 p-4">
                  <div className="flex items-center gap-3">
                    <NoraAvatar className="h-10 w-10" />
                    <div><strong className="block text-sm">Nora na conversa</strong><small className="text-[var(--text-secondary)]">Ativa quando mencionada</small></div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void sendMessage("@nora Resuma a conversa recente, destaque decisoes, responsaveis e proximos passos usando somente o historico deste chat.")}
                    disabled={sending}
                    className="mt-3 flex h-10 w-full items-center justify-center rounded-lg border border-cyan-400/25 text-xs font-bold text-cyan-200 hover:bg-cyan-400/10"
                  >
                    {sending ? "Enviando para a Nora..." : "Resumir conversa com a Nora"}
                  </button>
                </section>
              )}
              <div className="mt-5">
                <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">Membros</p>
                <div className="mt-3 space-y-2">
                  {conversationMembers.map((member) => (
                    <div key={member.id} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 hover:bg-[var(--surface-hover)]">
                      <button type="button" onClick={() => setSelectedMemberId(member.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Ver presença e último acesso de ${member.nome}`}>
                        <MessageAvatar name={member.nome} avatar={member.fotoUrl || ""} />
                        <span className="min-w-0 flex-1"><strong className="block truncate text-xs">{member.nome}</strong><small className={actualOnlineUserIdSet.has(member.id) ? "text-emerald-300" : "text-[var(--text-secondary)]"}>{actualOnlineUserIdSet.has(member.id) ? "Online agora" : "Offline"}</small></span>
                      </button>
                      {member.id !== session.user.id && <button type="button" onClick={() => { selectConversation({ scope: "direct", recipientId: member.id }); void startCall({ scope: "direct", title: member.nome, recipientId: member.id, subteamId: null }); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--primary)] hover:bg-[var(--surface)]" aria-label={`Ligar individualmente para ${member.nome}`}><Phone size={15} /></button>}
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          )}
          </div>
          {previewAttachment && <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} token={session.token} />}
          {subteamEditor && <SubteamEditorDialog value={subteamEditor} members={members} currentUserId={session.user.id} saving={subteamSaving} onClose={() => setSubteamEditor(null)} onSave={(input) => void saveSubteam(input)} />}
          {selectedMember && <TeamMemberPresenceDialog
            member={selectedMember}
            online={actualOnlineUserIdSet.has(selectedMember.id)}
            isCurrentUser={selectedMember.id === session.user.id}
            onClose={() => setSelectedMemberId(null)}
            onMessage={() => { selectConversation({ scope: "direct", recipientId: selectedMember.id }); setSelectedMemberId(null); }}
            onCall={() => { selectConversation({ scope: "direct", recipientId: selectedMember.id }); setSelectedMemberId(null); void startCall({ scope: "direct", title: selectedMember.nome, recipientId: selectedMember.id, subteamId: null }); }}
          />}
          {meetingSchedulerOpen && <TeamMeetingSchedulerDialog
            scopeLabel={threadTitle}
            members={conversationMembers}
            currentUserId={session.user.id}
            saving={meetingSaving}
            onClose={() => setMeetingSchedulerOpen(false)}
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
            snapshot={call}
            commands={callCommands}
            members={members}
            currentUserId={session.user.id}
            attachmentToken={session.token}
            onDownloadAttachment={(attachment) => { void downloadWithAuth(attachment.url, attachment.name, session.token); }}
          />
    </AnimatePresence>
  );
}
