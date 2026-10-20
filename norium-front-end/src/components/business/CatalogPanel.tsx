import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, Check, Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";
import ImportPanel from "./ImportPanel";
import CatalogPriceHistory from "./CatalogPriceHistory";
import "./business.css";

export type CatalogItem = { id: string; name: string; type: "product" | "service"; unit: string;
  priceCents: number; maxDiscountBasisPoints: number; noraCanOffer: boolean; category: string;
  sku: string; description: string; active: boolean; durationMinutes: number | null; version: number };
type Page = { items: CatalogItem[]; total: number; nextOffset: number | null };
const money = (value: number) => (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function decimal(value: string): number {
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(value.trim())) throw new Error("Use um número positivo com até duas casas decimais, por exemplo 1500,50.");
  const [integer, cents = ""] = value.trim().replace(",", ".").split(".");
  return Number(integer) * 100 + Number(cents.padEnd(2, "0"));
}

export default function CatalogPanel() {
  const scope = requestScope();
  const [page, setPage] = useState<Page>({ items: [], total: 0, nextOffset: null });
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [editor, setEditor] = useState<CatalogItem | "new" | null>(null);
  const [revision, setRevision] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ query, offset: String(offset), limit: "50" });
    if (filter !== "all") params.set("active", filter === "active" ? "true" : "false");
    try { const result = await apiRequest<Page>(`/api/business/catalog?${params}`, { signal });
      if (!signal.aborted && requestScope() === scope) setPage(result);
    } catch (err) { if (!signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao consultar catálogo."); }
    finally { if (!signal.aborted && requestScope() === scope) setLoading(false); }
  }, [query, offset, filter, scope]);
  useEffect(() => { setPage({ items: [], total: 0, nextOffset: null }); setEditor(null); setImportOpen(false); setOffset(0); setQuery(""); setError(""); }, [scope]);
  useEffect(() => { const controller = new AbortController(); const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); }; }, [load, revision]);
  return <section className="business-panel" aria-label="Catálogo de produtos e serviços">
    <header className="business-toolbar"><div><h2>Catálogo de produtos e serviços</h2>
      <p>Preços, duração e condições em um só lugar para preparar seus documentos.</p></div>
      <div className="flex flex-wrap gap-2"><Button onClick={() => setImportOpen(true)}>Importar planilha</Button><Button aria-label="Atualizar catálogo" loading={loading} onClick={() => setRevision(value => value + 1)} icon={<RefreshCw size={16} />} />
        <Button variant="primary" onClick={() => setEditor("new")} icon={<Plus size={16} />}>Novo item</Button></div></header>
    <div className="business-filters"><label className="nx-input"><Search size={16} aria-hidden="true" /><input aria-label="Buscar no catálogo" placeholder="Nome, categoria ou código" value={query}
      onChange={event => { setQuery(event.target.value); setOffset(0); }} /></label>
      <select className="business-input" aria-label="Situação dos itens" value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}>
        <option value="all">Todos os itens</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select></div>
    {error && <p className="business-error" role="alert">{error}</p>}
    {loading && <p role="status" className="business-note">Consultando catálogo…</p>}
    {!loading && !error && !page.items.length && <div className="business-empty"><h3>{query ? "Nenhum item encontrado" : "Seu catálogo começa aqui"}</h3><p>Cadastre produtos e serviços com preço e condições.</p></div>}
    {page.items.length > 0 && <div className="business-table-wrap"><table className="business-table"><thead><tr><th>Item</th><th>Tipo</th><th>Unidade</th><th className="is-money">Preço</th><th>Desconto máx.</th><th>Nora pode ofertar</th><th>Ações</th></tr></thead>
      <tbody>{page.items.map(item => <tr key={item.id}><td><strong>{item.name}</strong><small>{[item.sku, item.category, !item.active && "Inativo"].filter(Boolean).join(" · ")}</small></td>
        <td><span className="business-badge">{item.type === "service" ? "Serviço" : "Produto"}</span>{item.durationMinutes && <small>{item.durationMinutes} min</small>}</td>
        <td>{item.unit}</td><td className="is-money">{money(item.priceCents)}</td><td>{(item.maxDiscountBasisPoints / 100).toLocaleString("pt-BR")}%</td>
        <td>{item.noraCanOffer && item.active ? <span className="business-badge"><Check size={13} /> Permitido</span> : "Não"}</td>
        <td><Button size="sm" aria-label={`Editar ${item.name}`} icon={<Pencil size={14} />} onClick={() => setEditor(item)}>Editar</Button></td></tr>)}</tbody></table></div>}
    <footer className="business-pagination"><span>{page.total} {page.total === 1 ? "item" : "itens"}</span><div className="flex gap-2">
      <Button size="sm" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 50))}>Anterior</Button>
      <Button size="sm" disabled={page.nextOffset == null || loading} onClick={() => setOffset(page.nextOffset ?? offset)}>Próxima</Button></div></footer>
    <p className="business-note flex items-center gap-2"><Bot size={16} aria-hidden="true" /> A Nora só pode ofertar itens ativos com permissão. Serviços mantêm sua duração definida.</p>
    {editor && <CatalogEditor item={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setRevision(value => value + 1); }} />}
    {importOpen && <BusinessDialog title="Importar catálogo" onClose={() => setImportOpen(false)}><ImportPanel target="catalog" onComplete={() => setRevision(value => value + 1)} /></BusinessDialog>}
  </section>;
}

function CatalogEditor({ item, onClose, onSaved }: { item?: CatalogItem; onClose: () => void; onSaved: () => void }) {
  const scope = requestScope();
  const [draft, setDraft] = useState({ name: item?.name ?? "", type: item?.type ?? "service", unit: item?.unit ?? "un",
    price: ((item?.priceCents ?? 0) / 100).toFixed(2).replace(".", ","), discount: ((item?.maxDiscountBasisPoints ?? 0) / 100).toFixed(2).replace(".", ","),
    category: item?.category ?? "", sku: item?.sku ?? "", description: item?.description ?? "", active: item?.active ?? true,
    noraCanOffer: item?.noraCanOffer ?? false, duration: item?.durationMinutes?.toString() ?? "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const field = (key: keyof typeof draft, value: string | boolean) => setDraft(current => ({ ...current, [key]: value }));
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || requestScope() !== scope) return; setBusy(true); setError("");
    try {
      const body = { name: draft.name, type: draft.type, unit: draft.unit, priceCents: decimal(draft.price),
        maxDiscountBasisPoints: decimal(draft.discount), noraCanOffer: draft.noraCanOffer,
        category: draft.category, sku: draft.sku, description: draft.description, active: draft.active,
        durationMinutes: draft.type === "service" && draft.duration ? Number(draft.duration) : null,
        ...(item ? { expectedVersion: item.version } : {}) };
      if (body.maxDiscountBasisPoints > 10_000) throw new Error("O desconto máximo deve ficar entre 0% e 100%.");
      await apiRequest(`/api/business/catalog${item ? `/${item.id}` : ""}`, { method: item ? "PUT" : "POST", body: JSON.stringify(body) });
      if (requestScope() === scope) onSaved();
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível salvar o item."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title={item ? "Editar item" : "Novo item do catálogo"} onClose={onClose} busy={busy}>
    <form className="business-form" onSubmit={event => void save(event)}>
      {error && <p role="alert" className="business-error">{error}</p>}
      <label>Nome<input className="business-input" autoFocus required minLength={2} maxLength={160} value={draft.name} onChange={event => field("name", event.target.value)} /></label>
      <div className="business-form-grid"><label>Tipo<select className="business-input" value={draft.type} onChange={event => field("type", event.target.value)}><option value="service">Serviço</option><option value="product">Produto</option></select></label>
        <label>Unidade<input className="business-input" required maxLength={24} value={draft.unit} onChange={event => field("unit", event.target.value)} placeholder="hora, mês, unidade…" /></label>
        <label>Preço (R$)<input className="business-input" required inputMode="decimal" value={draft.price} onChange={event => field("price", event.target.value)} /></label>
        <label>Desconto máximo (%)<input className="business-input" required inputMode="decimal" value={draft.discount} onChange={event => field("discount", event.target.value)} /></label>
        <label>Categoria<input className="business-input" maxLength={80} value={draft.category} onChange={event => field("category", event.target.value)} /></label>
        <label>Código / SKU<input className="business-input" maxLength={80} value={draft.sku} onChange={event => field("sku", event.target.value)} /></label>
        {draft.type === "service" && <label>Duração do serviço (minutos)<input className="business-input" type="number" min={5} max={1440} value={draft.duration} onChange={event => field("duration", event.target.value)} /><small>Deixe vazio se não houver duração fixa.</small></label>}
      </div>
      <label>Descrição<textarea className="business-input" rows={3} maxLength={4000} value={draft.description} onChange={event => field("description", event.target.value)} /></label>
      <label className="is-check"><input type="checkbox" checked={draft.active} onChange={event => field("active", event.target.checked)} /> Item ativo</label>
      <label className="is-check"><input type="checkbox" checked={draft.noraCanOffer} onChange={event => field("noraCanOffer", event.target.checked)} /> Permitir que a Nora oferte este item</label>
      {item && <CatalogPriceHistory itemId={item.id} />}
      <footer><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" loading={busy}>Salvar item</Button></footer>
    </form>
  </BusinessDialog>;
}
