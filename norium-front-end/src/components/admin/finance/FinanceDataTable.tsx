import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownAZ, ArrowUpAZ, ChevronLeft, ChevronRight, Search } from "lucide-react";
import Button from "../../shared/Button";
import EmptyState from "../../shared/EmptyState";

export interface FinanceColumn<T extends { id: string }> {
  key: string;
  title: string;
  sortable?: boolean;
  render: (item: T) => ReactNode;
  searchValue?: (item: T) => string;
}

interface FinanceDataTableProps<T extends { id: string }> {
  items: T[];
  columns: FinanceColumn<T>[];
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  actions?: (item: T) => ReactNode;
  searchPlaceholder?: string;
  emptyTitle: string;
  emptyDescription?: string;
  pageSize?: number;
}

export default function FinanceDataTable<T extends { id: string }>({
  items,
  columns,
  selectedIds = [],
  onSelectedIdsChange,
  actions,
  searchPlaceholder = "Buscar registros...",
  emptyTitle,
  emptyDescription,
  pageSize = 12,
}: FinanceDataTableProps<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState(columns.find((column) => column.sortable)?.key || columns[0]?.key || "id");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("pt-BR");
    const values = normalized
      ? items.filter((item) => columns.some((column) => (column.searchValue?.(item) || String(column.render(item) ?? "")).toLocaleLowerCase("pt-BR").includes(normalized)))
      : [...items];
    const column = columns.find((candidate) => candidate.key === sortKey);
    if (!column) return values;
    return values.sort((left, right) => {
      const a = column.searchValue?.(left) || String(column.render(left) ?? "");
      const b = column.searchValue?.(right) || String(column.render(right) ?? "");
      return a.localeCompare(b, "pt-BR", { numeric: true }) * (sortDirection === "asc" ? 1 : -1);
    });
  }, [columns, items, search, sortDirection, sortKey]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selectedIds.includes(item.id));

  function toggleSort(key: string) {
    if (sortKey === key) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDirection("asc"); }
  }

  function toggleAll() {
    if (!onSelectedIdsChange) return;
    if (allVisibleSelected) onSelectedIdsChange(selectedIds.filter((id) => !visible.some((item) => item.id === id)));
    else onSelectedIdsChange(Array.from(new Set([...selectedIds, ...visible.map((item) => item.id)])));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-3">
        <label className="flex min-w-56 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
          <Search size={16} className="text-[var(--text-secondary)]" />
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={searchPlaceholder} className="h-10 min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" />
        </label>
        <span className="text-xs font-bold text-[var(--text-secondary)]">{filtered.length} registro(s)</span>
      </div>
      {visible.length === 0 ? <EmptyState title={emptyTitle} description={emptyDescription} className="m-4" /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-[var(--background)] text-xs uppercase text-[var(--text-secondary)]">
              <tr>
                {onSelectedIdsChange && <th className="w-12 px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Selecionar página" /></th>}
                {columns.map((column) => <th key={column.key} className="whitespace-nowrap px-4 py-3 font-black">{column.sortable ? <button className="inline-flex items-center gap-1" onClick={() => toggleSort(column.key)}>{column.title}{sortKey === column.key ? sortDirection === "asc" ? <ArrowDownAZ size={14} /> : <ArrowUpAZ size={14} /> : null}</button> : column.title}</th>)}
                {actions && <th className="px-4 py-3 text-right font-black">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id} className="border-t border-[var(--border)] hover:bg-[var(--surface-hover)]">
                  {onSelectedIdsChange && <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => onSelectedIdsChange(selectedIds.includes(item.id) ? selectedIds.filter((id) => id !== item.id) : [...selectedIds, item.id])} aria-label={`Selecionar ${item.id}`} /></td>}
                  {columns.map((column) => <td key={column.key} className="max-w-[320px] px-4 py-3 align-top font-semibold">{column.render(item)}</td>)}
                  {actions && <td className="px-4 py-3 text-right"><div className="flex justify-end gap-1">{actions(item)}</div></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-3"><Button size="sm" iconOnly aria-label="Página anterior" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={16} /></Button><span className="text-xs font-bold text-[var(--text-secondary)]">{safePage} de {pages}</span><Button size="sm" iconOnly aria-label="Próxima página" disabled={safePage >= pages} onClick={() => setPage((current) => Math.min(pages, current + 1))}><ChevronRight size={16} /></Button></div>}
    </div>
  );
}
