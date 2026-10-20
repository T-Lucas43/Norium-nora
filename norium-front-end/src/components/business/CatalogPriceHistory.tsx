import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";

type History = { items: { priceCents: number; until: string }[]; total: number; nextOffset: number | null };

export default function CatalogPriceHistory({ itemId }: { itemId: string }) {
  const scope = requestScope(); const [open, setOpen] = useState(false); const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<History>({ items: [], total: 0, nextOffset: null });
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true); setError("");
    try { const data = await apiRequest<History>(`/api/business/catalog/${encodeURIComponent(itemId)}/history?offset=${offset}&limit=25`, { signal });
      if (!signal.aborted && requestScope() === scope) setPage(data);
    } catch (err) { if (!signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao carregar histórico."); }
    finally { if (!signal.aborted && requestScope() === scope) setLoading(false); }
  }, [itemId, offset, scope]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Histórico de preços</summary>
    {loading && <p role="status">Consultando preços anteriores…</p>}
    {error && <p role="alert" className="business-error">{error}</p>}
    {open && !loading && !error && !page.total && <p className="business-note">O preço ainda não foi alterado.</p>}
    {open && page.items.length > 0 && <><div className="business-table-wrap mt-3"><table className="business-table"><thead><tr><th>Preço anterior</th><th>Alterado em</th></tr></thead>
      <tbody>{page.items.map((entry, index) => <tr key={`${entry.until}-${index}`}><td>{(entry.priceCents/100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td><td>{new Date(entry.until).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td></tr>)}</tbody></table></div>
      <div className="business-pagination mt-3"><span>{page.total} {page.total === 1 ? "alteração" : "alterações"}</span><div className="flex gap-2"><Button size="sm" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value-25))}>Anterior</Button><Button size="sm" disabled={page.nextOffset == null || loading} onClick={() => setOffset(page.nextOffset ?? offset)}>Próxima</Button></div></div></>}
  </details>;
}
