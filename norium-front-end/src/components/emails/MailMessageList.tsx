import { useRef } from "react";
import { Archive, BellRing, Check, ChevronLeft, ChevronRight, Filter, Inbox, Loader2, MailOpen, Megaphone, RefreshCw, Tags, Trash2, UsersRound } from "lucide-react";
import { cn } from "../../utils/cn";
import NoraAvatar from "../layout/NoraAvatar";
import MailMessageRow from "./MailMessageRow";
import { mailCategoryBadge } from "./mailCategoryTone";
import { emailCategoryMeta, inboxCategoryMeta, type EmailCategoryKey, type InboxCategoryKey } from "../../features/mail/formatters";
import { GMAIL_PAGE_SIZE } from "../../features/mail/queryBuilder";
import { quickFilters, type GmailMessage, type MailQuickFilter } from "../../features/mail/types";

/** Rotulos exibidos dos filtros rapidos (pt-BR com acentuacao). */
const quickFilterLabels: Record<MailQuickFilter, string> = {
  all: "Todo o correio",
  unread: "Não lidos",
  read: "Lidos",
  starred: "Com estrela",
};

type MailMessageListProps = {
  title: string;
  unreadCount: number;
  autoRefresh: boolean;
  loading: boolean;
  error: string;
  canUseNora: boolean;

  messages: GmailMessage[];
  groupedMessages: Array<[EmailCategoryKey, GmailMessage[]]>;
  selectedIds: Set<string>;
  selectedMessageId?: string | null;
  visibleRange: string;
  resultSize: number;
  nextPageToken: string | null;

  activeFilter: MailQuickFilter;
  compactMode: boolean;
  showPreview: boolean;
  groupByCategory: boolean;
  showInboxCategories: boolean;
  activeInboxCategory: InboxCategoryKey;
  inboxCategoryCounts: Record<InboxCategoryKey, number>;

  onRefresh: () => void;
  onNextPage: () => void;
  syncActive: boolean;
  onFilterChange: (filter: MailQuickFilter) => void;
  onToggleSelectAll: () => void;
  onToggleSelectOne: (id: string) => void;
  onToggleStar: (message: GmailMessage) => void;
  onOpenMessage: (message: GmailMessage) => void;
  onBulkAction: (action: string) => void;
  onToggleGroupByCategory: () => void;
  onInboxCategoryChange: (category: InboxCategoryKey) => void;
  onOpenFilters: () => void;
  onAskNora: () => void;
};

/** Coluna da lista: cabecalho da caixa, categorias, filtros rapidos, acoes em lote e mensagens. */
export default function MailMessageList({
  title,
  unreadCount,
  autoRefresh,
  loading,
  error,
  canUseNora,
  messages,
  groupedMessages,
  selectedIds,
  selectedMessageId,
  visibleRange,
  resultSize,
  nextPageToken,
  activeFilter,
  compactMode,
  showPreview,
  groupByCategory,
  showInboxCategories,
  activeInboxCategory,
  inboxCategoryCounts,
  onRefresh,
  onNextPage,
  syncActive,
  onFilterChange,
  onToggleSelectAll,
  onToggleSelectOne,
  onToggleStar,
  onOpenMessage,
  onBulkAction,
  onToggleGroupByCategory,
  onInboxCategoryChange,
  onOpenFilters,
  onAskNora,
}: MailMessageListProps) {
  const allSelected = messages.length > 0 && selectedIds.size === messages.length;
  const listScrollRef = useRef<HTMLDivElement>(null);
  const inboxCategoryIcons = {
    principal: Inbox,
    promocoes: Megaphone,
    social: UsersRound,
    atualizacoes: BellRing,
  } as const;

  const row = (message: GmailMessage) => (
    <MailMessageRow
      key={message.id}
      message={message}
      selected={selectedMessageId === message.id}
      checked={selectedIds.has(message.id)}
      compactMode={compactMode}
      showPreview={showPreview}
      groupByCategory={groupByCategory}
      onOpen={() => onOpenMessage(message)}
      onToggleCheck={() => onToggleSelectOne(message.id)}
      onToggleStar={() => onToggleStar(message)}
    />
  );

  return (
    <div className="mail-message-list">
      <div className="nx-mail-list-head">
        <div className="nx-mail-list-title">
          <div>
            <h1>{title}</h1>
            <p>
              {unreadCount} {unreadCount === 1 ? "não lido" : "não lidos"}{showInboxCategories ? ` em ${inboxCategoryMeta[activeInboxCategory].label}` : ""} · {autoRefresh ? "sincronização em tempo real a cada 45s" : "atualização manual"}
            </p>
          </div>

          <div className="nx-mail-pager">
            <button type="button" onClick={onRefresh} className="nx-mail-iconbtn" aria-label="Atualizar lista" title="Atualizar lista">
              {loading ? <Loader2 size={15} className="nx-mail-spin" /> : <RefreshCw size={15} />}
            </button>
            <span>
              {visibleRange} / {resultSize || messages.length}{syncActive ? " · sincronizando…" : ""}
            </span>
            <button
              type="button"
              disabled={messages.length <= GMAIL_PAGE_SIZE}
              onClick={() => listScrollRef.current?.scrollTo?.({ top: 0 })}
              title="Voltar ao início"
              className="nx-mail-iconbtn"
              aria-label="Voltar ao início"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              disabled={!nextPageToken || syncActive}
              onClick={onNextPage}
              className="nx-mail-iconbtn"
              title="Próxima página"
              aria-label="Próxima página"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        {showInboxCategories && (
          <nav className="nx-tabs nx-mail-cats" aria-label="Categorias da caixa de entrada" role="tablist">
            {(Object.keys(inboxCategoryMeta) as InboxCategoryKey[]).map((category) => {
              const meta = inboxCategoryMeta[category];
              const Icon = inboxCategoryIcons[category];
              const unread = inboxCategoryCounts[category];
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={activeInboxCategory === category}
                  aria-label={`${meta.label}${unread > 0 ? ` ${unread} ${unread === 1 ? "novo" : "novos"}` : ""}`}
                  title={meta.description}
                  className={cn("nx-tab", activeInboxCategory === category && "is-active")}
                  onClick={() => onInboxCategoryChange(category)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{meta.label}</span>
                  {unread > 0 && <b aria-hidden="true">{unread}</b>}
                </button>
              );
            })}
          </nav>
        )}
      </div>

      <div className={cn("nx-mail-filters", !showInboxCategories && "mt-3 border-t border-[var(--nx-border)]")}>
        <button
          type="button"
          onClick={onToggleSelectAll}
          aria-label="Selecionar todos"
          aria-pressed={allSelected}
          className={cn("nx-mail-check", allSelected && "is-checked")}
        >
          {allSelected && <Check size={12} />}
        </button>

        <div className="nx-seg nx-mail-seg">
          {quickFilters.map((filter) => (
            <button
              type="button"
              key={filter.key}
              aria-pressed={activeFilter === filter.key}
              onClick={() => onFilterChange(filter.key)}
              className={cn(activeFilter === filter.key && "is-active")}
            >
              {quickFilterLabels[filter.key] || filter.label}
            </button>
          ))}
        </div>

        <div className="nx-mail-filter-actions">
          {selectedIds.size > 0 && (
            <>
              <button type="button" onClick={() => onBulkAction("archive")} className="nx-btn is-sm">
                <Archive size={14} />
                Arquivar
              </button>
              <button type="button" onClick={() => onBulkAction("trash")} className="nx-btn is-sm">
                <Trash2 size={14} />
                Lixeira
              </button>
            </>
          )}
          {!showInboxCategories && (
            <button
              type="button"
              onClick={onToggleGroupByCategory}
              aria-pressed={groupByCategory}
              className={cn("nx-btn is-sm", groupByCategory && "is-active")}
            >
              <Tags size={14} />
              Agrupar categorias
            </button>
          )}
          <button type="button" onClick={onOpenFilters} className="nx-btn is-sm">
            <Filter size={14} />
            Filtros
          </button>
        </div>
      </div>

      {canUseNora && (
        <div className="nx-mail-nora-tip">
          <NoraAvatar className="rounded-full" />
          <span>A Nora agora está na sua caixa de entrada. Elabore, resuma e responda de forma mais inteligente.</span>
          <button type="button" onClick={onAskNora} className="nx-btn is-sm is-primary">
            Experimente
          </button>
        </div>
      )}

      {!showInboxCategories && !groupByCategory && groupedMessages.length > 0 && (
        <div className="nx-mail-quick-cats" aria-label="Categorias do e-mail">
          {groupedMessages.slice(0, 3).map(([category, items]) => {
            const meta = emailCategoryMeta[category];
            return (
              <button key={category} type="button" onClick={onToggleGroupByCategory}>
                <span className={cn("nx-badge", mailCategoryBadge[category])}><Tags size={12} />{meta.label}</span>
                <span>{items.length} e-mail(s)</span>
                <b>+{items.length}</b>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="nx-mail-error" role="alert">{error}</div>
      )}

      <div ref={listScrollRef} className="nx-mail-scroll">
        {loading && !messages.length ? (
          <div className="nx-mail-state" role="status">
            <Loader2 size={18} className="nx-mail-spin" />
            Sincronizando Gmail...
          </div>
        ) : messages.length ? (
          groupByCategory ? (
            <div>
              {groupedMessages.map(([category, items]) => {
                const meta = emailCategoryMeta[category];
                return (
                  <section key={category}>
                    <div className="nx-mail-group-h">
                      <span className={cn("nx-badge", mailCategoryBadge[category])}>
                        <Tags size={12} />
                        {meta.label}
                      </span>
                      <span>{items.length} e-mail(s)</span>
                    </div>
                    {items.map(row)}
                  </section>
                );
              })}
            </div>
          ) : (
            messages.map(row)
          )
        ) : (
          <div className="nx-mail-state">
            <MailOpen size={28} strokeWidth={1.5} />
            <p>
              {showInboxCategories
                ? `Nenhum e-mail em ${inboxCategoryMeta[activeInboxCategory].label}.`
                : "Nenhum e-mail encontrado nesse filtro."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
