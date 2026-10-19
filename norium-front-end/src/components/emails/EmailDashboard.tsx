import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  FileText,
  Inbox,
  Mail,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
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
import type { EmailCategoryKey, InboxCategoryKey } from "../../features/mail/formatters";
import {
  classifyEmailCategory,
  inboxCategoryQuery,
  inboxCategoryUnreadCounts,
} from "../../features/mail/formatters";
import { useGmailConnection } from "../../features/mail/hooks/useGmailConnection";
import { useMailbox } from "../../features/mail/hooks/useMailbox";
import { useMessageDetail } from "../../features/mail/hooks/useMessageDetail";
import { useCompose } from "../../features/mail/hooks/useCompose";
import { useMailPreferences } from "../../features/mail/hooks/useMailPreferences";
import { useNoraMail } from "../../features/mail/hooks/useNoraMail";
import IntegrationLogo from "../shared/IntegrationLogo";
import LabelDialog from "./modals/LabelDialog";
import MailSidebar from "./MailSidebar";
import MailMessageDetail from "./MailMessageDetail";
import MailMessageList from "./MailMessageList";
import MailReplyBox from "./MailReplyBox";
import NoraSuggestionPanel from "./NoraSuggestionPanel";
import MailToolbar from "./MailToolbar";
import ComposeModal from "./modals/ComposeModal";
import NoraMailDrawer from "./modals/NoraMailDrawer";
import NoraMailWork from "../nora/NoraMailWork";
import MailSettingsDrawer from "./modals/MailSettingsDrawer";
import ProfilePopover from "./modals/ProfilePopover";
import "./emails.css";
export type { Email } from "../../features/mail/types";


const systemFolders: Array<{ key: string; label: string; icon: LucideIcon; countLabel?: string }> = [
  { key: "inbox", label: "Caixa de entrada", icon: Inbox, countLabel: "INBOX" },
  { key: "drafts", label: "Rascunhos", icon: FileText, countLabel: "DRAFT" },
  { key: "scheduled", label: "Agendado", icon: Clock3 },
  { key: "sent", label: "Enviado", icon: Send, countLabel: "SENT" },
  { key: "spam", label: "Spam", icon: ShieldAlert, countLabel: "SPAM" },
  { key: "trash", label: "Lixo", icon: Trash2, countLabel: "TRASH" },
];



type EmailDashboardProps = {
  active?: boolean;
  userId?: string;
  canUseNora?: boolean;
  selectedEmailId?: string | null;
  onSelectedEmailHandled?: () => void;
};

export default function EmailDashboard({ active = true, userId = "primary", canUseNora = true, selectedEmailId, onSelectedEmailHandled }: EmailDashboardProps) {
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [activeInboxCategory, setActiveInboxCategory] = useState<InboxCategoryKey>("principal");
  const [activeFilter, setActiveFilter] = useState<MailQuickFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [messageFullscreen, setMessageFullscreen] = useState(false);
  const { preferences, setPreference } = useMailPreferences();
  const { autoRefresh, showPreview, compactMode, groupByCategory } = preferences;
  const aiScrollRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);


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
    connecting: gmailConnecting,
    fetchStatus,
    fetchLabels,
    connect: connectGmail,
    disconnect: disconnectGmail,
  } = useGmailConnection({ active, userId, onError: setError, onDisconnected: handleDisconnected });

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

  const mailboxSearchQuery = useMemo(() => {
    if (activeFolder !== "inbox") return searchQuery;
    return [inboxCategoryQuery(activeInboxCategory), searchQuery].filter(Boolean).join(" ");
  }, [activeFolder, activeInboxCategory, searchQuery]);

  const {
    messages,
    setMessages,
    nextPageToken,
    resultSize,
    loading,
    fetchMessages,
    syncMailbox,
    refreshFirstPage,
    syncState,
    prefetchMailbox,
    currentMailboxKey,
    cacheRef: mailboxCacheRef,
  } = useMailbox({
    userId,
    folder: activeFolder,
    filter: activeFilter,
    searchQuery: mailboxSearchQuery,
    connected: active && Boolean(status?.connected),
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
    detailError,
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
    onRefreshMessages: () => void refreshFirstPage(),
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
    onMailSent: () => void refreshFirstPage(),
    onApplySuggestion: (target, text) => {
      if (target === "reply") setReplyText(text);
      else setCompose((prev) => ({ ...prev, body: text }));
    },
  });

  const labelById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);
  const userLabels = labels.filter((label) => label.type === "user").slice(0, 14);
  const inboxCategoryCounts = useMemo(() => inboxCategoryUnreadCounts(labels), [labels]);
  const groupedMessages = useMemo(() => {
    const groups = new Map<EmailCategoryKey, GmailMessage[]>();
    messages.forEach((message) => {
      const category = classifyEmailCategory(message);
      groups.set(category, [...(groups.get(category) || []), message]);
    });
    return Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [messages]);

  useEffect(() => {
    setSelectedMessage(null);
    setSelectedIds(new Set());
  }, [userId]);


  useEffect(() => {
    if (!active) return;
    void fetchStatus().catch((err) => setError(err instanceof Error ? err.message : "Falha ao checar Gmail."));
  }, [active, fetchStatus]);

  useEffect(() => {
    if (!active || !status?.connected) return;
    void fetchLabels().catch(() => undefined);
  }, [active, fetchLabels, status?.connected]);

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
    if (folder === "inbox") setActiveInboxCategory("principal");
    setActiveFilter("all");
    setSearchDraft("");
    setSearchQuery("");
    setAdvancedFilters(emptyAdvancedFilters);
    setFiltersOpen(false);
    setMobileSidebarOpen(false);
  }

  function selectInboxCategory(category: InboxCategoryKey) {
    if (category === activeInboxCategory) return;
    setActiveInboxCategory(category);
    setSelectedMessage(null);
    setSelectedIds(new Set());
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
      setError(err instanceof Error ? err.message : "Não foi possível criar o marcador.");
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
    ? "Não lidos"
    : activeFolder.startsWith("label:")
      ? labelById.get(activeFolder.split(":", 2)[1])?.name || "Marcador"
      : systemFolders.find((folder) => folder.key === activeFolder)?.label || "Caixa De Entrada";
  const visibleUnreadCount = activeFolder === "inbox"
    ? inboxCategoryCounts[activeInboxCategory]
    : messages.filter((message) => message.unread).length;


  return (
    <div className={`norium-mail nx-mail ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} ${selectedMessage ? "mail-message-open" : ""} relative flex h-full min-h-0 w-full overflow-hidden`}>
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
        onClose={() => setMobileSidebarOpen(false)}
      />

      <section className="mail-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MailToolbar
          onCompose={() => setComposeOpen(true)}
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
          sync={syncState}
          onOpenNora={() => {
            setAiOpen(true);
            if (!aiMessages.length) void askEmailAgent("resumir minha caixa de entrada");
          }}
          onTogglePreview={() => setPreference("showPreview", !showPreview)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleProfile={() => setProfileOpen((value) => !value)}
        />

        {canUseNora && status?.connected && (
          <div className="nx-mail-work-bar">
            <button type="button" className={`nx-btn is-sm${workOpen ? " is-active" : ""}`} aria-expanded={workOpen} onClick={() => setWorkOpen(!workOpen)}>
              <Sparkles size={14} />
              Nora: caixa completa, relatórios e campanhas
            </button>
          </div>
        )}
        {canUseNora && status?.connected && workOpen && <NoraMailWork identity={userId} />}
        {!status?.connected ? (
          <main className="nx-mail-connect">
            <div className="nx-card">
              <div className="nx-mail-connect-logo">
                <IntegrationLogo name="Gmail" size={30} />
              </div>
              <h1>Conectar Gmail</h1>
              <p>
                O Norium Mail precisa de permissão do Google para listar, ler, marcar, responder e enviar e-mails pela sua conta.
              </p>
              {error && <p className="nx-mail-error" role="alert">{error}</p>}
              <div className="nx-mail-connect-actions">
                <button type="button" className="nx-btn is-primary"
                  onClick={() => void connectGmail()}
                  disabled={gmailConnecting}
                >
                  <Mail size={16} />
                  {gmailConnecting ? "Abrindo Google..." : "Conectar Gmail"}
                </button>
                <button type="button" className="nx-btn"
                  onClick={() => void fetchStatus()}
                >
                  <RefreshCw size={16} />
                  Já autorizei
                </button>
              </div>
            </div>
          </main>
        ) : (
          <main className="nx-mail-body">
            <MailMessageList
              title={mailboxTitle}
              unreadCount={visibleUnreadCount}
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
              groupByCategory={activeFolder === "inbox" ? false : groupByCategory}
              showInboxCategories={activeFolder === "inbox"}
              activeInboxCategory={activeInboxCategory}
              inboxCategoryCounts={inboxCategoryCounts}
              onInboxCategoryChange={selectInboxCategory}
              onRefresh={() => void syncMailbox()}
              onNextPage={() => void fetchMessages(true, nextPageToken)}
              syncActive={syncState.active}
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
                setPreference("groupByCategory", next);
                if (next && canUseNora) void askEmailAgent("agrupar e-mails por categoria");
              }}
              onOpenFilters={() => setFiltersOpen(true)}
              onAskNora={() => void askEmailAgent("resumir minha caixa de entrada")}
            />

            {selectedMessage && (
              <MailMessageDetail
                message={selectedMessage}
                labelById={labelById}
                loading={detailLoading}
                error={detailError}
                onRetry={() => void openMessage(selectedMessage)}
                fullscreen={messageFullscreen}
                menuOpen={messageMenuOpen}
                scrollRef={messageScrollRef}
                replyBox={(
                  <MailReplyBox
                    key={selectedMessage.id}
                    templateVariables={{ sender_name: status?.name || "", client_name: selectedMessage.fromEmail.toLowerCase() !== status?.email?.toLowerCase() ? selectedMessage.fromName : "", nome: selectedMessage.fromEmail.toLowerCase() !== status?.email?.toLowerCase() ? selectedMessage.fromName : "" }}
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
                )}
                onClose={() => setSelectedMessage(null)}
                onToggleFullscreen={() => {
                  setMessageFullscreen((value) => !value);
                  setMessageMenuOpen(false);
                }}
                onToggleMenu={() => setMessageMenuOpen((value) => !value)}
                onAction={(action, closeAfter) => void runMessageAction(selectedMessage.id, action, closeAfter)}
                onDownloadAttachment={(url, fileName) => void downloadWithAuth(url, fileName)}
              />
            )}
          </main>
        )}
      </section>

      {composeOpen && (
        <ComposeModal
          templateVariables={{ sender_name: status?.name || "" }}
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
          preferences={preferences}
          status={status}
          connecting={gmailConnecting}
          onPreferenceChange={setPreference}
          onRefreshNow={() => void fetchMessages(false)}
          onConnect={() => {
            setSettingsOpen(false);
            void connectGmail();
          }}
          onDisconnect={() => void disconnectGmail()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {profileOpen && (
        <ProfilePopover
          status={status}
          connecting={gmailConnecting}
          onClose={() => setProfileOpen(false)}
          onOpenSettings={() => { setSettingsOpen(true); setProfileOpen(false); }}
          onRefresh={() => void fetchStatus()}
          onConnect={() => {
            setProfileOpen(false);
            void connectGmail();
          }}
          onDisconnect={() => void disconnectGmail()}
        />
      )}
    </div>
  );
}


