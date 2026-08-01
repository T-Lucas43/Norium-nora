import { Bot, Eye, Menu, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import Button from "../shared/Button";
import { cn } from "../../utils/cn";
import AdvancedSearchPanel from "./AdvancedSearchPanel";
import { accountInitials } from "../../features/mail/formatters";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";
import type { GmailStatus } from "../../features/mail/types";

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
  onTogglePreview,
  onOpenSettings,
  onToggleProfile,
}: MailToolbarProps) {
  return (
    <header className="mail-surface flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
      <div className="flex min-w-0 items-center gap-4">
        <button type="button" className="mobile-sidebar-toggle" aria-label="Abrir menu do e-mail" onClick={onOpenMobileSidebar}>
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

      <div className="flex items-center gap-2">
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
