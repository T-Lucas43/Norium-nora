import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronLeft,
  Clock3,
  Download,
  FileText,
  Image,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  MailOpen,
  Maximize2,
  Minimize2,
  MoreVertical,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { downloadWithAuth } from "../../utils/download";
import { mailApiRequest as apiJson } from "../../features/mail/api";
import type {
  GmailMessage,
  MailQuickFilter,
  MessageListResponse,
} from "../../features/mail/types";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";
import {
  buildGmailSearchQuery,
  emptyAdvancedFilters,
} from "../../features/mail/queryBuilder";
import type { EmailCategoryKey } from "../../features/mail/formatters";
import {
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
import MailSidebar from "./MailSidebar";
import MailMessageList from "./MailMessageList";
import MailReplyBox from "./MailReplyBox";
import NoraSuggestionPanel from "./NoraSuggestionPanel";
import MailToolbar from "./MailToolbar";
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
      <NoraSuggestionPanel
        text={noraSuggestion.text}
        instruction={noraSuggestionInstruction}
        busy={noraSuggesting !== null}
        onTextChange={(value) => setNoraSuggestion((current) => (current ? { ...current, text: value } : current))}
        onInstructionChange={setNoraSuggestionInstruction}
        onAccept={acceptNoraSuggestion}
        onDiscard={discardNoraSuggestion}
        onRegenerate={(instruction) => void askNoraEmailSuggestion(target, instruction)}
      />
    );
  }

  const visibleRange = messages.length ? `1-${messages.length}` : "0";
  const mailboxTitle = activeFilter === "unread"
    ? "Nao lidos"
    : activeFolder.startsWith("label:")
      ? labelById.get(activeFolder.split(":", 2)[1])?.name || "Marcador"
      : systemFolders.find((folder) => folder.key === activeFolder)?.label || "Caixa De Entrada";
  const selectedCategory = selectedMessage ? emailCategoryMeta[classifyEmailCategory(selectedMessage)] : null;
  const selectedLabels = selectedMessage
    ? (selectedMessage.labels || [])
        .map((label) => friendlyGmailLabel(labelById.get(label)?.name || label))
        .filter((label) => !["Caixa de entrada", "Nao lido", "Com estrela", "Importante"].includes(label))
        .filter((label) => !selectedCategory || normalizeText(label) !== normalizeText(selectedCategory.label))
        .slice(0, 10)
    : [];


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
      <MailSidebar
        systemFolders={systemFolders}
        userLabels={userLabels}
        labelById={labelById}
        activeFolder={activeFolder}
        activeFilter={activeFilter}
        onSelectMailbox={selectMailbox}
        onPrefetchMailbox={(folder) => void prefetchMailbox(folder)}
        onCompose={() => setComposeOpen(true)}
        onCreateLabel={() => setLabelDialogOpen(true)}
        onRefreshLabels={() => void fetchLabels()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <section className="mail-main flex min-w-0 flex-1 flex-col bg-[#151518]">
        <MailToolbar
          status={status}
          canUseNora={canUseNora}
          searchDraft={searchDraft}
          filtersOpen={filtersOpen}
          advancedFilters={advancedFilters}
          onSearchDraftChange={setSearchDraft}
          onApplySearch={applyAdvancedSearch}
          onClearSearch={clearAdvancedSearch}
          onToggleFilters={() => setFiltersOpen((value) => !value)}
          onCloseFilters={() => setFiltersOpen(false)}
          onAdvancedFiltersChange={setAdvancedFilters}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          onOpenNora={() => {
            setAiOpen(true);
            if (!aiMessages.length) void askEmailAgent("resumir minha caixa de entrada");
          }}
          onTogglePreview={() => setShowPreview((value) => !value)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleProfile={() => setProfileOpen((value) => !value)}
        />

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
            <MailMessageList
              title={mailboxTitle}
              unreadCount={inboxUnread}
              autoRefresh={autoRefresh}
              loading={loading}
              error={error}
              canUseNora={canUseNora}
              messages={messages}
              groupedMessages={groupedMessages}
              selectedIds={selectedIds}
              selectedMessageId={selectedMessage?.id}
              visibleRange={visibleRange}
              resultSize={resultSize}
              nextPageToken={nextPageToken}
              activeFilter={activeFilter}
              compactMode={compactMode}
              showPreview={showPreview}
              groupByCategory={groupByCategory}
              onRefresh={() => void fetchMessages(false)}
              onFirstPage={() => void fetchMessages(false, null)}
              onNextPage={() => void fetchMessages(true, nextPageToken)}
              onFilterChange={setActiveFilter}
              onToggleSelectAll={() => setSelectedIds((prev) => (prev.size === messages.length ? new Set() : new Set(messages.map((m) => m.id))))}
              onToggleSelectOne={(id) => setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })}
              onToggleStar={(message) => void runMessageAction(message.id, message.starred ? "unstar" : "star")}
              onOpenMessage={(message) => void openMessage(message)}
              onBulkAction={(action) => void runBulkAction(action)}
              onToggleGroupByCategory={() => {
                const next = !groupByCategory;
                setGroupByCategory(next);
                if (next && canUseNora) void askEmailAgent("agrupar e-mails por categoria");
              }}
              onOpenFilters={() => setFiltersOpen(true)}
              onAskNora={() => void askEmailAgent("resumir minha caixa de entrada")}
            />

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

                      <MailReplyBox
                        text={replyText}
                        attachments={replyAttachments}
                        sending={sending}
                        canUseNora={canUseNora}
                        noraSuggesting={noraSuggesting}
                        suggestionPanel={renderNoraSuggestionPanel("reply")}
                        onTextChange={setReplyText}
                        onAddFiles={(files) => void addFiles(files, "reply")}
                        onRemoveAttachment={(id) => setReplyAttachments((prev) => prev.filter((a) => a.id !== id))}
                        onAskNora={() => void askNoraEmailSuggestion("reply")}
                        onSend={() => void sendReply()}
                      />
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


