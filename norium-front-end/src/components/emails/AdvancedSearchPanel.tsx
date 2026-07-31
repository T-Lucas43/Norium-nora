import { createPortal } from "react-dom";
import { X } from "lucide-react";
import Button from "../shared/Button";
import type { AdvancedMailFilters } from "../../features/mail/queryBuilder";

type AdvancedSearchPanelProps = {
  filters: AdvancedMailFilters;
  onChange: (filters: AdvancedMailFilters) => void;
  onSubmit: () => void;
  onClear: () => void;
  onClose: () => void;
};

const campoClasse = "h-10 rounded-lg border border-white/12 bg-black/20 px-3 text-xs text-white outline-none focus:border-cyan-400/60";

/** Formulario de pesquisa avancada do Gmail, em portal sobre a tela. */
export default function AdvancedSearchPanel({ filters, onChange, onSubmit, onClear, onClose }: AdvancedSearchPanelProps) {
  const set = <K extends keyof AdvancedMailFilters>(key: K, value: AdvancedMailFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return createPortal(
    <div
      className="mail-advanced-search-backdrop fixed inset-0 z-[240] flex items-start justify-center bg-black/55 px-4 pt-[88px] backdrop-blur-[2px]"
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
        className="mail-modal mail-advanced-search-panel isolate max-h-[calc(100dvh-112px)] w-[520px] max-w-full overflow-y-auto rounded-xl border border-white/12 bg-[#0C0E10] p-5 text-white shadow-[0_28px_100px_rgba(0,0,0,0.78)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold">Pesquisa avancada</p>
            <p className="text-xs font-semibold text-white/45">Combine campos para localizar mensagens no Gmail.</p>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} className="hover:bg-white/7" aria-label="Fechar">
            <X size={16} />
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-bold text-white/60">
            De
            <input value={filters.from} onChange={(e) => set("from", e.target.value)} placeholder="remetente@email.com" className={campoClasse} />
          </label>
          <label className="grid gap-1 text-xs font-bold text-white/60">
            Para
            <input value={filters.to} onChange={(e) => set("to", e.target.value)} placeholder="destinatario@email.com" className={campoClasse} />
          </label>
          <label className="grid gap-1 text-xs font-bold text-white/60 sm:col-span-2">
            Assunto
            <input value={filters.subject} onChange={(e) => set("subject", e.target.value)} placeholder="Palavras no assunto" className={campoClasse} />
          </label>
          <label className="grid gap-1 text-xs font-bold text-white/60">
            Contem as palavras
            <input value={filters.hasWords} onChange={(e) => set("hasWords", e.target.value)} className={campoClasse} />
          </label>
          <label className="grid gap-1 text-xs font-bold text-white/60">
            Nao contem
            <input value={filters.excludes} onChange={(e) => set("excludes", e.target.value)} className={campoClasse} />
          </label>
          <label className="grid gap-1 text-xs font-bold text-white/60">
            Periodo
            <select
              value={filters.newerThan}
              onChange={(e) => set("newerThan", e.target.value as AdvancedMailFilters["newerThan"])}
              className="h-10 rounded-lg border border-white/12 bg-[#101014] px-3 text-xs text-white outline-none"
            >
              <option value="">Qualquer periodo</option>
              <option value="1d">Ultimas 24 horas</option>
              <option value="7d">Ultimos 7 dias</option>
              <option value="30d">Ultimos 30 dias</option>
              <option value="365d">Ultimo ano</option>
            </select>
          </label>
          <label className="flex h-10 items-center gap-2 self-end rounded-lg border border-white/12 px-3 text-xs font-bold text-white/70">
            <input
              type="checkbox"
              checked={filters.hasAttachment}
              onChange={(e) => set("hasAttachment", e.target.checked)}
              className="accent-cyan-400"
            />
            Com anexo
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClear} className="border-white/12 text-white/65 hover:bg-white/7">Limpar</Button>
          <Button variant="ghost" size="sm" type="submit" className="mail-primary bg-[#0EA5E9]">Pesquisar</Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
