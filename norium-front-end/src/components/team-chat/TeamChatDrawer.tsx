import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, FileText, ImageIcon, Paperclip, PlayCircle, Send, Users, UserRound, Volume2, X } from "lucide-react";
import { canUse, type AuthSession, type NoriumUser } from "../../types/auth";
import { apiBaseUrl, authToken, wsBaseUrl } from "../../utils/api";
import { downloadWithAuth } from "../../utils/download";
import NoraAvatar from "../layout/NoraAvatar";

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
};

type TeamMessage = {
  id: string;
  threadId: string;
  scope: "team" | "direct";
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  recipientId?: string | null;
  text: string;
  attachments: Attachment[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type TeamChatDrawerProps = {
  open: boolean;
  onClose: () => void;
  session: AuthSession;
  onUnread?: (count: number) => void;
};

const API_URL = `${apiBaseUrl()}/api/team-chat`;
const WS_URL = `${wsBaseUrl()}/api/team-chat/ws`;
const NORA_MENTION_AT_END = /(^|\s)@(n(?:o(?:r(?:a)?)?)?)?$/i;

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
    const parts = message.text.split(/(@nora\b)/gi);
    return (
      <p className="whitespace-pre-wrap leading-5">
        {parts.map((part, index) =>
          /^@nora$/i.test(part) ? (
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
        <p className="text-[10px] font-black uppercase tracking-wide opacity-75">{parsed.eyebrow}</p>
        <p className="mt-1 text-sm font-black">{parsed.title}</p>
        {parsed.subtitle && <p className="mt-1 text-xs font-bold opacity-80">{parsed.subtitle}</p>}
      </div>

      {parsed.changes.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/10 p-3">
          <p className="text-[10px] font-black uppercase tracking-wide opacity-70">Alteracoes</p>
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
              <p className="text-[10px] font-black uppercase opacity-60">{detail.label}</p>
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
    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] text-xs font-black text-[var(--text)]">
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
              <span className="block text-[10px] opacity-70">{formatBytes(attachment.size)}</span>
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
            <p className="truncate text-sm font-black text-[var(--text)]">{attachment.name}</p>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">{attachment.mimeType} · {formatBytes(attachment.size)}</p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-[var(--surface-hover)]">
            <X size={18} />
          </button>
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
            <span className="text-[10px] opacity-70">clique para remover</span>
          </span>
        </span>
      )}
    </button>
  );
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function TeamChatDrawer({ open, onClose, session, onUnread }: TeamChatDrawerProps) {
  const [members, setMembers] = useState<NoriumUser[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [scope, setScope] = useState<"team" | "direct">("team");
  const [recipientId, setRecipientId] = useState("");
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recipientOptions = useMemo(
    () => members.filter((member) => member.id !== session.user.id && member.status === "ativo"),
    [members, session.user.id],
  );
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const mentionMatch = useMemo(() => text.match(NORA_MENTION_AT_END), [text]);
  const showNoraSuggestion =
    scope === "team" &&
    canUse(session.user, "nora") &&
    !mentionDismissed &&
    Boolean(mentionMatch);

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

  const loadMessages = useCallback(async () => {
    const params = new URLSearchParams({ scope });
    if (scope === "direct" && recipientId) params.set("recipientId", recipientId);
    if (scope === "direct" && !recipientId) {
      setMessages([]);
      return;
    }
      setLoading(true);
    try {
      const response = await fetch(`${API_URL}/messages?${params.toString()}`, { headers: authHeaders(undefined, session.token) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao carregar chat interno.");
      setMessages(data.messages || []);
      setError("");
      onUnread?.(0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Falha ao carregar chat interno.");
    } finally {
      setLoading(false);
    }
  }, [onUnread, recipientId, scope, session.token]);

  useEffect(() => {
    if (!open) return;
    void loadMembers();
  }, [loadMembers, open]);

  useEffect(() => {
    if (!open) return;
    void loadMessages();
  }, [loadMessages, open]);

  useEffect(() => {
    if (!open) return;
    const token = session.token || authToken();
    if (!token) return;
    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data || "{}"));
      if (payload.type === "PRESENCE") {
        setOnlineUserIds(payload.onlineUserIds || []);
      }
      if (payload.type === "TEAM_CHAT_MESSAGE" && payload.message) {
        const message = payload.message as TeamMessage;
        const expectedThread = scope === "team" ? "team" : `direct:${[session.user.id, recipientId].sort().join(":")}`;
        if (message.threadId === expectedThread) {
          setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
        } else {
          onUnread?.(1);
        }
      }
    };
    return () => socket.close();
  }, [onUnread, open, recipientId, scope, session.token, session.user.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, open]);

  async function sendMessage() {
    if ((!text.trim() && files.length === 0) || sending) return;
    setSending(true);
    setError("");
    try {
      const attachments = await Promise.all(
        files.map(async (file) => ({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          dataUrl: await fileToDataUrl(file),
        })),
      );
      const response = await fetch(`${API_URL}/messages`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }, session.token),
        body: JSON.stringify({ scope, recipientId: scope === "direct" ? recipientId : null, text, attachments }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Falha ao enviar mensagem.");
      setMessages((current) => [...current.filter((item) => item.id !== data.message.id), data.message]);
      setText("");
      setFiles([]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Falha ao enviar mensagem.");
    } finally {
      setSending(false);
    }
  }

  function selectNoraMention() {
    const match = text.match(NORA_MENTION_AT_END);
    if (!match || typeof match.index !== "number") return;
    const leadingSpace = match[1] || "";
    const mentionStart = match.index + leadingSpace.length;
    const nextText = `${text.slice(0, mentionStart)}@nora `;
    setText(nextText);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextText.length, nextText.length);
    });
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 420, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 420, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          className="team-chat-drawer fixed right-4 top-20 z-[95] flex h-[min(760px,calc(100dvh-104px))] w-[390px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] text-[var(--text)] shadow-2xl shadow-black/50 backdrop-blur-2xl"
        >
          <header className="team-chat-header flex h-16 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="team-chat-header-icon grid h-9 w-9 shrink-0 place-items-center rounded-lg">
                <Users size={17} />
              </span>
              <span className="min-w-0">
                <p className="truncate text-sm font-black">Chat da equipe</p>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{onlineUserIds.length} online agora</p>
              </span>
            </div>
            <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-[var(--surface-hover)]">
              <X size={18} />
            </button>
          </header>

          <div className="grid grid-cols-2 gap-2 border-b border-[var(--border)] p-3">
            <button onClick={() => setScope("team")} className={`h-10 rounded-xl text-xs font-black transition ${scope === "team" ? "team-chat-primary-control" : "team-chat-secondary-control"}`}>
              <Users size={15} className="mr-2 inline" /> Time todo
            </button>
            <select
              value={scope === "direct" ? recipientId : ""}
              onChange={(event) => {
                setScope("direct");
                setRecipientId(event.target.value);
              }}
              className="team-chat-select h-10 rounded-xl border border-[var(--border)] px-3 text-xs font-bold outline-none"
            >
              <option value="">Mensagem direta</option>
              {recipientOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="border-b border-[var(--border)] px-3 py-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {members.map((member) => (
                <span key={member.id} className="team-chat-member-chip flex shrink-0 items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 text-xs font-bold">
                  <span className={`h-2 w-2 rounded-full ${onlineUserIds.includes(member.id) ? "bg-emerald-400" : "bg-slate-400"}`} />
                  {member.nome}
                </span>
              ))}
            </div>
          </div>

          <div ref={listRef} className="team-chat-list min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {loading && <p className="text-center text-xs font-bold text-[var(--text-secondary)]">Carregando conversa...</p>}
            {!loading && messages.length === 0 && (
              <div className="grid h-full place-items-center text-center text-[var(--text-secondary)]">
                <div>
                  <UserRound className="mx-auto mb-3" size={34} />
                  <p className="text-sm font-bold">Nenhuma mensagem ainda.</p>
                </div>
              </div>
            )}
            {messages.map((message) => {
              const mine = message.senderId === session.user.id;
              const member = memberById.get(message.senderId);
              const senderAvatar = message.senderAvatar || member?.fotoUrl || (message.senderId === "nora" ? "nora" : "");
              const isNora = message.senderId === "nora";
              return (
                <div key={message.id} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
                  {!mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} />}
                  <div className={`team-chat-message ${isNora ? "max-w-[86%]" : "max-w-[78%]"} rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "team-chat-message-mine" : "team-chat-message-other"}`}>
                    <div className={`mb-1 flex items-center justify-between gap-3 text-[11px] font-bold ${mine ? "team-chat-message-meta-mine" : "team-chat-message-meta-other"}`}>
                      <span className="min-w-0 truncate">{message.senderName}</span>
                      <span className="shrink-0 text-right">{formatMessageDateTime(message.createdAt)}</span>
                    </div>
                    {message.text && <NoraMessageContent message={message} />}
                    {message.attachments?.length > 0 && (
                      <div className="mt-2 grid gap-2">
                        {message.attachments.map((attachment) => (
                          <TeamAttachmentCard key={attachment.id} attachment={attachment} onPreview={setPreviewAttachment} token={session.token} />
                        ))}
                      </div>
                    )}
                  </div>
                  {mine && <MessageAvatar name={message.senderName} avatar={senderAvatar} />}
                </div>
              );
            })}
          </div>

          {files.length > 0 && (
            <div className="flex gap-2 overflow-x-auto border-t border-[var(--border)] px-3 py-2">
              {files.map((file) => (
                <PendingFilePreview key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles((current) => current.filter((item) => item !== file))} />
              ))}
            </div>
          )}

          <AnimatePresence>
            {showNoraSuggestion && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="team-chat-mention-panel shrink-0 border-t border-[var(--border)] px-3 pt-2"
              >
                <button
                  type="button"
                  onClick={selectNoraMention}
                  className="team-chat-mention-suggestion flex w-full items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-left"
                >
                  <NoraAvatar className="h-9 w-9 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black">Nora</span>
                    <span className="block truncate text-xs font-semibold text-[var(--text-secondary)]">
                      Mencionar para responder com o contexto da conversa
                    </span>
                  </span>
                  <span className="team-chat-mention-handle rounded-lg px-2 py-1 text-xs font-black">@nora</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div className="mx-3 mt-2 shrink-0 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
              {error}
            </div>
          )}

          <footer className="team-chat-footer flex shrink-0 items-center gap-2 border-t border-[var(--border)] p-3">
            <label className="team-chat-secondary-control grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-xl border border-[var(--border)]">
              <Paperclip size={18} />
              <input type="file" multiple className="hidden" onChange={(event) => setFiles(Array.from(event.target.files || []))} />
            </label>
            <input
              ref={inputRef}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setMentionDismissed(false);
              }}
              onKeyDown={(event) => {
                if (showNoraSuggestion && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  selectNoraMention();
                  return;
                }
                if (showNoraSuggestion && event.key === "Escape") {
                  event.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={scope === "team" && canUse(session.user, "nora") ? "Mensagem interna... Use @nora para chamar" : "Mensagem interna..."}
              className="team-chat-input h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold outline-none"
            />
            <button
              onClick={() => void sendMessage()}
              disabled={sending}
              className="team-chat-send grid h-11 w-11 shrink-0 place-items-center rounded-xl disabled:cursor-wait disabled:opacity-60"
            >
              <Send size={18} />
            </button>
          </footer>
          {previewAttachment && <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} token={session.token} />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
