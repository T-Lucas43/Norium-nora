import { Check, Eye, Loader2, Menu, PenLine, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import { cn } from "../../utils/cn";
import NoraAvatar from "../layout/NoraAvatar";
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
  /** Atalho de nova mensagem ao lado da busca, como no layout aprovado. */
  onCompose?: () => void;
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
  onCompose,
}: MailToolbarProps) {
  return (
    <div className="nx-mail-toolbar">
      <div className="nx-mail-toolbar-search">
        <button type="button" className="mobile-sidebar-toggle mail-navigation-toggle" aria-label="Abrir menu do e-mail" title="Pastas e marcadores" onClick={onOpenMobileSidebar}>
          <Menu size={16} />
        </button>

        <div className="nx-input nx-mail-search">
          <Search size={16} />
          <input
            value={searchDraft}
            onChange={(event) => onSearchDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onApplySearch();
            }}
            placeholder="Buscar e-mails"
            aria-label="Buscar e-mails"
          />
          {searchDraft && (
            <button
              type="button"
              onClick={onClearSearch}
              className="nx-mail-iconbtn"
              title="Limpar pesquisa"
              aria-label="Limpar pesquisa"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleFilters}
            className={cn("nx-mail-iconbtn", filtersOpen && "is-active")}
            title="Filtros avançados"
            aria-expanded={filtersOpen}
            aria-label="Filtros avançados"
          >
            <SlidersHorizontal size={15} />
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

        {onCompose && (
          <button type="button" className="nx-btn is-primary nx-mail-compose" onClick={onCompose} title="Nova mensagem" aria-label="Nova mensagem">
            <PenLine size={16} />
          </button>
        )}

        {status?.connected && (
          <span className="nx-mail-account">
            Conectado como <b>{status.email}</b>
          </span>
        )}
      </div>

      <div className="nx-mail-toolbar-actions">
        {canUseNora && status?.connected && (sync.active || sync.loaded > 0) && (
          <span
            className="nx-badge nx-mail-sync"
            role="status"
            aria-live="polite"
            title={sync.error ? `Sincronização parcial: ${sync.error}` : sync.active ? "Sincronizando todas as páginas da caixa atual…" : "Caixa sincronizada e guardada em memória."}
          >
            {sync.active ? <Loader2 size={13} className="nx-mail-spin" /> : <Check size={13} />}
            <span>{sync.active ? "Sincronizando" : "Sincronizado"} {sync.loaded}{sync.estimated > sync.loaded ? ` de ~${sync.estimated}` : ""}</span>
            {sync.active && sync.estimated > 0 && (
              <i aria-hidden="true">
                <b style={{ width: `${Math.min(100, Math.round((sync.loaded / sync.estimated) * 100))}%` }} />
              </i>
            )}
          </span>
        )}
        {canUseNora && (
          <button type="button" onClick={onOpenNora} className="nx-btn nx-mail-nora-btn" aria-label="Nora para E-mails">
            <NoraAvatar className="rounded-full" />
            <span>Nora para E-mails</span>
          </button>
        )}
        <button
          type="button"
          onClick={onTogglePreview}
          title="Alternar prévia"
          className="nx-mail-iconbtn"
          aria-label="Alternar prévia"
        >
          <Eye size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Configurações do e-mail"
          className="nx-mail-iconbtn"
          aria-label="Configurações do e-mail"
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleProfile}
          title="Perfil"
          className="nx-mail-profile"
          aria-label="Perfil"
        >
          {status?.picture ? (
            <img src={status.picture} alt="Foto do perfil" />
          ) : (
            <span>{accountInitials(status)}</span>
          )}
        </button>
      </div>
    </div>
  );
}
