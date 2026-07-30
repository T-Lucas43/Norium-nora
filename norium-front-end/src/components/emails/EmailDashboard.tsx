import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileText,
  Filter,
  Folder,
  Image,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  MailOpen,
  Maximize2,
  Menu,
  Minimize2,
  MoreVertical,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import BrandLogo from "../layout/BrandLogo";
import type { LucideIcon } from "lucide-react";
import { downloadWithAuth } from "../../utils/download";
import { mailApiRequest as apiJson } from "../../features/mail/api";
import type {
  AgentMessage,
  ComposeAttachment,
  ComposeState,
  GmailLabel,
  GmailMessage,
  GmailStatus,
  MessageListResponse,
  NoraEmailSuggestion,
} from "../../features/mail/types";
import Button from "../shared/Button";
export type { Email } from "../../features/mail/types";

const GMAIL_PAGE_SIZE = 14;

const emptyCompose: ComposeState = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  attachments: [],
};

const systemFolders: Array<{ key: string; label: string; icon: LucideIcon; countLabel?: string }> = [
  { key: "inbox", label: "Caixa de entrada", icon: Inbox, countLabel: "INBOX" },
  { key: "drafts", label: "Rascunhos", icon: FileText, countLabel: "DRAFT" },
  { key: "scheduled", label: "Agendado", icon: Clock3 },
  { key: "sent", label: "Enviado", icon: Send, countLabel: "SENT" },
  { key: "spam", label: "Spam", icon: ShieldAlert, countLabel: "SPAM" },
  { key: "trash", label: "Lixo", icon: Trash2, countLabel: "TRASH" },
];

const quickFilters = [
  { key: "all", label: "Todo o correio" },
  { key: "unread", label: "Nao lidos" },
  { key: "read", label: "Ler" },
  { key: "starred", label: "Com estrela" },
] as const;

type MailQuickFilter = (typeof quickFilters)[number]["key"];

type MailboxSnapshot = {
  messages: GmailMessage[];
  nextPageToken: string | null;
  resultSize: number;
  cachedAt: number;
};

const mailboxSessionCache = new Map<string, MailboxSnapshot>();

function resolveMailboxFolder(folder: string, filter: MailQuickFilter) {
  return filter === "unread" || filter === "starred" ? filter : folder;
}

function mailboxCacheKey(userId: string, folder: string, filter: MailQuickFilter, query: string) {
  return `${userId}::${resolveMailboxFolder(folder, filter)}::${filter}::${query.trim()}`;
}

function clearMailboxCacheForUser(userId: string) {
  const prefix = `${userId}::`;
  for (const key of mailboxSessionCache.keys()) {
    if (key.startsWith(prefix)) mailboxSessionCache.delete(key);
  }
}

function buildMessagesPath({
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

type AdvancedMailFilters = {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  excludes: string;
  newerThan: "" | "1d" | "7d" | "30d" | "365d";
  hasAttachment: boolean;
};

const emptyAdvancedFilters: AdvancedMailFilters = {
  from: "",
  to: "",
  subject: "",
  hasWords: "",
  excludes: "",
  newerThan: "",
  hasAttachment: false,
};

function buildGmailSearchQuery(base: string, filters: AdvancedMailFilters) {
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

const emailCategoryMeta = {
  principal: { label: "Principal", tone: "bg-sky-400/12 text-sky-100 border-sky-300/25" },
  financeiro: { label: "Financeiro", tone: "bg-emerald-400/12 text-emerald-100 border-emerald-300/25" },
  trabalho: { label: "Trabalho", tone: "bg-blue-400/12 text-blue-100 border-blue-300/25" },
  promocoes: { label: "Promocoes", tone: "bg-pink-400/12 text-pink-100 border-pink-300/25" },
  social: { label: "Social", tone: "bg-violet-400/12 text-violet-100 border-violet-300/25" },
  atualizacoes: { label: "Atualizacoes", tone: "bg-cyan-400/12 text-cyan-100 border-cyan-300/25" },
  suporte: { label: "Suporte", tone: "bg-amber-400/12 text-amber-100 border-amber-300/25" },
} as const;

type EmailCategoryKey = keyof typeof emailCategoryMeta;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function PortalWhen({ active, children }: { active: boolean; children: ReactNode }) {
  if (active && typeof document !== "undefined") return createPortal(children, document.body);
  return children;
}

function splitRecipients(value: string) {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function initials(name: string) {
  const parts = name.replace(/<.*?>/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || "N") + (parts[1]?.[0] || "");
}

function accountInitials(status: GmailStatus | null) {
  return initials(status?.name || status?.email || "Conta Norium").slice(0, 2).toUpperCase();
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function classifyEmailCategory(message: GmailMessage): EmailCategoryKey {
  const labels = new Set((message.labels || []).map((label) => label.toUpperCase()));
  const text = normalizeText(`${message.fromName} ${message.fromEmail} ${message.subject} ${message.snippet}`);
  if (labels.has("CATEGORY_PROMOTIONS") || /promocao|promocoes|oferta|desconto|cupom|black friday/.test(text)) return "promocoes";
  if (labels.has("CATEGORY_SOCIAL") || /linkedin|facebook|instagram|rede social/.test(text)) return "social";
  if (/boleto|fatura|recibo|pagamento|pix|nubank|banco|cartao|nota fiscal/.test(text)) return "financeiro";
  if (labels.has("CATEGORY_UPDATES") || /atualizacao|notificacao|confirmacao|alerta|codigo|acesso/.test(text)) return "atualizacoes";
  if (/cliente|proposta|contrato|reuniao|orcamento|trabalho|comercial|projeto/.test(text)) return "trabalho";
  if (/suporte|ticket|erro|chamado|atendimento|protocolo/.test(text)) return "suporte";
  return "principal";
}

function friendlyGmailLabel(label: string) {
  const systemLabels: Record<string, string> = {
    CATEGORY_PERSONAL: "Principal",
    CATEGORY_PROMOTIONS: "Promocoes",
    CATEGORY_SOCIAL: "Social",
    CATEGORY_UPDATES: "Atualizacoes",
    CATEGORY_FORUMS: "Foruns",
    INBOX: "Caixa de entrada",
    UNREAD: "Nao lido",
    STARRED: "Com estrela",
    IMPORTANT: "Importante",
    SENT: "Enviado",
    DRAFT: "Rascunho",
    SPAM: "Spam",
    TRASH: "Lixo",
  };
  const key = label.toUpperCase();
  return systemLabels[key] || label.replace(/^CATEGORY_/i, "Categoria ").replace(/^Label_/i, "Marcador ");
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Nao consegui ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function isImage(mimeType: string) {
  return mimeType.startsWith("image/");
}

function cleanEmailSourceText(value?: string) {
  return (value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function fallbackEmailSuggestion(target: "compose" | "reply", message: GmailMessage | null, compose: ComposeState) {
  if (target === "reply" && message) {
    const senderName = message.fromName || "tudo bem";
    const firstName = senderName.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, "") || "tudo bem";
    return [
      `Ola, ${firstName}.`,
      "",
      "Obrigado pelo envio. Vou verificar os pontos mencionados e retorno com uma posicao objetiva assim que concluir a analise.",
      "",
      "Se houver alguma prioridade ou prazo especifico, pode me sinalizar por aqui.",
      "",
      "Atenciosamente,",
      "Tarcisio",
    ].join("\n");
  }

  return [
    "Ola,",
    "",
    compose.body?.trim() || "Estou entrando em contato para alinhar os proximos passos e confirmar as informacoes necessarias.",
    "",
    "Fico no aguardo do seu retorno.",
    "",
    "Atenciosamente,",
    "Tarcisio",
  ].join("\n");
}

function looksLikeBadEmailSuggestion(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("historico") ||
    normalized.includes("histórico") ||
    normalized.includes("vazio") ||
    normalized.includes("mais contexto") ||
    normalized.includes("preciso de contexto") ||
    normalized.includes("nao consigo") ||
    normalized.includes("não consigo")
  );
}

type EmailDashboardProps = {
  userId?: string;
  canUseNora?: boolean;
  selectedEmailId?: string | null;
  onSelectedEmailHandled?: () => void;
};

export default function EmailDashboard({ userId = "lucas123", canUseNora = true, selectedEmailId, onSelectedEmailHandled }: EmailDashboardProps) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [activeFilter, setActiveFilter] = useState<MailQuickFilter>("all");
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedMessage, setSelectedMessage] = useState<GmailMessage | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [replyText, setReplyText] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<ComposeAttachment[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("resumir minha caixa de entrada");
  const [aiMessages, setAiMessages] = useState<AgentMessage[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [noraSuggesting, setNoraSuggesting] = useState<"compose" | "reply" | null>(null);
  const [noraSuggestion, setNoraSuggestion] = useState<NoraEmailSuggestion | null>(null);
  const [noraSuggestionInstruction, setNoraSuggestionInstruction] = useState("");
  const [emailAgentSessionId, setEmailAgentSessionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedMailFilters>(emptyAdvancedFilters);
  const [messageMenuOpen, setMessageMenuOpen] = useState(false);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [filtersOpen]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [compactMode, setCompactMode] = useState(false);
  const [groupByCategory, setGroupByCategory] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [messageFullscreen, setMessageFullscreen] = useState(false);
  const aiScrollRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const mailboxCacheRef = useRef<Map<string, MailboxSnapshot>>(mailboxSessionCache);
  const mailboxRequestsInFlightRef = useRef<Set<string>>(new Set());
  const currentMailboxKey = mailboxCacheKey(userId, activeFolder, activeFilter, searchQuery);
  const activeMailboxKeyRef = useRef(currentMailboxKey);
  const preferencesLoadedRef = useRef(false);

  activeMailboxKeyRef.current = currentMailboxKey;

  const labelById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);
  const userLabels = labels.filter((label) => label.type === "user").slice(0, 14);
  const inboxUnread = labelById.get("INBOX")?.messagesUnread || 0;
  const groupedMessages = useMemo(() => {
    const groups = new Map<EmailCategoryKey, GmailMessage[]>();
    messages.forEach((message) => {
      const category = classifyEmailCategory(message);
      groups.set(category, [...(groups.get(category) || []), message]);
    });
    return Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [messages]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("norium-mail-preferences") || "{}") as Partial<{
        autoRefresh: boolean;
        showPreview: boolean;
        compactMode: boolean;
        groupByCategory: boolean;
      }>;
      if (typeof stored.autoRefresh === "boolean") setAutoRefresh(stored.autoRefresh);
      if (typeof stored.showPreview === "boolean") setShowPreview(stored.showPreview);
      if (typeof stored.compactMode === "boolean") setCompactMode(stored.compactMode);
      if (typeof stored.groupByCategory === "boolean") setGroupByCategory(stored.groupByCategory);
    } catch {
      // Preferencias invalidas nao devem impedir o carregamento do Gmail.
    }
    window.requestAnimationFrame(() => {
      preferencesLoadedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!preferencesLoadedRef.current) return;
    window.localStorage.setItem("norium-mail-preferences", JSON.stringify({
      autoRefresh,
      showPreview,
      compactMode,
      groupByCategory,
    }));
  }, [autoRefresh, compactMode, groupByCategory, showPreview]);

  useEffect(() => {
    mailboxRequestsInFlightRef.current.clear();
    setMessages([]);
    setSelectedMessage(null);
    setSelectedIds(new Set());
  }, [userId]);

  const fetchStatus = useCallback(async () => {
    const data = await apiJson<GmailStatus>(`/api/emails/gmail/status?user_id=${userId}`);
    setStatus(data);
    return data;
  }, [userId]);

  const fetchLabels = useCallback(async () => {
    const data = await apiJson<GmailStatus & { labels: GmailLabel[] }>(`/api/emails/gmail/labels?user_id=${userId}`);
    setLabels(data.labels || []);
    setStatus((prev) => ({ ...(prev || data), ...data }));
  }, [userId]);

  const fetchMessages = useCallback(
    async (append = false, pageToken?: string | null, silent = false) => {
      const requestKey = mailboxCacheKey(userId, activeFolder, activeFilter, searchQuery);
      const requestId = `${requestKey}::${pageToken || "first"}`;
      if (mailboxRequestsInFlightRef.current.has(requestId)) return;
      mailboxRequestsInFlightRef.current.add(requestId);

      const cached = mailboxCacheRef.current.get(requestKey);
      const shouldShowLoader = !silent && !append && !cached;
      if (shouldShowLoader) setLoading(true);
      if (activeMailboxKeyRef.current === requestKey) setError("");
      try {
        const data = await apiJson<MessageListResponse>(buildMessagesPath({
          userId,
          folder: activeFolder,
          filter: activeFilter,
          query: searchQuery,
          pageToken,
        }));
        const incomingMessages = data.messages || [];
        const previousMessages = append ? mailboxCacheRef.current.get(requestKey)?.messages || [] : [];
        const nextMessages = append
          ? Array.from(new Map([...previousMessages, ...incomingMessages].map((message) => [message.id, message])).values())
          : incomingMessages;
        const snapshot: MailboxSnapshot = {
          messages: nextMessages,
          nextPageToken: data.nextPageToken || null,
          resultSize: data.resultSizeEstimate || 0,
          cachedAt: Date.now(),
        };
        mailboxCacheRef.current.set(requestKey, snapshot);

        if (activeMailboxKeyRef.current === requestKey) {
          setMessages(snapshot.messages);
          setNextPageToken(snapshot.nextPageToken);
          setResultSize(snapshot.resultSize);
        }
        setStatus((prev) => ({ ...(prev || data), ...data }));
      } catch (err) {
        if (activeMailboxKeyRef.current === requestKey) {
          setError(err instanceof Error ? err.message : "Nao foi possivel carregar os e-mails.");
        }
      } finally {
        mailboxRequestsInFlightRef.current.delete(requestId);
        if (shouldShowLoader && activeMailboxKeyRef.current === requestKey) setLoading(false);
      }
    },
    [activeFilter, activeFolder, searchQuery, userId],
  );

  const prefetchMailbox = useCallback(async (folder: string) => {
    const requestKey = mailboxCacheKey(userId, folder, "all", "");
    const requestId = `${requestKey}::first`;
    if (mailboxCacheRef.current.has(requestKey) || mailboxRequestsInFlightRef.current.has(requestId)) return;
    mailboxRequestsInFlightRef.current.add(requestId);
    try {
      const data = await apiJson<MessageListResponse>(buildMessagesPath({
        userId,
        folder,
        filter: "all",
        query: "",
      }));
      mailboxCacheRef.current.set(requestKey, {
        messages: data.messages || [],
        nextPageToken: data.nextPageToken || null,
        resultSize: data.resultSizeEstimate || 0,
        cachedAt: Date.now(),
      });
    } catch {
      // O pre-carregamento e oportunista; a navegacao normal continua exibindo erros quando necessario.
    } finally {
      mailboxRequestsInFlightRef.current.delete(requestId);
    }
  }, [userId]);

  useEffect(() => {
    void fetchStatus().catch((err) => setError(err instanceof Error ? err.message : "Falha ao checar Gmail."));
  }, [fetchStatus]);

  useEffect(() => {
    if (!status?.connected) return;
    void fetchLabels().catch(() => undefined);
  }, [fetchLabels, status?.connected]);

  useEffect(() => {
    if (!status?.connected) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const folder of ["sent", "drafts", "scheduled", "starred", "important", "spam", "trash"]) {
          if (cancelled) return;
          await prefetchMailbox(folder);
        }
      })();
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [prefetchMailbox, status?.connected]);

  useEffect(() => {
    if (!status?.connected) return;
    setSelectedIds(new Set());
    setSelectedMessage(null);
    const cached = mailboxCacheRef.current.get(currentMailboxKey);
    if (cached) {
      setMessages(cached.messages);
      setNextPageToken(cached.nextPageToken);
      setResultSize(cached.resultSize);
      setLoading(false);
    } else {
      setMessages([]);
      setNextPageToken(null);
      setResultSize(0);
    }
    void fetchMessages(false, null, Boolean(cached));
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void fetchMessages(false, null, true);
      void fetchLabels().catch(() => undefined);
    }, 45000);
    return () => window.clearInterval(timer);
  }, [activeFolder, activeFilter, autoRefresh, currentMailboxKey, fetchLabels, fetchMessages, status?.connected]);

  useEffect(() => {
    if (!status?.connected) return;
    const refresh = () => {
      void fetchMessages(false, null, true);
      void fetchLabels().catch(() => undefined);
    };
    window.addEventListener("emails:changed", refresh);
    return () => window.removeEventListener("emails:changed", refresh);
  }, [fetchLabels, fetchMessages, status?.connected]);

  useEffect(() => {
    setReplyText("");
    setReplyAttachments([]);
    setNoraSuggestion((current) => (current?.target === "reply" ? null : current));
    setNoraSuggestionInstruction("");
  }, [selectedMessage?.id]);

  useEffect(() => {
    setMessageMenuOpen(false);
  }, [selectedMessage?.id]);

  useEffect(() => {
    aiScrollRef.current?.scrollTo({
      top: aiScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [aiMessages, aiLoading, aiOpen]);

  useEffect(() => {
    const openCompose = () => setComposeOpen(true);
    window.addEventListener("emails:compose", openCompose);
    return () => window.removeEventListener("emails:compose", openCompose);
  }, []);

  async function connectGmail() {
    setError("");
    try {
      const data = await apiJson<{ auth_url: string }>(`/api/emails/gmail/auth-url?user_id=${userId}`);
      window.open(data.auth_url, "gmail_oauth", "width=980,height=760");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui abrir o login do Gmail.");
    }
  }

  async function disconnectGmail() {
    setError("");
    try {
      await apiJson("/api/emails/gmail/disconnect", {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      });
      setMessages([]);
      clearMailboxCacheForUser(userId);
      mailboxRequestsInFlightRef.current.clear();
      setLabels([]);
      setSelectedIds(new Set());
      setSelectedMessage(null);
      setProfileOpen(false);
      setSettingsOpen(false);
      void fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui desconectar o Gmail.");
    }
  }

  const openMessage = useCallback(async (message: GmailMessage) => {
    setSelectedMessage(message);
    setDetailLoading(true);
    setError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${message.id}?user_id=${userId}`);
      setSelectedMessage(data.message);
      if (message.unread) {
        setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, unread: false } : item)));
        const snapshot = mailboxCacheRef.current.get(activeMailboxKeyRef.current);
        if (snapshot) {
          mailboxCacheRef.current.set(activeMailboxKeyRef.current, {
            ...snapshot,
            messages: snapshot.messages.map((item) => (item.id === message.id ? { ...item, unread: false } : item)),
          });
        }
        void apiJson(`/api/emails/gmail/messages/${message.id}`, {
          method: "PATCH",
          body: JSON.stringify({ user_id: userId, action: "read" }),
        }).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui abrir este e-mail.");
    } finally {
      setDetailLoading(false);
    }
  }, [userId]);

  const openMessageById = useCallback(async (messageId: string) => {
    const existing = messages.find((message) => message.id === messageId);
    if (existing) {
      await openMessage(existing);
      return;
    }

    setDetailLoading(true);
    setError("");
    try {
      const data = await apiJson<{ message: GmailMessage }>(`/api/emails/gmail/messages/${messageId}?user_id=${userId}`);
      setSelectedMessage(data.message);
      if (data.message?.unread) {
        void apiJson(`/api/emails/gmail/messages/${messageId}`, {
          method: "PATCH",
          body: JSON.stringify({ user_id: userId, action: "read" }),
        }).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui abrir este e-mail.");
    } finally {
      setDetailLoading(false);
    }
  }, [messages, openMessage, userId]);

  useEffect(() => {
    if (!selectedEmailId) return;
    void openMessageById(selectedEmailId).finally(() => onSelectedEmailHandled?.());
  }, [onSelectedEmailHandled, openMessageById, selectedEmailId]);

  useEffect(() => {
    if (!selectedMessage) setMessageFullscreen(false);
  }, [selectedMessage]);

  useEffect(() => {
    if (!messageFullscreen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMessageFullscreen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => {
      messageScrollRef.current?.scrollTo({ top: 0 });
      messageScrollRef.current?.focus({ preventScroll: true });
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [messageFullscreen]);

  async function runMessageAction(messageId: string, action: string, closeAfter = false) {
    setError("");
    setMessageMenuOpen(false);
    try {
      await apiJson(`/api/emails/gmail/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ user_id: userId, action }),
      });
      clearMailboxCacheForUser(userId);

      if (["archive", "trash", "spam"].includes(action) || closeAfter) {
        setMessages((prev) => prev.filter((message) => message.id !== messageId));
        if (selectedMessage?.id === messageId) setSelectedMessage(null);
      } else if (action === "star" || action === "unstar") {
        const starred = action === "star";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, starred } : message)));
        setSelectedMessage((prev) => (prev?.id === messageId ? { ...prev, starred } : prev));
      } else if (action === "important" || action === "unimportant") {
        const important = action === "important";
        setMessages((prev) => prev.map((message) => (message.id === messageId ? { ...message, important } : message)));
        setSelectedMessage((prev) => (prev?.id === messageId ? { ...prev, important } : prev));
      } else {
        void fetchMessages(false);
      }
      void fetchLabels().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Acao nao concluida.");
    }
  }

  async function runBulkAction(action: string) {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    await Promise.all(ids.map((id) => runMessageAction(id, action, true)));
    setSelectedIds(new Set());
  }

  async function addFiles(files: FileList | null, target: "compose" | "reply") {
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
  }

  async function sendEmail(saveAsDraft = false) {
    setSending(true);
    setError("");
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
      setNoraSuggestion((current) => (current?.target === "compose" ? null : current));
      setNoraSuggestionInstruction("");
      setComposeOpen(false);
      selectMailbox(saveAsDraft ? "drafts" : "sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar e-mail.");
    } finally {
      setSending(false);
    }
  }

  async function sendReply() {
    if (!selectedMessage || !replyText.trim()) return;
    setSending(true);
    setError("");
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
      setNoraSuggestion((current) => (current?.target === "reply" ? null : current));
      setNoraSuggestionInstruction("");
      selectMailbox("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao responder e-mail.");
    } finally {
      setSending(false);
    }
  }

  async function askEmailAgent(text?: string) {
    const finalText = (text || aiInput).trim();
    if (!finalText) return;
    setAiOpen(true);
    setAiInput("");
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: "user", text: finalText }]);
    try {
      const data = await apiJson<{ session_id: string | null; status: string; response: string }>(
        "/api/emails/gmail/agente/mensagem",
        {
          method: "POST",
          body: JSON.stringify({ user_id: userId, session_id: emailAgentSessionId, message: finalText }),
        },
      );
      setEmailAgentSessionId(data.session_id);
      setAiMessages((prev) => [...prev, { role: "ai", text: data.response }]);
      if (data.status === "enviado") {
        clearMailboxCacheForUser(userId);
        void fetchMessages(false);
      }
    } catch (err) {
      setAiMessages((prev) => [
        ...prev,
        { role: "ai", text: err instanceof Error ? err.message : "Agente de e-mail indisponivel." },
      ]);
    } finally {
      setAiLoading(false);
    }
  }

  function applyAdvancedSearch() {
    const query = buildGmailSearchQuery(searchDraft, advancedFilters);
    setSearchQuery(query);
    setFiltersOpen(false);
  }

  function clearAdvancedSearch() {
    setAdvancedFilters(emptyAdvancedFilters);
    setSearchDraft("");
    setSearchQuery("");
    setFiltersOpen(false);
  }

  function selectMailbox(folder: string) {
    setActiveFolder(folder);
    setActiveFilter("all");
    setSearchDraft("");
    setSearchQuery("");
    setAdvancedFilters(emptyAdvancedFilters);
    setFiltersOpen(false);
    setMobileSidebarOpen(false);
  }

  async function createLabel() {
    const name = newLabelName.trim();
    if (!name) {
      setError("Informe um nome para o marcador.");
      return;
    }
    setLabelSaving(true);
    setError("");
    try {
      await apiJson("/api/emails/gmail/labels", {
        method: "POST",
        body: JSON.stringify({ user_id: userId, name }),
      });
      await fetchLabels();
      setNewLabelName("");
      setLabelDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel criar o marcador.");
    } finally {
      setLabelSaving(false);
    }
  }

  async function askContextualEmailAssistant(action: "summary" | "next") {
    if (!selectedMessage) return;
    const source = cleanEmailSourceText(selectedMessage.bodyText || selectedMessage.snippet || selectedMessage.bodyHtml);
    const userText = action === "summary" ? "Resumir o e-mail aberto" : "Sugerir a proxima acao para o e-mail aberto";
    setAiOpen(true);
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: "user", text: userText }]);
    try {
      const prompt = [
        action === "summary"
          ? "Resuma o e-mail recebido de forma objetiva. Destaque pedido, prazo, valor e proxima acao somente quando existirem."
          : "Analise o e-mail recebido e recomende a proxima acao mais segura e objetiva. Nao invente dados.",
        `Remetente: ${selectedMessage.fromName} <${selectedMessage.fromEmail}>`,
        `Assunto: ${selectedMessage.subject || "(sem assunto)"}`,
        `Conteudo: ${source || selectedMessage.snippet || "(sem conteudo disponivel)"}`,
      ].join("\n");
      const data = await apiJson<{ response: string }>("/api/nora/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [
            { role: "system", content: "Voce e a Nora no Norium Mail. Responda em portugues do Brasil, com precisao e sem inventar fatos." },
            { role: "user", content: prompt },
          ],
        }),
      });
      setAiMessages((prev) => [...prev, { role: "ai", text: data.response?.trim() || "Nao encontrei conteudo suficiente para analisar." }]);
    } catch (err) {
      setAiMessages((prev) => [...prev, { role: "ai", text: err instanceof Error ? err.message : "A Nora nao conseguiu analisar este e-mail." }]);
    } finally {
      setAiLoading(false);
    }
  }

  async function askNoraEmailSuggestion(target: "compose" | "reply", instruction = "") {
    if (!canUseNora) {
      setError("A Nora nao esta liberada para esta conta.");
      return;
    }
    setNoraSuggesting(target);
    setError("");
    try {
      const currentSuggestion = noraSuggestion?.target === target ? noraSuggestion.text : "";
      const operatorDirection = instruction.trim();
      const sourceText =
        target === "reply" && selectedMessage
          ? cleanEmailSourceText(selectedMessage.bodyText || selectedMessage.snippet || selectedMessage.bodyHtml)
          : "";
      const prompt =
        target === "reply" && selectedMessage
          ? [
              "Tarefa: escreva SOMENTE o corpo final de uma resposta de e-mail.",
              "Voce esta escrevendo COMO Tarcisio, que RECEBEU o e-mail abaixo e vai responder ao remetente.",
              "Nunca escreva como se Tarcisio tivesse enviado o e-mail recebido.",
              "Nao diga que enviou, anexou, comprou, participou ou realizou algo se isso estiver apenas no e-mail recebido.",
              "Nao mencione historico de conversa, WhatsApp, falta de contexto, IA, Todoist ou analise externa.",
              "Use apenas os dados abaixo. Se o conteudo for promocional ou informativo, responda de forma curta, educada e neutra.",
              "Se o operador der uma orientacao, transforme essa orientacao em uma resposta completa e profissional.",
              "Nao explique o que voce fez. Nao use markdown.",
              "",
              `E-mail recebido de: ${selectedMessage.fromName} <${selectedMessage.fromEmail}>`,
              `Assunto recebido: ${selectedMessage.subject || "(sem assunto)"}`,
              `Conteudo recebido: ${sourceText || selectedMessage.snippet || "(sem corpo detalhado)"}`,
              `Texto que o operador ja escreveu no campo de resposta: ${replyText || "(vazio)"}`,
              `Rascunho anterior da Nora, se houver: ${currentSuggestion || "(nenhum)"}`,
              `Pedido de ajuste do operador: ${operatorDirection || "(nenhum)"}`,
            ].join("\n")
          : [
              "Tarefa: escreva SOMENTE o corpo final de um e-mail profissional.",
              "Nao mencione historico de conversa, WhatsApp, falta de contexto, IA ou analise externa.",
              "Se faltarem dados, crie uma mensagem curta, neutra e segura. Nao invente promessas, anexos ou informacoes.",
              "Se o operador der uma orientacao, transforme essa orientacao em uma mensagem completa.",
              "Nao explique o que voce fez. Nao use markdown.",
              "",
              `Destinatario: ${compose.to || "(nao informado)"}`,
              `Assunto: ${compose.subject || "(sem assunto)"}`,
              `Texto que o operador ja escreveu: ${compose.body || "(vazio)"}`,
              `Rascunho anterior da Nora, se houver: ${currentSuggestion || "(nenhum)"}`,
              `Pedido de ajuste do operador: ${operatorDirection || "(nenhum)"}`,
            ].join("\n");

      const data = await apiJson<{ response: string }>("/api/nora/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "Voce esta no modulo Norium Mail. Sua unica funcao aqui e redigir e-mails. Em respostas, escreva sempre como o operador que recebeu o e-mail, nunca como o remetente original. Responda apenas com o texto do e-mail, sem comentarios.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });

      const suggestion = data.response?.trim();
      if (!suggestion) throw new Error("A Nora nao retornou sugestao.");
      const finalSuggestion = looksLikeBadEmailSuggestion(suggestion)
        ? fallbackEmailSuggestion(target, selectedMessage, compose)
        : suggestion;

      setNoraSuggestion({ target, text: finalSuggestion });
      setNoraSuggestionInstruction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao consegui pedir uma sugestao para a Nora.");
    } finally {
      setNoraSuggesting(null);
    }
  }

  function acceptNoraSuggestion() {
    if (!noraSuggestion) return;
    if (noraSuggestion.target === "reply") {
      setReplyText(noraSuggestion.text);
    } else {
      setCompose((prev) => ({ ...prev, body: noraSuggestion.text }));
    }
    setNoraSuggestion(null);
    setNoraSuggestionInstruction("");
  }

  function discardNoraSuggestion() {
    setNoraSuggestion(null);
    setNoraSuggestionInstruction("");
  }

  function renderNoraSuggestionPanel(target: "compose" | "reply") {
    if (noraSuggestion?.target !== target) return null;
    return (
      <div className="border-t border-cyan-300/15 bg-cyan-400/[0.06] p-3">
        <div className="rounded-xl border border-cyan-300/20 bg-slate-950/25 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-cyan-200">Sugestao da Nora</p>
              <p className="text-xs font-semibold text-white/50">Revise antes de colocar no e-mail.</p>
            </div>
            <Button
             
              onClick={discardNoraSuggestion}
              className="border-white/10 py-1 text-white/55 hover:bg-white/7"
            >
              Descartar
            </Button>
          </div>
          <textarea
            value={noraSuggestion.text}
            onChange={(event) => setNoraSuggestion((current) => current ? { ...current, text: event.target.value } : current)}
            className="h-36 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-medium leading-6 text-white outline-none"
          />
          <div className="mt-3 grid gap-2">
            <input
              value={noraSuggestionInstruction}
              onChange={(event) => setNoraSuggestionInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && noraSuggestionInstruction.trim()) {
                  void askNoraEmailSuggestion(target, noraSuggestionInstruction);
                }
              }}
              placeholder="Ex: deixe mais curto, mais firme, acrescente que retorno amanha..."
              className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-semibold text-white outline-none placeholder:text-white/35"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost"
               
                onClick={acceptNoraSuggestion}
                className="mail-primary bg-[#0EA5E9] py-2"
              >
                Aceitar sugestao
              </Button>
              <Button
               
                onClick={() => void askNoraEmailSuggestion(target, "Refaca a resposta com outra abordagem, mantendo o sentido e sendo mais precisa.")}
                disabled={noraSuggesting !== null}
                className="mail-hover border-white/12 py-2 text-white/75 hover:bg-white/7"
              >
                Refazer
              </Button>
              <Button
               
                onClick={() => void askNoraEmailSuggestion(target, noraSuggestionInstruction)}
                disabled={noraSuggesting !== null || !noraSuggestionInstruction.trim()}
                className="mail-hover border-cyan-400/25 py-2 text-cyan-200 hover:bg-cyan-400/10"
              >
                Aplicar ajuste
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const visibleRange = messages.length ? `1-${messages.length}` : "0";
  const allSelected = messages.length > 0 && messages.every((message) => selectedIds.has(message.id));
  const selectedCategory = selectedMessage ? emailCategoryMeta[classifyEmailCategory(selectedMessage)] : null;
  const selectedLabels = selectedMessage
    ? (selectedMessage.labels || [])
        .map((label) => friendlyGmailLabel(labelById.get(label)?.name || label))
        .filter((label) => !["Caixa de entrada", "Nao lido", "Com estrela", "Importante"].includes(label))
        .filter((label) => !selectedCategory || normalizeText(label) !== normalizeText(selectedCategory.label))
        .slice(0, 10)
    : [];

  function renderMessageRow(message: GmailMessage) {
    const category = classifyEmailCategory(message);
    const categoryMeta = emailCategoryMeta[category];
    return (
      <button
        key={message.id}
        onClick={() => void openMessage(message)}
        className={cx(
          "mail-row grid w-full grid-cols-[42px_28px_minmax(160px,0.32fr)_1fr_96px] items-center gap-2 border-b border-white/9 px-4 text-left transition hover:bg-white/5",
          compactMode ? "min-h-[42px]" : "min-h-[54px]",
          selectedMessage?.id === message.id && "mail-active bg-white/7",
          message.unread && "bg-white/[0.035]",
        )}
      >
        <span
          onClick={(event) => {
            event.stopPropagation();
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (next.has(message.id)) next.delete(message.id);
              else next.add(message.id);
              return next;
            });
          }}
          className={cx(
            "flex h-5 w-5 items-center justify-center rounded border border-white/15",
            selectedIds.has(message.id) && "border-[#0EA5E9] bg-[#0EA5E9]",
          )}
        >
          {selectedIds.has(message.id) && <Check size={13} />}
        </span>
        <span
          onClick={(event) => {
            event.stopPropagation();
            void runMessageAction(message.id, message.starred ? "unstar" : "star");
          }}
          className="text-white/45 hover:text-[#BAE6FD]"
        >
          <Star size={17} fill={message.starred ? "currentColor" : "none"} className={message.starred ? "text-[#BAE6FD]" : ""} />
        </span>
        <span className={cx("truncate text-sm", message.unread ? "font-extrabold text-white" : "font-semibold text-white/65")}>
          {message.fromName}
        </span>
        <span className="min-w-0 truncate text-sm">
          {message.unread && <span className="mr-3 inline-block h-2 w-2 rounded-full bg-[#38BDF8]" />}
          <span className={cx(message.unread ? "font-extrabold text-white" : "font-semibold text-white/80")}>{message.subject}</span>
          {groupByCategory && (
            <span className={cx("ml-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-black uppercase", categoryMeta.tone)}>
              {categoryMeta.label}
            </span>
          )}
          {showPreview && (
            <>
              <span className="mx-2 text-white/25">-</span>
              <span className="text-white/45">{message.snippet}</span>
            </>
          )}
        </span>
        <span className="flex items-center justify-end gap-2 text-xs font-semibold text-white/55">
          {message.hasAttachment && <Paperclip size={14} />}
          {message.dateLabel}
        </span>
      </button>
    );
  }

  return (
    <div className={`norium-mail ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} flex h-full min-h-0 w-full overflow-hidden bg-[#111113] text-white`}>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="Fechar menu do e-mail"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <aside className="mail-sidebar flex h-full w-[260px] shrink-0 flex-col border-r border-white/10 bg-[#18181B]">
        <div className="flex h-[76px] items-center justify-between border-b border-white/10 px-5">
          <BrandLogo className="h-12 w-[118px]" />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-50 shadow-[0_12px_30px_rgba(8,47,73,0.2)]">
            <Mail size={12} />
            Mail
          </span>
        </div>

        <div className="p-4">
          <button
            onClick={() => setComposeOpen(true)}
            className="mail-primary flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0EA5E9] text-sm font-bold text-white transition hover:bg-[#0284C7]"
          >
            <PenLine size={17} />
            Nova mensagem
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <div className="space-y-1">
            {systemFolders.map((item) => {
              const Icon = item.icon;
              const count = item.countLabel ? labelById.get(item.countLabel)?.messagesUnread : undefined;
              const active = activeFolder === item.key && activeFilter === "all";
              return (
                <button
                  key={item.key}
                  onClick={() => selectMailbox(item.key)}
                  onMouseEnter={() => void prefetchMailbox(item.key)}
                  onFocus={() => void prefetchMailbox(item.key)}
                  className={cx(
                    "mail-hover flex h-10 w-full items-center justify-between rounded-lg px-3 text-sm font-semibold text-white/82 transition",
                    active ? "mail-active bg-white/10 text-white" : "hover:bg-white/7 hover:text-white",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <Icon size={18} className="text-white/70" />
                    {item.label}
                  </span>
                  {Boolean(count) && (
                    <span className="rounded-full bg-white/18 px-2 py-0.5 text-xs text-white/80">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between px-3 pb-2 text-xs font-bold text-white/55">
              <span className="flex items-center gap-2">
                <Folder size={14} />
                Pastas
              </span>
              <Button variant="ghost" iconOnly
               
                onClick={() => setLabelDialogOpen(true)}
                className="mail-hover h-7 w-7 hover:bg-white/7 hover:text-white"
                title="Criar marcador"
                aria-label="Criar marcador"
              >
                <Plus size={15} />
              </Button>
            </div>
            <button
              onClick={() => selectMailbox("starred")}
              onMouseEnter={() => void prefetchMailbox("starred")}
              onFocus={() => void prefetchMailbox("starred")}
              className={cx(
                "mail-hover flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-semibold text-white/82 hover:bg-white/7",
                activeFolder === "starred" && activeFilter === "all" && "mail-active bg-white/10 text-white",
              )}
            >
              <Star size={18} className="text-white/70" />
              Com estrela
            </button>
            <button
              onClick={() => selectMailbox("important")}
              onMouseEnter={() => void prefetchMailbox("important")}
              onFocus={() => void prefetchMailbox("important")}
              className={cx(
                "mail-hover flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-semibold text-white/82 hover:bg-white/7",
                activeFolder === "important" && activeFilter === "all" && "mail-active bg-white/10 text-white",
              )}
            >
              <MailCheck size={18} className="text-white/70" />
              Importante
            </button>
          </div>

          {userLabels.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between px-3 pb-2 text-xs font-bold text-white/55">
                <span className="flex items-center gap-2">
                  <Tags size={14} />
                  Marcadores
                </span>
              </div>
              <div className="space-y-1">
                {userLabels.map((label) => (
                  <button
                    key={label.id}
                    onClick={() => selectMailbox(`label:${label.id}`)}
                    onMouseEnter={() => void prefetchMailbox(`label:${label.id}`)}
                    onFocus={() => void prefetchMailbox(`label:${label.id}`)}
                    className={cx(
                      "flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm font-semibold text-white/75 hover:bg-white/7",
                      activeFolder === `label:${label.id}` && "bg-white/10 text-white",
                    )}
                  >
                    <span className="min-w-0 truncate">{label.name}</span>
                    {Boolean(label.messagesUnread) && (
                      <span className="rounded-full bg-[#0EA5E9]/45 px-2 py-0.5 text-xs">{label.messagesUnread}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>

        <div className="border-t border-white/10 p-4">
          <div className="mb-2 h-1 rounded-full bg-white/15">
            <div className="h-full w-[21%] rounded-full bg-[#38BDF8]" />
          </div>
          <div className="flex items-center justify-between text-xs font-bold">
            <span className="text-white">Norium Mail</span>
            <button onClick={() => void fetchLabels()} className="text-white/70 hover:text-white">
              Atualizar
            </button>
          </div>
          <button onClick={() => setSettingsOpen(true)} className="mail-hover mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/12 text-xs font-bold text-white/80 hover:bg-white/7">
            <Settings size={14} />
            Configuracoes rapidas
          </button>
        </div>
      </aside>

      <section className="mail-main flex min-w-0 flex-1 flex-col bg-[#151518]">
        <header className="mail-surface flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div className="flex min-w-0 items-center gap-4">
            <button
              type="button"
              className="mobile-sidebar-toggle"
              aria-label="Abrir menu do e-mail"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu size={18} />
            </button>
            <div className="mail-input relative flex h-11 w-[405px] max-w-[42vw] items-center gap-3 rounded-lg border border-white/12 bg-[#1C1C20] px-4">
              <Search size={18} className="text-white/55" />
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyAdvancedSearch();
                }}
                placeholder="Pesquisar email"
                className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-white/45"
              />
              {searchDraft && (
                <button type="button" onClick={clearAdvancedSearch} className="text-white/45 hover:text-white" title="Limpar pesquisa" aria-label="Limpar pesquisa">
                  <X size={16} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setFiltersOpen((value) => !value)}
                className={cx("text-white/55 hover:text-white", filtersOpen && "text-cyan-300")}
                title="Filtros avancados"
                aria-expanded={filtersOpen}
               aria-label="Filtros avancados">
                <SlidersHorizontal size={17} />
              </button>
              {filtersOpen && createPortal(
                <div
                  className="mail-advanced-search-backdrop fixed inset-0 z-[240] flex items-start justify-center bg-black/55 px-4 pt-[88px] backdrop-blur-[2px]"
                  onMouseDown={(event) => {
                    if (event.currentTarget === event.target) setFiltersOpen(false);
                  }}
                >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    applyAdvancedSearch();
                  }}
                  className="mail-modal mail-advanced-search-panel isolate max-h-[calc(100dvh-112px)] w-[520px] max-w-full overflow-y-auto rounded-xl border border-white/12 bg-[#0C0E10] p-5 text-white shadow-[0_28px_100px_rgba(0,0,0,0.78)]"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-bold">Pesquisa avancada</p>
                      <p className="text-xs font-semibold text-white/45">Combine campos para localizar mensagens no Gmail.</p>
                    </div>
                    <Button variant="ghost" size="sm" iconOnly onClick={() => setFiltersOpen(false)} className="hover:bg-white/7"><X size={16} /></Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs font-bold text-white/60">De
                      <input value={advancedFilters.from} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, from: event.target.value }))} placeholder="remetente@email.com" className="h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60" />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-white/60">Para
                      <input value={advancedFilters.to} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, to: event.target.value }))} placeholder="destinatario@email.com" className="h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60" />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-white/60 sm:col-span-2">Assunto
                      <input value={advancedFilters.subject} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, subject: event.target.value }))} placeholder="Palavras no assunto" className="h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60" />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-white/60">Contem as palavras
                      <input value={advancedFilters.hasWords} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, hasWords: event.target.value }))} className="h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60" />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-white/60">Nao contem
                      <input value={advancedFilters.excludes} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, excludes: event.target.value }))} className="h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60" />
                    </label>
                    <label className="grid gap-1 text-xs font-bold text-white/60">Periodo
                      <select value={advancedFilters.newerThan} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, newerThan: event.target.value as AdvancedMailFilters["newerThan"] }))} className="h-10 rounded-lg border border-white/12 bg-[#101014] px-3 text-xs text-white outline-none">
                        <option value="">Qualquer periodo</option><option value="1d">Ultimas 24 horas</option><option value="7d">Ultimos 7 dias</option><option value="30d">Ultimos 30 dias</option><option value="365d">Ultimo ano</option>
                      </select>
                    </label>
                    <label className="flex h-10 items-center gap-2 self-end rounded-lg border border-white/12 px-3 text-xs font-bold text-white/70">
                      <input type="checkbox" checked={advancedFilters.hasAttachment} onChange={(event) => setAdvancedFilters((prev) => ({ ...prev, hasAttachment: event.target.checked }))} className="accent-cyan-400" /> Com anexo
                    </label>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button size="sm" onClick={clearAdvancedSearch} className="border-white/12 text-white/65 hover:bg-white/7">Limpar</Button>
                    <Button variant="ghost" size="sm" type="submit" className="mail-primary bg-[#0EA5E9]">Pesquisar</Button>
                  </div>
                </form>
                </div>,
                document.body,
              )}
            </div>

            {status?.connected && (
              <div className="hidden min-w-0 text-xs font-semibold text-white/50 xl:block">
                Conectado como <span className="text-white/80">{status.email}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {canUseNora && (
              <Button
                onClick={() => {
                  setAiOpen(true);
                  if (!aiMessages.length) void askEmailAgent("resumir minha caixa de entrada");
                }}
                className="rounded-full border-[#38BDF8] hover:bg-[#38BDF8]/12"
              >
                <Bot size={15} />
                Nora para E-mails
              </Button>
            )}
            <Button iconOnly onClick={() => setShowPreview((value) => !value)} title="Alternar previa" className="mail-hover rounded-full border-white/12 hover:bg-white/7" aria-label="Alternar previa">
              <Eye size={17} />
            </Button>
            <Button iconOnly onClick={() => setSettingsOpen(true)} title="Configuracoes do Mail" className="mail-hover rounded-full border-white/12 hover:bg-white/7" aria-label="Configuracoes do Mail">
              <Settings size={17} />
            </Button>
            <Button onClick={() => setProfileOpen((value) => !value)} title="Perfil" className="mail-hover overflow-hidden rounded-full border-white/12 bg-[#4A3B8F]" aria-label="Perfil">
              {status?.picture ? (
                <img src={status.picture} alt="Foto do perfil" className="h-full w-full object-cover" />
              ) : (
                <span>{accountInitials(status)}</span>
              )}
            </Button>
          </div>
        </header>

        {!status?.connected ? (
          <main className="flex flex-1 items-center justify-center p-8">
            <div className="mail-card w-full max-w-xl rounded-lg border border-white/12 bg-[#1A1B21] p-8 text-center shadow-2xl">
              <div className="mail-primary mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-[#0EA5E9]">
                <Mail size={26} />
              </div>
              <h1 className="text-2xl font-bold">Conectar Gmail</h1>
              <p className="mx-auto mt-3 max-w-md text-sm font-medium leading-6 text-white/60">
                O Norium Mail precisa de permissao do Google para listar, ler, marcar, responder e enviar e-mails pela sua conta.
              </p>
              {error && <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm font-bold text-red-200">{error}</p>}
              <div className="mt-6 flex justify-center gap-3">
                <Button variant="ghost" size="lg"
                  onClick={() => void connectGmail()}
                  className="mail-primary bg-[#0EA5E9] hover:bg-[#0284C7]"
                >
                  <Sparkles size={17} />
                  Conectar Gmail
                </Button>
                <Button size="lg"
                  onClick={() => void fetchStatus()}
                  className="mail-hover border-white/12 text-white/80 hover:bg-white/7"
                >
                  <RefreshCw size={16} />
                  Ja autorizei
                </Button>
              </div>
            </div>
          </main>
        ) : (
          <main className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-[104px] shrink-0 items-center justify-between px-4">
                <div>
                  <h1 className="text-xl font-bold">
                    {activeFilter === "unread"
                      ? "Nao lidos"
                      : activeFolder.startsWith("label:")
                        ? labelById.get(activeFolder.split(":", 2)[1])?.name || "Marcador"
                        : systemFolders.find((folder) => folder.key === activeFolder)?.label || "Caixa De Entrada"}
                  </h1>
                  <p className="mt-1 text-xs font-semibold text-white/45">
                    {inboxUnread} nao lidos · {autoRefresh ? "sincronizacao em tempo real a cada 45s" : "atualizacao manual"}
                  </p>
                </div>

                <div className="flex items-center gap-2 text-xs font-bold text-white/60">
                  <Button variant="ghost" size="sm" iconOnly onClick={() => void fetchMessages(false)} className="hover:bg-white/7">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  </Button>
                  <span>
                    {visibleRange} / {resultSize || messages.length}
                  </span>
                  <Button variant="ghost" size="sm" iconOnly
                   
                    disabled={messages.length <= GMAIL_PAGE_SIZE}
                    onClick={() => void fetchMessages(false, null)}
                    title="Voltar ao inicio"
                    className="hover:bg-white/7"
                   aria-label="Voltar ao inicio">
                    <ChevronLeft size={16} />
                  </Button>
                  <Button variant="ghost" size="sm" iconOnly
                    disabled={!nextPageToken}
                    onClick={() => void fetchMessages(true, nextPageToken)}
                    className="hover:bg-white/7"
                  >
                    <ChevronRight size={16} />
                  </Button>
                </div>
              </div>

              <div className="flex h-14 shrink-0 items-center justify-between border-y border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setSelectedIds(allSelected ? new Set() : new Set(messages.map((message) => message.id)));
                    }}
                    className={cx(
                      "flex h-5 w-5 items-center justify-center rounded border border-white/18",
                      allSelected && "bg-[#0EA5E9] border-[#0EA5E9]",
                    )}
                  >
                    {allSelected && <Check size={13} />}
                  </button>

                  {quickFilters.map((filter) => (
                    <button
                      key={filter.key}
                      onClick={() => setActiveFilter(filter.key)}
                      className={cx(
                        "mail-hover rounded-full border border-white/12 px-3 py-1.5 text-xs font-bold transition",
                        activeFilter === filter.key ? "mail-active bg-white text-black" : "text-white hover:bg-white/7",
                      )}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {selectedIds.size > 0 && (
                    <>
                      <Button onClick={() => void runBulkAction("archive")} className="mail-hover border-white/12 py-2 hover:bg-white/7">
                        Arquivar
                      </Button>
                      <Button onClick={() => void runBulkAction("trash")} className="mail-hover border-white/12 py-2 hover:bg-white/7">
                        Lixeira
                      </Button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      const next = !groupByCategory;
                      setGroupByCategory(next);
                      if (next && canUseNora) void askEmailAgent("agrupar e-mails por categoria");
                    }}
                    className={cx(
                      "mail-hover flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-bold",
                      groupByCategory
                        ? "border-cyan-300/35 bg-cyan-300/12 text-cyan-100"
                        : "border-white/12 text-white/70 hover:bg-white/7",
                    )}
                  >
                    <Tags size={14} />
                    Agrupar categorias
                  </button>
                  <Button size="sm" onClick={() => setFiltersOpen(true)} className="mail-hover border-white/12 text-white/70 hover:bg-white/7">
                    <Filter size={14} />
                    Filtros
                  </Button>
                </div>
              </div>

              {canUseNora && (
                <div className="mail-banner flex h-12 shrink-0 items-center bg-[#075985] px-4 text-sm font-bold">
                  <div className="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-white text-black">
                    <Bot size={18} />
                  </div>
                  <span className="min-w-0 flex-1 truncate">
                    A Nora agora esta na sua caixa de entrada. Elabore, resuma e responda de forma mais inteligente.
                  </span>
                  <Button variant="ghost" onClick={() => void askEmailAgent("resumir minha caixa de entrada")} className="mail-primary bg-[#0EA5E9] py-2">
                    Experimente
                  </Button>
                </div>
              )}

              {error && (
                <div className="border-b border-red-500/25 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">
                  {error}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading && !messages.length ? (
                  <div className="flex h-full items-center justify-center text-sm font-bold text-white/50">
                    <Loader2 size={18} className="mr-2 animate-spin" />
                    Sincronizando Gmail...
                  </div>
                ) : messages.length ? (
                  groupByCategory ? (
                    <div className="divide-y divide-white/8">
                      {groupedMessages.map(([category, items]) => {
                        const meta = emailCategoryMeta[category];
                        return (
                          <section key={category}>
                            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/8 bg-[#08256f]/95 px-4 py-2 backdrop-blur-xl">
                              <span className={cx("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-black", meta.tone)}>
                                <Tags size={14} />
                                {meta.label}
                              </span>
                              <span className="text-xs font-bold text-white/55">{items.length} e-mail(s)</span>
                            </div>
                            {items.map((message) => renderMessageRow(message))}
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    messages.map((message) => renderMessageRow(message))
                  )
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center text-white/45">
                    <MailOpen size={34} className="mb-3" />
                    <p className="text-sm font-bold">Nenhum e-mail encontrado nesse filtro.</p>
                  </div>
                )}
              </div>
            </div>

            {selectedMessage && (
              <PortalWhen active={messageFullscreen}>
              <aside
                className={cx(
                  "mail-sidebar flex flex-col overflow-hidden bg-[#18181B]",
                  messageFullscreen
                    ? "fixed inset-0 z-[100] h-[100dvh] max-h-[100dvh] w-screen min-h-0"
                    : "h-full w-[520px] shrink-0 border-l border-white/10",
                )}
                aria-label={messageFullscreen ? "E-mail aberto em tela cheia" : "Leitura do e-mail"}
              >
                <div className="mail-surface flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
                  <div className="flex items-center gap-1 text-white/70">
                    <Button variant="ghost" size="sm" iconOnly onClick={() => setSelectedMessage(null)} className="hover:bg-white/7" title="Voltar para a lista" aria-label="Voltar para a lista">
                      <ChevronLeft size={17} />
                    </Button>
                    <Button variant="ghost" size="sm" iconOnly onClick={() => void runMessageAction(selectedMessage.id, "archive", true)} className="hover:bg-white/7" title="Arquivar" aria-label="Arquivar">
                      <Archive size={17} />
                    </Button>
                    <Button variant="ghost" size="sm" iconOnly onClick={() => void runMessageAction(selectedMessage.id, "trash", true)} className="hover:bg-white/7" title="Mover para a lixeira" aria-label="Mover para a lixeira">
                      <Trash2 size={17} />
                    </Button>
                    <Button variant="ghost" size="sm" iconOnly onClick={() => void runMessageAction(selectedMessage.id, selectedMessage.unread ? "read" : "unread")} className="hover:bg-white/7" title={selectedMessage.unread ? "Marcar como lido" : "Marcar como nao lido"} aria-label={selectedMessage.unread ? "Marcar como lido" : "Marcar como nao lido"}>
                      {selectedMessage.unread ? <MailOpen size={17} /> : <MailCheck size={17} />}
                    </Button>
                    <Button variant="ghost" size="sm" iconOnly onClick={() => void runMessageAction(selectedMessage.id, selectedMessage.starred ? "unstar" : "star")} className="hover:bg-white/7" title={selectedMessage.starred ? "Remover estrela" : "Adicionar estrela"} aria-label={selectedMessage.starred ? "Remover estrela" : "Adicionar estrela"}>
                      <Star size={17} fill={selectedMessage.starred ? "currentColor" : "none"} />
                    </Button>
                    <button
                      onClick={() => setMessageMenuOpen((value) => !value)}
                      className={cx(
                        "flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/7",
                        messageMenuOpen && "bg-white/10 text-white",
                      )}
                      title={messageMenuOpen ? "Recolher acoes" : "Mais acoes"}
                      aria-expanded={messageMenuOpen}
                     aria-label={messageMenuOpen ? "Recolher acoes" : "Mais acoes"}>
                      <MoreVertical size={17} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" iconOnly
                     
                      onClick={() => setMessageFullscreen((value) => !value)}
                      className="text-white/70 hover:bg-white/7 hover:text-white"
                      title={messageFullscreen ? "Sair da tela cheia" : "Abrir em tela cheia"}
                      aria-label={messageFullscreen ? "Sair da tela cheia" : "Abrir e-mail em tela cheia"}
                    >
                      {messageFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                    </Button>
                    <Button variant="ghost" size="sm" iconOnly
                     
                      onClick={() => setSelectedMessage(null)}
                      className="text-white/60 hover:bg-white/7 hover:text-white"
                      title="Fechar e-mail"
                      aria-label="Fechar e-mail"
                    >
                      <X size={18} />
                    </Button>
                  </div>
                </div>

                {messageMenuOpen && (
                  <div className="mail-surface flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5 text-xs font-bold text-white/75">
                    <Button size="sm"
                      onClick={() => void runMessageAction(selectedMessage.id, selectedMessage.important ? "unimportant" : "important")}
                      className="mail-hover min-w-[150px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7"
                    >
                      <Star size={15} fill={selectedMessage.important ? "currentColor" : "none"} />
                      {selectedMessage.important ? "Remover importante" : "Marcar importante"}
                    </Button>
                    <Button size="sm"
                      onClick={() => void runMessageAction(selectedMessage.id, "spam", true)}
                      className="mail-hover min-w-[110px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7"
                    >
                      <ShieldAlert size={15} />
                      Spam
                    </Button>
                    {!messageFullscreen && (
                      <Button size="sm"
                        onClick={() => {
                          setMessageFullscreen(true);
                          setMessageMenuOpen(false);
                        }}
                        className="mail-hover min-w-[120px] flex-1 whitespace-nowrap border-white/12 hover:bg-white/7"
                      >
                        <Maximize2 size={15} />
                        Tela cheia
                      </Button>
                    )}
                  </div>
                )}

                <div ref={messageScrollRef} tabIndex={0} aria-label="Conteúdo rolável do e-mail" className="mail-reader-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-24 select-text outline-none">
                  {detailLoading ? (
                    <div className="flex h-64 items-center justify-center text-sm font-bold text-white/50">
                      <Loader2 size={18} className="mr-2 animate-spin" />
                      Abrindo e-mail...
                    </div>
                  ) : (
                    <>
                      <h2 className="text-xl font-bold leading-7">{selectedMessage.subject}</h2>
                      <div className="mail-card mt-4 flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-[#121217] p-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#246BFD] text-sm font-bold">
                            {initials(selectedMessage.fromName)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold">{selectedMessage.fromName}</p>
                            <p className="truncate text-xs font-semibold text-white/45">{selectedMessage.fromEmail}</p>
                            {selectedMessage.to && <p className="truncate text-xs font-semibold text-white/35">para {selectedMessage.to}</p>}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs font-semibold text-white/45">{selectedMessage.dateFull}</span>
                      </div>

                      <div className="mail-card mt-3 rounded-lg border border-white/10 bg-[#121217] p-4">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          {selectedCategory && (
                            <span className={cx("inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase", selectedCategory.tone)}>
                              {selectedCategory.label}
                            </span>
                          )}
                          <span className={cx("inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase", selectedMessage.unread ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/5 text-white/55")}>
                            {selectedMessage.unread ? "Nao lido" : "Lido"}
                          </span>
                          {selectedMessage.important && (
                            <span className="inline-flex rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-xs font-bold uppercase text-amber-100">
                              Importante
                            </span>
                          )}
                          {selectedMessage.starred && (
                            <span className="inline-flex rounded-full border border-sky-300/25 bg-sky-300/10 px-2.5 py-1 text-xs font-bold uppercase text-sky-100">
                              Com estrela
                            </span>
                          )}
                        </div>

                        <div className="grid gap-2 text-xs md:grid-cols-2">
                          <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                            <p className="font-black uppercase text-white/40">Para</p>
                            <p className="mt-1 break-words font-semibold text-white/80">{selectedMessage.to || "Nao informado"}</p>
                          </div>
                          <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                            <p className="font-black uppercase text-white/40">Recebido em</p>
                            <p className="mt-1 font-semibold text-white/80">{selectedMessage.dateFull || selectedMessage.dateLabel || "Sem data"}</p>
                          </div>
                          {selectedMessage.cc && (
                            <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                              <p className="font-black uppercase text-white/40">Cc</p>
                              <p className="mt-1 break-words font-semibold text-white/80">{selectedMessage.cc}</p>
                            </div>
                          )}
                          {selectedMessage.replyToEmail && (
                            <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                              <p className="font-black uppercase text-white/40">Responder para</p>
                              <p className="mt-1 break-words font-semibold text-white/80">{selectedMessage.replyToEmail}</p>
                            </div>
                          )}
                          <div className="rounded-lg border border-white/8 bg-white/[0.035] p-3">
                            <p className="font-black uppercase text-white/40">Anexos</p>
                            <p className="mt-1 font-semibold text-white/80">{selectedMessage.attachments?.length || 0} anexo(s)</p>
                          </div>
                        </div>

                        <div className="mt-3 border-t border-white/10 pt-3">
                          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Marcadores</p>
                          {selectedLabels.length ? (
                            <div className="flex flex-wrap gap-2">
                              {selectedLabels.map((label) => (
                                <span key={label} className="rounded-full border border-white/10 bg-white/[0.055] px-2.5 py-1 text-xs font-bold text-white/70">
                                  {label}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs font-semibold text-white/45">Nenhum marcador adicional.</p>
                          )}
                        </div>
                      </div>

                      <div className="mail-message-body mt-5 rounded-lg border border-white/10 bg-white p-4 text-black">
                        {selectedMessage.bodyHtml ? (
                          <iframe title="Conteudo do e-mail" sandbox="" srcDoc={selectedMessage.bodyHtml} className={cx("h-[420px] w-full bg-white", messageFullscreen && "pointer-events-none")} />
                        ) : (
                          <div className="whitespace-pre-wrap text-sm leading-6 text-zinc-900">
                            {selectedMessage.bodyText || selectedMessage.snippet || "Sem conteudo disponivel."}
                          </div>
                        )}
                      </div>

                      {Boolean(selectedMessage.attachments?.length) && (
                        <div className="mt-5">
                          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/45">Anexos</p>
                          <div className="grid gap-2">
                            {selectedMessage.attachments?.map((attachment) => (
                              <button
                                key={attachment.attachmentId}
                                type="button"
                                onClick={() => void downloadWithAuth(attachment.downloadUrl, attachment.fileName)}
                                className="mail-card mail-hover flex w-full items-center justify-between rounded-lg border border-white/10 bg-[#121217] p-3 text-left hover:bg-white/7"
                              >
                                <span className="flex min-w-0 items-center gap-3">
                                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/8">
                                    {isImage(attachment.mimeType) ? <Image size={18} /> : <FileText size={18} />}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-bold">{attachment.fileName}</span>
                                    <span className="text-xs font-semibold text-white/45">{formatBytes(attachment.size)}</span>
                                  </span>
                                </span>
                                <Download size={17} className="text-white/55" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mail-card mt-5 rounded-lg border border-white/10 bg-[#121217]">
                        <textarea
                          value={replyText}
                          onChange={(event) => setReplyText(event.target.value)}
                          placeholder="Escreva sua resposta..."
                          className="h-28 w-full resize-none bg-transparent p-4 text-sm font-medium text-white outline-none placeholder:text-white/35"
                        />
                        {replyAttachments.length > 0 && (
                          <AttachmentPreview
                            attachments={replyAttachments}
                            onRemove={(id) => setReplyAttachments((prev) => prev.filter((attachment) => attachment.id !== id))}
                          />
                        )}
                        {renderNoraSuggestionPanel("reply")}
                        <div className="flex items-center justify-between border-t border-white/10 p-3">
                          <div className="flex items-center gap-2">
                            <label className="flex h-9 w-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/7">
                              <Paperclip size={17} />
                              <input type="file" multiple className="hidden" onChange={(event) => void addFiles(event.target.files, "reply")} />
                            </label>
                            {canUseNora && (
                              <Button size="sm"
                                onClick={() => void askNoraEmailSuggestion("reply")}
                                disabled={noraSuggesting !== null}
                                className="mail-hover border-cyan-400/25 text-cyan-300 hover:bg-cyan-400/10"
                              >
                                {noraSuggesting === "reply" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                                Gerar sugestao
                              </Button>
                            )}
                          </div>
                          <Button variant="ghost" size="sm"
                            disabled={sending || !replyText.trim()}
                            onClick={() => void sendReply()}
                            className="mail-primary bg-[#0EA5E9]"
                          >
                            {sending ? <Loader2 size={15} className="animate-spin" /> : <Reply size={15} />}
                            Responder
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </aside>
              </PortalWhen>
            )}
          </main>
        )}
      </section>

      {composeOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/45 p-6">
          <div className="mail-modal flex h-[680px] w-[680px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <h2 className="text-sm font-bold">Nova mensagem</h2>
              <Button variant="ghost" size="sm" iconOnly
                onClick={() => {
                  setComposeOpen(false);
                  setNoraSuggestion((current) => (current?.target === "compose" ? null : current));
                  setNoraSuggestionInstruction("");
                }}
                className="hover:bg-white/7"
              >
                <X size={17} />
              </Button>
            </div>
            <div className="grid gap-0 border-b border-white/10">
              <input value={compose.to} onChange={(event) => setCompose((prev) => ({ ...prev, to: event.target.value }))} placeholder="Para" className="h-11 border-b border-white/8 bg-transparent px-4 text-sm outline-none placeholder:text-white/35" />
              <div className="grid grid-cols-2 border-b border-white/8">
                <input value={compose.cc} onChange={(event) => setCompose((prev) => ({ ...prev, cc: event.target.value }))} placeholder="Cc" className="h-11 border-r border-white/8 bg-transparent px-4 text-sm outline-none placeholder:text-white/35" />
                <input value={compose.bcc} onChange={(event) => setCompose((prev) => ({ ...prev, bcc: event.target.value }))} placeholder="Cco" className="h-11 bg-transparent px-4 text-sm outline-none placeholder:text-white/35" />
              </div>
              <input value={compose.subject} onChange={(event) => setCompose((prev) => ({ ...prev, subject: event.target.value }))} placeholder="Assunto" className="h-11 bg-transparent px-4 text-sm outline-none placeholder:text-white/35" />
            </div>
            <textarea
              value={compose.body}
              onChange={(event) => setCompose((prev) => ({ ...prev, body: event.target.value }))}
              placeholder="Digite sua mensagem"
              className="min-h-0 flex-1 resize-none bg-transparent p-4 text-sm leading-6 outline-none placeholder:text-white/35"
            />
            {compose.attachments.length > 0 && (
              <AttachmentPreview
                attachments={compose.attachments}
                onRemove={(id) => setCompose((prev) => ({ ...prev, attachments: prev.attachments.filter((attachment) => attachment.id !== id) }))}
              />
            )}
            {renderNoraSuggestionPanel("compose")}
            <div className="flex items-center justify-between border-t border-white/10 p-3">
              <div className="flex items-center gap-2">
                <label className="mail-hover flex h-10 w-10 items-center justify-center rounded-lg border border-white/12 text-white/75 hover:bg-white/7">
                  <Paperclip size={18} />
                  <input type="file" multiple className="hidden" onChange={(event) => void addFiles(event.target.files, "compose")} />
                </label>
                {canUseNora && (
                  <Button
                    onClick={() => void askNoraEmailSuggestion("compose")}
                    disabled={noraSuggesting !== null}
                    className="mail-hover border-cyan-400/25 text-cyan-300 hover:bg-cyan-400/10"
                  >
                    {noraSuggesting === "compose" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                    Gerar sugestao
                  </Button>
                )}
                <Button onClick={() => void sendEmail(true)} disabled={sending || !compose.to.trim()} className="mail-hover border-white/12 text-white/75 hover:bg-white/7">
                  Salvar rascunho
                </Button>
              </div>
              <Button variant="ghost"
                onClick={() => void sendEmail(false)}
                disabled={sending || !compose.to.trim()}
                className="mail-primary bg-[#0EA5E9]"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Enviar
              </Button>
            </div>
          </div>
        </div>
      )}

      {canUseNora && aiOpen && (
        <aside className="mail-modal fixed right-6 top-24 z-50 flex h-[640px] w-[390px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
          <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
            <div className="flex items-center gap-3">
              <div className="mail-primary flex h-9 w-9 items-center justify-center rounded-lg bg-[#0EA5E9]">
                <Bot size={18} />
              </div>
              <div>
                <h3 className="text-sm font-bold">Nora para E-mails</h3>
                <p className="max-w-[240px] truncate text-xs font-semibold text-white/45">
                  {selectedMessage ? `Contexto: ${selectedMessage.subject}` : "Caixa de entrada e novos envios"}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm" iconOnly onClick={() => setAiOpen(false)} className="hover:bg-white/7">
              <X size={17} />
            </Button>
          </div>
          <div className="flex gap-2 border-b border-white/10 p-3">
            {selectedMessage ? (
              <>
                <Button onClick={() => void askContextualEmailAssistant("summary")} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Resumir aberto</Button>
                <Button onClick={() => { setAiOpen(false); void askNoraEmailSuggestion("reply"); }} className="mail-hover rounded-full border-cyan-300/25 py-1.5 text-cyan-100 hover:bg-cyan-300/10">Sugerir resposta</Button>
                <Button onClick={() => void askContextualEmailAssistant("next")} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Proxima acao</Button>
              </>
            ) : (
              <>
                <Button onClick={() => void askEmailAgent("listar e-mails nao lidos")} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Nao lidos</Button>
                <Button onClick={() => void askEmailAgent("resumir minha caixa de entrada")} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Resumir caixa</Button>
                <Button onClick={() => { setAiOpen(false); setComposeOpen(true); }} className="mail-hover rounded-full border-white/12 py-1.5 hover:bg-white/7">Criar e-mail</Button>
              </>
            )}
          </div>
          <div ref={aiScrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {aiMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={cx(
                  "whitespace-pre-wrap rounded-lg border p-3 text-sm font-semibold leading-5",
                  message.role === "user"
                    ? "mail-primary ml-auto max-w-[84%] border-transparent bg-[#0EA5E9] text-white"
                    : "mail-card max-w-[90%] border-white/10 bg-[#121217] text-white",
                )}
              >
                {message.text}
              </div>
            ))}
            {aiLoading && <div className="text-sm font-bold text-white/50">Nora lendo seus e-mails...</div>}
          </div>
          <div className="border-t border-white/10 p-3">
            <div className="mail-input flex items-center gap-2 rounded-lg border border-white/12 bg-[#121217] p-2">
              <input
                value={aiInput}
                onChange={(event) => setAiInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void askEmailAgent();
                }}
                placeholder="Peca algo ao agente..."
                className="min-w-0 flex-1 bg-transparent px-2 text-sm font-semibold outline-none placeholder:text-white/35"
              />
              <Button variant="ghost" size="sm" iconOnly onClick={() => void askEmailAgent()} className="mail-primary bg-[#0EA5E9]">
                <Send size={16} />
              </Button>
            </div>
          </div>
        </aside>
      )}

      {labelDialogOpen && (
        <div
          className="fixed inset-0 z-[90] grid place-items-center bg-black/65 p-4 backdrop-blur-[2px]"
          onClick={() => {
            setLabelDialogOpen(false);
            setNewLabelName("");
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createLabel();
            }}
            onClick={(event) => event.stopPropagation()}
            className="mail-modal w-full max-w-md overflow-hidden rounded-lg border border-white/12 bg-[#0C0E10] shadow-[0_24px_80px_rgba(0,0,0,0.72)]"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="text-base font-black">Novo marcador</h2>
                <p className="mt-1 text-xs font-semibold text-white/45">Organize mensagens sem sair do Norium Mail.</p>
              </div>
              <Button variant="ghost" size="sm" iconOnly
               
                onClick={() => {
                  setLabelDialogOpen(false);
                  setNewLabelName("");
                }}
                className="mail-hover hover:bg-white/7"
                aria-label="Fechar"
              >
                <X size={16} />
              </Button>
            </div>
            <div className="p-5">
              <label className="grid gap-2 text-xs font-bold text-white/65">
                Nome do marcador
                <input
                  autoFocus
                  value={newLabelName}
                  onChange={(event) => setNewLabelName(event.target.value)}
                  placeholder="Ex.: Clientes prioritarios"
                  maxLength={100}
                  className="mail-input h-11 rounded-lg border border-white/12 bg-black/25 px-3 text-sm text-white outline-none focus:border-cyan-400/60"
                />
              </label>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                 
                  onClick={() => {
                    setLabelDialogOpen(false);
                    setNewLabelName("");
                  }}
                  className="mail-hover border-white/12 text-white/65 hover:bg-white/7"
                >
                  Cancelar
                </Button>
                <Button variant="ghost"
                  type="submit"
                  disabled={!newLabelName.trim() || labelSaving}
                  className="mail-primary bg-[#0EA5E9]"
                >
                  {labelSaving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  Criar marcador
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      {settingsOpen && (
        <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setSettingsOpen(false)}>
          <aside className="mail-modal absolute inset-y-0 right-0 flex w-[430px] max-w-[92vw] flex-col border-l border-white/12 bg-[#18181B] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
              <div>
                <h2 className="text-base font-black">Ajustes rapidos</h2>
                <p className="text-xs font-semibold text-white/45">Personalize o Norium Mail</p>
              </div>
              <Button variant="ghost" size="sm" iconOnly onClick={() => setSettingsOpen(false)} className="mail-hover hover:bg-white/7">
                <X size={17} />
              </Button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-white/45">Densidade</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setCompactMode(false)} className={cx("h-10 rounded-lg border text-xs font-black", !compactMode ? "border-cyan-300/45 bg-cyan-300/12 text-cyan-100" : "border-white/10 text-white/60 hover:bg-white/7")}>Padrao</button>
                  <button type="button" onClick={() => setCompactMode(true)} className={cx("h-10 rounded-lg border text-xs font-black", compactMode ? "border-cyan-300/45 bg-cyan-300/12 text-cyan-100" : "border-white/10 text-white/60 hover:bg-white/7")}>Compacta</button>
                </div>
              </section>

              <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-white/45">Caixa de entrada</p>
                <div className="mt-3 grid gap-2">
                  <ToggleRow checked={groupByCategory} label="Agrupar por categorias" onChange={setGroupByCategory} />
                  <ToggleRow checked={showPreview} label="Mostrar texto de previa" onChange={setShowPreview} />
                </div>
              </section>

              <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-white/45">Sincronizacao</p>
                <div className="mt-3 grid gap-2">
                  <ToggleRow checked={autoRefresh} label="Atualizar automaticamente a cada 45s" onChange={setAutoRefresh} />
                  <Button onClick={() => void fetchMessages(false)} disabled={!status?.connected} className="mail-hover border-white/12">Atualizar agora</Button>
                </div>
              </section>

              <section className="mail-card rounded-lg border border-white/10 bg-[#121217] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-white/45">Conta Gmail</p>
                <p className="mt-2 break-all text-sm font-bold">{status?.connected ? status.email : "Desconectada"}</p>
                <p className="mt-1 text-xs font-semibold text-white/45">{status?.lastSync ? `Ultima sincronizacao: ${new Date(status.lastSync).toLocaleString("pt-BR")}` : "Aguardando autorizacao"}</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button onClick={() => void connectGmail()} className="mail-hover border-white/12">Reconectar</Button>
                  <Button onClick={() => void disconnectGmail()} disabled={!status?.connected} className="border-red-500/35 text-red-300">Desconectar</Button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}

      {profileOpen && (
        <div className="fixed right-6 top-24 z-50 w-[340px] max-w-[calc(100vw-48px)]">
          <aside className="mail-modal overflow-hidden rounded-lg border border-white/12 bg-[#18181B] shadow-2xl">
            <div className="flex items-center gap-3 border-b border-white/10 p-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#4A3B8F] text-base font-black">
                {status?.picture ? (
                  <img src={status.picture} alt="Foto do perfil" className="h-full w-full object-cover" />
                ) : (
                  <span>{accountInitials(status)}</span>
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{status?.name || "Perfil Norium"}</p>
                <p className="truncate text-xs font-semibold text-white/45">{status?.email || "Gmail nao conectado"}</p>
              </div>
              <Button variant="ghost" size="sm" iconOnly onClick={() => setProfileOpen(false)} className="mail-hover ml-auto hover:bg-white/7">
                <X size={16} />
              </Button>
            </div>

            <div className="grid gap-2 p-3">
              <Button variant="ghost" onClick={() => { setSettingsOpen(true); setProfileOpen(false); }} className="mail-hover hover:bg-white/7">
                <Settings size={16} />
                Configuracoes
              </Button>
              <Button variant="ghost" onClick={() => void fetchStatus()} className="mail-hover hover:bg-white/7">
                <RefreshCw size={16} />
                Atualizar perfil
              </Button>
              <Button variant="ghost" onClick={() => void connectGmail()} className="mail-hover hover:bg-white/7">
                <Sparkles size={16} />
                {status?.connected ? "Reconectar Gmail" : "Conectar Gmail"}
              </Button>
              <Button variant="danger" onClick={() => void disconnectGmail()} disabled={!status?.connected} className="text-red-400 hover:bg-red-500/10">
                <X size={16} />
                Sair desta conta
              </Button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 border-b border-white/8 py-2 text-sm font-bold last:border-b-0">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[var(--mail-primary)]"
      />
    </label>
  );
}

function AttachmentPreview({ attachments, onRemove }: { attachments: ComposeAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="grid max-h-44 gap-2 overflow-y-auto border-t border-white/10 p-3">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="mail-card flex items-center justify-between rounded-lg border border-white/10 bg-[#101014] p-2">
          <div className="flex min-w-0 items-center gap-3">
            {isImage(attachment.mimeType) ? (
              <img src={attachment.dataUrl} alt={attachment.fileName} className="h-12 w-12 rounded-md object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-white/8">
                <FileText size={18} />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{attachment.fileName}</p>
              <p className="text-xs font-semibold text-white/45">{formatBytes(attachment.size)}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={() => onRemove(attachment.id)} className="text-white/55 hover:bg-white/7">
            <X size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
