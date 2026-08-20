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
import type { EmailCategoryKey } from "../../features/mail/formatters";
import {
  classifyEmailCategory,
} from "../../features/mail/formatters";
import { useGmailConnection } from "../../features/mail/hooks/useGmailConnection";
import { useMailbox } from "../../features/mail/hooks/useMailbox";
import { useMessageDetail } from "../../features/mail/hooks/useMessageDetail";
import { useCompose } from "../../features/mail/hooks/useCompose";
import { useMailPreferences } from "../../features/mail/hooks/useMailPreferences";
import { useNoraMail } from "../../features/mail/hooks/useNoraMail";
import Button from "../shared/Button";
import LabelDialog from "./modals/LabelDialog";
import MailSidebar from "./MailSidebar";
import MailMessageDetail from "./MailMessageDetail";
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



type EmailDashboardProps = {
  userId?: string;
  canUseNora?: boolean;
  selectedEmailId?: string | null;
  onSelectedEmailHandled?: () => void;
};

export default function EmailDashboard({ userId = "primary", canUseNora = true, selectedEmailId, onSelectedEmailHandled }: EmailDashboardProps) {
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


  return (
    <div className={`norium-mail ${mobileSidebarOpen ? "mobile-sidebar-open" : ""} ${selectedMessage ? "mail-message-open" : ""} flex h-full min-h-0 w-full overflow-hidden bg-[#111113] text-white`}>
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
          onTogglePreview={() => setPreference("showPreview", !showPreview)}
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
                fullscreen={messageFullscreen}
                menuOpen={messageMenuOpen}
                scrollRef={messageScrollRef}
                replyBox={(
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
          onPreferenceChange={setPreference}
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


