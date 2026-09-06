import { BellRing, Bot, Check, ChevronLeft, ChevronRight, Filter, Inbox, Loader2, MailOpen, Megaphone, RefreshCw, Tags, UsersRound } from "lucide-react";
import Button from "../shared/Button";
import { cn } from "../../utils/cn";
import MailMessageRow from "./MailMessageRow";
import { emailCategoryMeta, inboxCategoryMeta, type EmailCategoryKey, type InboxCategoryKey } from "../../features/mail/formatters";
import { GMAIL_PAGE_SIZE } from "../../features/mail/queryBuilder";
import { quickFilters, type GmailMessage, type MailQuickFilter } from "../../features/mail/types";

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
  onFirstPage: () => void;
  onNextPage: () => void;
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

/** Coluna central: cabecalho da caixa, filtros rapidos, acoes em lote e a lista. */
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
  onFirstPage,
  onNextPage,
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
    <div className="mail-message-list flex min-w-0 flex-1 flex-col">
      <div className="mail-list-heading flex h-[104px] shrink-0 items-center justify-between px-4">
        <div>
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="mt-1 text-xs font-semibold text-white/45">
            {unreadCount} {unreadCount === 1 ? "não lido" : "não lidos"}{showInboxCategories ? ` em ${inboxCategoryMeta[activeInboxCategory].label}` : ""} · {autoRefresh ? "sincronização em tempo real a cada 45s" : "atualização manual"}
          </p>
        </div>

        <div className="mail-list-pagination flex items-center gap-2 text-xs font-bold text-white/60">
          <Button variant="ghost" size="sm" iconOnly onClick={onRefresh} className="hover:bg-white/7" aria-label="Atualizar lista">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </Button>
          <span>
            {visibleRange} / {resultSize || messages.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled={messages.length <= GMAIL_PAGE_SIZE}
            onClick={onFirstPage}
            title="Voltar ao inicio"
            className="hover:bg-white/7"
            aria-label="Voltar ao inicio"
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled={!nextPageToken}
            onClick={onNextPage}
            className="hover:bg-white/7"
            aria-label="Proxima pagina"
          >
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {showInboxCategories && (
        <nav className="mail-category-tabs" aria-label="Categorias da caixa de entrada" role="tablist">
          {(Object.keys(inboxCategoryMeta) as InboxCategoryKey[]).map((category) => {
            const meta = inboxCategoryMeta[category];
            const Icon = inboxCategoryIcons[category];
            const unread = inboxCategoryCounts[category];
            const active = activeInboxCategory === category;
            return (
              <button
                key={category}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn("mail-category-tab", active && "is-active")}
                onClick={() => onInboxCategoryChange(category)}
              >
                <span className="mail-category-tab-title">
                  <Icon size={17} aria-hidden="true" />
                  <strong>{meta.label}</strong>
                  {unread > 0 && <b>{unread} {unread === 1 ? "novo" : "novos"}</b>}
                </span>
                <small>{meta.description}</small>
              </button>
            );
          })}
        </nav>
      )}

      <div className="mail-list-filters flex h-14 shrink-0 items-center justify-between border-y border-white/10 px-4 py-3">
        <div className="mail-list-quick-filters flex items-center gap-2">
          <button
            onClick={onToggleSelectAll}
            aria-label="Selecionar todos"
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded border border-white/18",
              allSelected && "bg-[#0EA5E9] border-[#0EA5E9]",
            )}
          >
            {allSelected && <Check size={13} />}
          </button>

          {quickFilters.map((filter) => (
            <button
              key={filter.key}
              onClick={() => onFilterChange(filter.key)}
              className={cn(
                "mail-hover rounded-full border border-white/12 px-3 py-1.5 text-xs font-bold transition",
                activeFilter === filter.key ? "mail-active bg-white text-black" : "text-white hover:bg-white/7",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="mail-list-actions flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button onClick={() => onBulkAction("archive")} className="mail-hover border-white/12 py-2 hover:bg-white/7">
                Arquivar
              </Button>
              <Button onClick={() => onBulkAction("trash")} className="mail-hover border-white/12 py-2 hover:bg-white/7">
                Lixeira
              </Button>
            </>
          )}
          {!showInboxCategories && (
            <button
              onClick={onToggleGroupByCategory}
              className={cn(
                "mail-hover flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-bold",
                groupByCategory ? "border-cyan-300/35 bg-cyan-300/12 text-cyan-100" : "border-white/12 text-white/70 hover:bg-white/7",
              )}
            >
              <Tags size={14} />
              Agrupar categorias
            </button>
          )}
          <Button size="sm" onClick={onOpenFilters} className="mail-hover border-white/12 text-white/70 hover:bg-white/7">
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
          <Button variant="ghost" onClick={onAskNora} className="mail-primary bg-[#0EA5E9] py-2">
            Experimente
          </Button>
        </div>
      )}

      {!showInboxCategories && !groupByCategory && groupedMessages.length > 0 && (
        <div className="mail-mobile-categories" aria-label="Categorias do e-mail">
          {groupedMessages.slice(0, 3).map(([category, items]) => {
            const meta = emailCategoryMeta[category];
            return (
              <button key={category} type="button" onClick={onToggleGroupByCategory}>
                <span className={meta.tone}><Tags size={15} /></span>
                <span><strong>{meta.label}</strong><small>{items.length} e-mail(s)</small></span>
                <b>+{items.length}</b>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="border-b border-red-500/25 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">{error}</div>
      )}

      <div className="mail-list-scroll min-h-0 flex-1 overflow-y-auto">
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
                    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/8 bg-[var(--surface)] px-4 py-2 backdrop-blur-xl">
                      <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-black", meta.tone)}>
                        <Tags size={14} />
                        {meta.label}
                      </span>
                      <span className="text-xs font-bold text-white/55">{items.length} e-mail(s)</span>
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
          <div className="flex h-full flex-col items-center justify-center text-center text-white/45">
            <MailOpen size={34} className="mb-3" />
            <p className="text-sm font-bold">
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
