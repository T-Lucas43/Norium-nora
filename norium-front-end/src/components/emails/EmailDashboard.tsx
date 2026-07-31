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
  GmailMessage,
  MailQuickFilter,
  MessageListResponse,
} from "../../features/mail/types";
import { quickFilters } from "../../features/mail/types";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";
import {
  GMAIL_PAGE_SIZE,
  buildGmailSearchQuery,
  emptyAdvancedFilters,
} from "../../features/mail/queryBuilder";
import type { EmailCategoryKey } from "../../features/mail/formatters";
import {
  accountInitials,
  classifyEmailCategory,
  emailCategoryMeta,
  formatBytes,
  friendlyGmailLabel,
  initials,
  isImage,
  normalizeText,
} from "../../features/mail/formatters";
import { useGmailConnection } from "../../features/mail/hooks/useGmailConnection";
import { useMailbox } from "../../features/mail/hooks/useMailbox";
import { useMessageDetail } from "../../features/mail/hooks/useMessageDetail";
import { useCompose } from "../../features/mail/hooks/useCompose";
import { useNoraMail } from "../../features/mail/hooks/useNoraMail";
import Button from "../shared/Button";
import LabelDialog from "./modals/LabelDialog";
import AttachmentPreview from "./AttachmentPreview";
import ComposeModal from "./modals/ComposeModal";
import NoraMailDrawer from "./modals/NoraMailDrawer";
import MailSettingsDrawer from "./modals/MailSettingsDrawer";
import ProfilePopover from "./modals/ProfilePopover";
export type { Email } from "../../features/mail/types";


const systemFolders: Array<{ key: string; label: string; icon: LucideIcon; countLabel?: string }> = [
  { key: "inbox", label: "Caixa de entrada", icon: Inbox, countLabel: "INBOX" },
  { key: "drafts", label: "Rascunhos", icon: FileText, countLabel: "DRAFT" },
  { key: "scheduled", label: "Agendado", icon: Clock3 },
  { key: "sent", label: "Enviado", icon: Send, countLabel: "SENT" },
  { key: "spam", label: "Spam", icon: ShieldAlert, countLabel: "SPAM" },
  { key: "trash", label: "Lixo", icon: Trash2, countLabel: "TRASH" },
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function PortalWhen({ active, children }: { active: boolean; children: ReactNode }) {
  if (active && typeof document !== "undefined") return createPortal(children, document.body);
  return children;
}

type EmailDashboardProps = {
  userId?: string;
  canUseNora?: boolean;
  selectedEmailId?: string | null;
  onSelectedEmailHandled?: () => void;
};

export default function EmailDashboard({ userId = "lucas123", canUseNora = true, selectedEmailId, onSelectedEmailHandled }: EmailDashboardProps) {
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [activeFilter, setActiveFilter] = useState<MailQuickFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
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
  const preferencesLoadedRef = useRef(false);


  const handleDisconnected = useCallback(() => {
    setMessages([]);
    setSelectedIds(new Set());
    setSelectedMessage(null);
    setProfileOpen(false);
    setSettingsOpen(false);
  }, []);

  const {
    status,
    setStatus,
    labels,
    fetchStatus,
    fetchLabels,
    connect: connectGmail,
    disconnect: disconnectGmail,
  } = useGmailConnection({ userId, onError: setError, onDisconnected: handleDisconnected });

  const handleMailboxChanged = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedMessage(null);
  }, []);

  const handleStatusPayload = useCallback((data: MessageListResponse) => {
    setStatus((prev) => ({ ...(prev || data), ...data }));
  }, [setStatus]);

  const handleRefreshLabels = useCallback(() => {
    void fetchLabels().catch(() => undefined);
  }, [fetchLabels]);

  const {
    messages,
    setMessages,
    nextPageToken,
    resultSize,
    loading,
    fetchMessages,
    prefetchMailbox,
    currentMailboxKey,
    cacheRef: mailboxCacheRef,
  } = useMailbox({
    userId,
    folder: activeFolder,
    filter: activeFilter,
    searchQuery,
    connected: Boolean(status?.connected),
    autoRefresh,
    onError: setError,
    onStatusPayload: handleStatusPayload,
    onRefreshLabels: handleRefreshLabels,
    onMailboxChanged: handleMailboxChanged,
  });

  const {
    selectedMessage,
    setSelectedMessage,
    selectedIds,
    setSelectedIds,
    detailLoading,
    openMessage,
    openMessageById,
    runMessageAction,
    runBulkAction,
  } = useMessageDetail({
    userId,
    messages,
    setMessages,
    currentMailboxKey,
    cacheRef: mailboxCacheRef,
    onError: setError,
    onRefreshMessages: () => void fetchMessages(false),
    onRefreshLabels: handleRefreshLabels,
    onActionStart: () => setMessageMenuOpen(false),
  });

  const {
    composeOpen,
    setComposeOpen,
    compose,
    setCompose,
    replyText,
    setReplyText,
    replyAttachments,
    setReplyAttachments,
    sending,
    addFiles,
    sendEmail,
    sendReply,
  } = useCompose({
    userId,
    selectedMessage,
    onError: setError,
    onSent: (folder) => selectMailbox(folder),
    onClearSuggestion: (target) => {
      setNoraSuggestion((current) => (current?.target === target ? null : current));
      setNoraSuggestionInstruction("");
    },
  });

  const {
    aiOpen,
    setAiOpen,
    aiInput,
    setAiInput,
    aiMessages,
    aiLoading,
    noraSuggesting,
    noraSuggestion,
    setNoraSuggestion,
    noraSuggestionInstruction,
    setNoraSuggestionInstruction,
    askEmailAgent,
    askContextualAssistant: askContextualEmailAssistant,
    askSuggestion: askNoraEmailSuggestion,
    acceptSuggestion: acceptNoraSuggestion,
    discardSuggestion: discardNoraSuggestion,
  } = useNoraMail({
    userId,
    canUseNora,
    selectedMessage,
    compose,
    replyText,
    onError: setError,
    onMailSent: () => void fetchMessages(false),
    onApplySuggestion: (target, text) => {
      if (target === "reply") setReplyText(text);
      else setCompose((prev) => ({ ...prev, body: text }));
    },
  });

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
    setSelectedMessage(null);
    setSelectedIds(new Set());
  }, [userId]);


  useEffect(() => {
    void fetchStatus().catch((err) => setError(err instanceof Error ? err.message : "Falha ao checar Gmail."));
  }, [fetchStatus]);

  useEffect(() => {
    if (!status?.connected) return;
    void fetchLabels().catch(() => undefined);
  }, [fetchLabels, status?.connected]);

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
        <ComposeModal
          compose={compose}
          sending={sending}
          canUseNora={canUseNora}
          noraSuggesting={noraSuggesting}
          suggestionPanel={renderNoraSuggestionPanel("compose")}
          onChange={setCompose}
          onAddFiles={(files) => void addFiles(files, "compose")}
          onRemoveAttachment={(id) => setCompose((prev) => ({ ...prev, attachments: prev.attachments.filter((a) => a.id !== id) }))}
          onAskNora={() => void askNoraEmailSuggestion("compose")}
          onSaveDraft={() => void sendEmail(true)}
          onSend={() => void sendEmail(false)}
          onClose={() => {
            setComposeOpen(false);
            setNoraSuggestion((current) => (current?.target === "compose" ? null : current));
            setNoraSuggestionInstruction("");
          }}
        />
      )}

      {canUseNora && aiOpen && (
        <NoraMailDrawer
          selectedMessage={selectedMessage}
          messages={aiMessages}
          loading={aiLoading}
          input={aiInput}
          scrollRef={aiScrollRef}
          onInputChange={setAiInput}
          onSend={() => void askEmailAgent()}
          onSummarize={() => void askContextualEmailAssistant("summary")}
          onNextAction={() => void askContextualEmailAssistant("next")}
          onSuggestReply={() => { setAiOpen(false); void askNoraEmailSuggestion("reply"); }}
          onListUnread={() => void askEmailAgent("listar e-mails nao lidos")}
          onSummarizeInbox={() => void askEmailAgent("resumir minha caixa de entrada")}
          onCompose={() => { setAiOpen(false); setComposeOpen(true); }}
          onClose={() => setAiOpen(false)}
        />
      )}

      {labelDialogOpen && (
        <LabelDialog
          name={newLabelName}
          saving={labelSaving}
          onNameChange={setNewLabelName}
          onSubmit={() => void createLabel()}
          onClose={() => {
            setLabelDialogOpen(false);
            setNewLabelName("");
          }}
        />
      )}

      {settingsOpen && (
        <MailSettingsDrawer
          preferences={{ compactMode, groupByCategory, showPreview, autoRefresh }}
          status={status}
          onPreferenceChange={(key, value) => {
            if (key === "compactMode") setCompactMode(value as boolean);
            else if (key === "groupByCategory") setGroupByCategory(value as boolean);
            else if (key === "showPreview") setShowPreview(value as boolean);
            else setAutoRefresh(value as boolean);
          }}
          onRefreshNow={() => void fetchMessages(false)}
          onConnect={() => void connectGmail()}
          onDisconnect={() => void disconnectGmail()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {profileOpen && (
        <ProfilePopover
          status={status}
          onClose={() => setProfileOpen(false)}
          onOpenSettings={() => { setSettingsOpen(true); setProfileOpen(false); }}
          onRefresh={() => void fetchStatus()}
          onConnect={() => void connectGmail()}
          onDisconnect={() => void disconnectGmail()}
        />
      )}
    </div>
  );
}


