import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";
import "./emails.css";

type AdvancedSearchPanelProps = {
  filters: AdvancedMailFilters;
  onChange: (filters: AdvancedMailFilters) => void;
  onSubmit: () => void;
  onClear: () => void;
  onClose: () => void;
};

/** Formulario de pesquisa avancada do Gmail, em portal sobre a tela. */
export default function AdvancedSearchPanel({ filters, onChange, onSubmit, onClear, onClose }: AdvancedSearchPanelProps) {
  const set = <K extends keyof AdvancedMailFilters>(key: K, value: AdvancedMailFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return createPortal(
    <div
      className="nx-mail-layer nx-mail-adv-wrap mail-advanced-search-backdrop"
      onMouseDown={(event) => {
        // fecha so no clique do proprio fundo, nao em arrasto vindo de dentro
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="nx-mail-adv mail-advanced-search-panel"
      >
        <div className="nx-mail-layer-h">
          <div>
            <h2>Pesquisa avançada</h2>
            <p>Combine campos para localizar mensagens no Gmail.</p>
          </div>
          <button type="button" onClick={onClose} className="nx-mail-iconbtn" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="nx-mail-dialog-b">
          <div className="nx-mail-adv-grid">
            <label className="nx-mail-label">
              De
              <input value={filters.from} onChange={(e) => set("from", e.target.value)} placeholder="remetente@email.com" />
            </label>
            <label className="nx-mail-label">
              Para
              <input value={filters.to} onChange={(e) => set("to", e.target.value)} placeholder="destinatario@email.com" />
            </label>
            <label className="nx-mail-label is-wide">
              Assunto
              <input value={filters.subject} onChange={(e) => set("subject", e.target.value)} placeholder="Palavras no assunto" />
            </label>
            <label className="nx-mail-label">
              Contém as palavras
              <input value={filters.hasWords} onChange={(e) => set("hasWords", e.target.value)} />
            </label>
            <label className="nx-mail-label">
              Não contém
              <input value={filters.excludes} onChange={(e) => set("excludes", e.target.value)} />
            </label>
            <label className="nx-mail-label">
              Período
              <select
                value={filters.newerThan}
                onChange={(e) => set("newerThan", e.target.value as AdvancedMailFilters["newerThan"])}
              >
                <option value="">Qualquer período</option>
                <option value="1d">Últimas 24 horas</option>
                <option value="7d">Últimos 7 dias</option>
                <option value="30d">Últimos 30 dias</option>
                <option value="365d">Último ano</option>
              </select>
            </label>
            <label className="nx-mail-adv-check">
              <input
                type="checkbox"
                checked={filters.hasAttachment}
                onChange={(e) => set("hasAttachment", e.target.checked)}
              />
              Com anexo
            </label>
          </div>

          <div className="nx-mail-actions-end">
            <button type="button" onClick={onClear} className="nx-btn is-sm">Limpar</button>
            <button type="submit" className="nx-btn is-sm is-primary">Pesquisar</button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
