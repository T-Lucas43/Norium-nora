import { Bot, Check, Eye, Loader2, Menu, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import Button from "../shared/Button";
import { cn } from "../../utils/cn";
import AdvancedSearchPanel from "./AdvancedSearchPanel";
import { accountInitials } from "../../features/mail/formatters";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";
import type { GmailStatus, MailboxSyncState } from "../../features/mail/types";

type MailToolbarProps = {
  status: GmailStatus | null;
  canUseNora: boolean;
  searchDraft: string;
  filtersOpen: boolean;
  advancedFilters: AdvancedMailFilters;
  onSearchDraftChange: (value: string) => void;
  onApplySearch: () => void;
  onClearSearch: () => void;
  onToggleFilters: () => void;
  onCloseFilters: () => void;
  onAdvancedFiltersChange: (filters: AdvancedMailFilters) => void;
  onOpenMobileSidebar: () => void;
  onOpenNora: () => void;
  sync: MailboxSyncState;
  onTogglePreview: () => void;
  onOpenSettings: () => void;
  onToggleProfile: () => void;
};

/** Barra superior do Norium Mail: busca, filtros e acoes da conta. */
export default function MailToolbar({
  status,
  canUseNora,
  searchDraft,
  filtersOpen,
  advancedFilters,
  onSearchDraftChange,
  onApplySearch,
  onClearSearch,
  onToggleFilters,
  onCloseFilters,
  onAdvancedFiltersChange,
  onOpenMobileSidebar,
  onOpenNora,
  sync,
  onTogglePreview,
  onOpenSettings,
  onToggleProfile,
}: MailToolbarProps) {
  return (
    <header className="mail-toolbar mail-surface flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
      <div className="mail-toolbar-search-group flex min-w-0 items-center gap-4">
        <button type="button" className="mobile-sidebar-toggle mail-navigation-toggle" aria-label="Abrir menu do e-mail" title="Pastas do e-mail" onClick={onOpenMobileSidebar}>
          <Menu size={18} />
        </button>

        <div className="mail-input relative flex h-11 w-[405px] max-w-[42vw] items-center gap-3 rounded-lg border border-white/12 bg-[#1C1C20] px-4">
          <Search size={18} className="text-white/55" />
          <input
            value={searchDraft}
            onChange={(event) => onSearchDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onApplySearch();
            }}
            placeholder="Pesquisar email"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-white/45"
          />
          {searchDraft && (
            <button
              type="button"
              onClick={onClearSearch}
              className="text-white/45 hover:text-white"
              title="Limpar pesquisa"
              aria-label="Limpar pesquisa"
            >
              <X size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleFilters}
            className={cn("text-white/55 hover:text-white", filtersOpen && "text-cyan-300")}
            title="Filtros avancados"
            aria-expanded={filtersOpen}
            aria-label="Filtros avancados"
          >
            <SlidersHorizontal size={17} />
          </button>
          {filtersOpen && (
            <AdvancedSearchPanel
              filters={advancedFilters}
              onChange={onAdvancedFiltersChange}
              onSubmit={onApplySearch}
              onClear={onClearSearch}
              onClose={onCloseFilters}
            />
          )}
        </div>

        {status?.connected && (
          <div className="hidden min-w-0 text-xs font-semibold text-white/50 xl:block">
            Conectado como <span className="text-white/80">{status.email}</span>
          </div>
        )}
      </div>

      <div className="mail-toolbar-actions flex items-center gap-2">
        {canUseNora && status?.connected && (sync.active || sync.loaded > 0) && (
          <div
            className="mail-sync-progress hidden items-center gap-2 rounded-full border border-white/12 px-3 py-1.5 text-[11px] font-bold text-white/70 md:flex"
            role="status"
            aria-live="polite"
            title={sync.error ? `Sincronização parcial: ${sync.error}` : sync.active ? "Sincronizando todas as páginas da caixa atual…" : "Caixa sincronizada e guardada em memória."}
          >
            {sync.active ? <Loader2 size={13} className="animate-spin text-cyan-300" /> : <Check size={13} className="text-emerald-300" />}
            <span>{sync.active ? "Sincronizando" : "Sincronizado"} {sync.loaded}{sync.estimated > sync.loaded ? ` de ~${sync.estimated}` : ""}</span>
            {sync.active && sync.estimated > 0 && (
              <span className="h-1 w-16 overflow-hidden rounded-full bg-white/15" aria-hidden="true">
                <span className="block h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(100, Math.round((sync.loaded / sync.estimated) * 100))}%` }} />
              </span>
            )}
          </div>
        )}
        {canUseNora && (
          <Button onClick={onOpenNora} className="rounded-full border-[#38BDF8] hover:bg-[#38BDF8]/12">
            <Bot size={15} />
            Nora para E-mails
          </Button>
        )}
        <Button
          iconOnly
          onClick={onTogglePreview}
          title="Alternar previa"
          className="mail-hover rounded-full border-white/12 hover:bg-white/7"
          aria-label="Alternar previa"
        >
          <Eye size={17} />
        </Button>
        <Button
          iconOnly
          onClick={onOpenSettings}
          title="Configuracoes do Mail"
          className="mail-hover rounded-full border-white/12 hover:bg-white/7"
          aria-label="Configuracoes do Mail"
        >
          <Settings size={17} />
        </Button>
        <Button
          iconOnly
          onClick={onToggleProfile}
          title="Perfil"
          className="mail-hover !h-9 !w-9 !min-w-9 shrink-0 overflow-hidden rounded-full border-white/12 bg-[#4A3B8F] !p-0"
          aria-label="Perfil"
        >
          {status?.picture ? (
            <img src={status.picture} alt="Foto do perfil" className="block aspect-square h-9 w-9 max-w-none object-cover" />
          ) : (
            <span>{accountInitials(status)}</span>
          )}
        </Button>
      </div>
    </header>
  );
}
