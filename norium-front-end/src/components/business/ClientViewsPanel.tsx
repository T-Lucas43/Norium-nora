import { useCallback, useEffect, useState } from "react";
import { Bookmark, Pencil, Plus, Tag, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import type { Client } from "../clients/clientModel";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";
import SelectionTagDialog from "./SelectionTagDialog";

export type ClientFilters = { query: string; status: "all" | "lead" | "active" | "inactive";
  stage: "all" | "new" | "contacted" | "proposal" | "won" | "lost"; ownerId: string; tagIds: string[] };
type View = { id: string; name: string; scope: "personal" | "team"; filters: ClientFilters; version: number; canDelete?: boolean; canEdit?: boolean };
type Label = { id: string; name: string };

export default function ClientViewsPanel({ value, onChange, clients }: { value: ClientFilters; onChange: (next: ClientFilters) => void; clients: Client[] }) {
  const scope = requestScope(); const [views, setViews] = useState<View[]>([]); const [labels, setLabels] = useState<Label[]>([]);
  const [canShare, setCanShare] = useState(false); const [open, setOpen] = useState(false); const [name, setName] = useState("");
  const [shared, setShared] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [editing, setEditing] = useState<View | null>(null); const [replaceFilters, setReplaceFilters] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = requestScope();
    try { const [data, tags] = await Promise.all([apiRequest<{ items: View[]; canShare: boolean }>("/api/business/client-views", { signal }), apiRequest<{ items: Label[] }>("/api/business/tags?scope=client", { signal })]);
      if (!signal?.aborted && requestScope() === current && current === scope) { setViews(data.items); setCanShare(data.canShare); setLabels(tags.items); }
    } catch (err) { if (!signal?.aborted && requestScope() === current && current === scope) setError(err instanceof Error ? err.message : "Falha ao consultar visões salvas."); }
  }, [scope]);
  useEffect(() => { const controller = new AbortController(); setViews([]); setLabels([]); setOpen(false); setEditing(null); setBusy(false); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  useEffect(() => { const update = () => void refresh(); window.addEventListener("norium:business-tags-changed", update); return () => window.removeEventListener("norium:business-tags-changed", update); }, [refresh]);
  async function save() {
    if (busy || !name.trim() || requestScope() !== scope) return; setBusy(true); setError("");
    const path = editing ? `/api/business/client-views/${editing.scope}/${encodeURIComponent(editing.id)}` : "/api/business/client-views";
    try { await apiRequest(path, { method: editing ? "PUT" : "POST", body: JSON.stringify({ name: name.trim(),
        scope: editing?.scope || (shared ? "team" : "personal"), filters: editing && !replaceFilters ? editing.filters : value,
        ...(editing ? { expectedVersion: editing.version } : {}) }) });
      if (requestScope() === scope) { await refresh(); setOpen(false); setName(""); }
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao salvar visão."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  async function remove(view: View) {
    if (busy || requestScope() !== scope) return; setBusy(true); setError("");
    try { await apiRequest(`/api/business/client-views/${view.scope}/${encodeURIComponent(view.id)}?expectedVersion=${view.version}`, { method: "DELETE" }); if (requestScope() === scope) await refresh(); }
    catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao remover visão."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  const owners = [...new Map(clients.filter(client => client.ownerId).map(client => [client.ownerId!, client.ownerName || client.ownerId!])).entries()];
  return <section className="business-view-filters" aria-label="Visões e filtros de clientes">
    <div className="flex flex-wrap items-center gap-2"><Bookmark size={15} aria-hidden="true" />
      {views.map(view => <span className="business-badge" key={view.id}><button type="button" onClick={() => onChange(view.filters)}>{view.name}{view.scope === "team" ? " · Equipe" : ""}</button>
        {view.canEdit && <button type="button" disabled={busy} aria-label={`Editar visão ${view.name}`} onClick={() => { setEditing(view); setName(view.name); setReplaceFilters(false); setShared(view.scope === "team"); setError(""); setOpen(true); }}><Pencil size={12} /></button>}
        {view.canDelete && <button type="button" disabled={busy} aria-label={`Remover visão ${view.name}`} onClick={() => void remove(view)}><X size={12} /></button>}</span>)}
      <Button size="sm" onClick={() => { setEditing(null); setName(""); setShared(false); setError(""); setOpen(true); }} icon={<Plus size={14} />}>Salvar visão atual</Button>
    </div>
    <div className="business-filters"><label className="business-note">Etapa<select className="business-input" aria-label="Filtrar clientes por etapa" value={value.stage} onChange={event => onChange({ ...value, stage: event.target.value as ClientFilters["stage"] })}>
      <option value="all">Todas</option><option value="new">Novo lead</option><option value="contacted">Contato realizado</option><option value="proposal">Proposta</option><option value="won">Ganho</option><option value="lost">Perdido</option></select></label>
      <label className="business-note">Responsável<select className="business-input" aria-label="Filtrar por responsável" value={value.ownerId} onChange={event => onChange({ ...value, ownerId: event.target.value })}><option value="">Todos</option>{owners.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <details><summary className="nx-btn is-sm"><Tag size={14} /> Etiquetas {value.tagIds.length ? `(${value.tagIds.length})` : ""}</summary><div className="business-tag-filter">{labels.length ? labels.map(label => <label className="flex items-center gap-2" key={label.id}><input type="checkbox" checked={value.tagIds.includes(label.id)} disabled={!value.tagIds.includes(label.id) && value.tagIds.length >= 20} onChange={event => onChange({ ...value, tagIds: event.target.checked ? [...value.tagIds, label.id] : value.tagIds.filter(id => id !== label.id) })} />{label.name}</label>) : <p className="business-note">Crie etiquetas na ficha de um cliente.</p>}</div></details>
      {(value.stage !== "all" || value.ownerId || value.tagIds.length > 0) && <Button size="sm" onClick={() => onChange({ ...value, stage: "all", ownerId: "", tagIds: [] })}>Limpar filtros extras</Button>}
    </div>
    {error && <p role="alert" className="business-error">{error}</p>}
    {open && <BusinessDialog title={editing ? "Editar visão de clientes" : "Salvar visão de clientes"} busy={busy} onClose={() => setOpen(false)}><div className="business-form">
      <label>Nome da visão<input className="business-input" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Ex.: Leads quentes" /></label>
      <label className="is-check"><input type="checkbox" disabled={!canShare || !!editing} checked={shared} onChange={event => setShared(event.target.checked)} />Compartilhar com a equipe</label>
      {editing && <label className="is-check"><input type="checkbox" checked={replaceFilters} onChange={event => setReplaceFilters(event.target.checked)} />Substituir os filtros salvos pelos filtros atuais da lista</label>}
      <p className="business-note">A visão guarda os filtros atuais. Cada pessoa consulta os clientes permitidos pelo próprio acesso.</p>
      {error && <p role="alert" className="business-error">{error}</p>}<footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={() => void save()}>Salvar visão</Button></footer></div></BusinessDialog>}
  </section>;
}

export function ClientBulkTags({ ids, onExport, onClear, canEdit }: { ids: string[]; onExport: () => void; onClear: () => void; canEdit: boolean }) {
  const scope = requestScope(); const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope]);
  return <><div className="business-bulk-bar" role="region" aria-label="Ações para clientes selecionados"><strong>{ids.length} selecionados</strong><Button size="sm" disabled={!canEdit} onClick={() => setOpen(true)} icon={<Tag size={14} />}>Etiqueta</Button><Button size="sm" onClick={onExport}>Exportar selecionados</Button><Button size="sm" onClick={onClear}>Limpar seleção</Button>{!canEdit && <span className="business-note">Há clientes com acesso somente de leitura.</span>}</div>
    {open && canEdit && ids.length > 0 && <SelectionTagDialog ids={ids} target="clients" onClose={() => setOpen(false)} />}</>;
}
