import { useCallback, useEffect, useState } from "react";
import { Bookmark, SlidersHorizontal, Tag } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import BusinessDialog from "../business/BusinessDialog";
import TagManager, { type BusinessTag } from "../business/TagManager";
import Button from "../shared/Button";
import { useWhatsAppScope, type AttendanceFilter } from "./WhatsAppScope";

type View = { id: string; name: string; scope: "personal" | "team"; filters: AttendanceFilter; version: number; canEdit?: boolean };
const empty: AttendanceFilter = { responsavel: "all", estado: "", unread: false, kind: "all", fromDate: "", toDate: "", tagIds: [] };

export default function ConversationFilters() {
  const { inboxId, filter, setFilter, viewId = "", setViewId } = useWhatsAppScope(), scope = requestScope();
  const [open, setOpen] = useState(false), [manage, setManage] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<AttendanceFilter>({ ...empty, ...filter });
  const [tags, setTags] = useState<BusinessTag[]>([]), [views, setViews] = useState<View[]>([]), [canShare, setCanShare] = useState(false);
  const [name, setName] = useState(""), [shared, setShared] = useState(false);
  const query = inboxId ? `?inboxId=${encodeURIComponent(inboxId)}` : "";
  const loadViews = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiRequest<{ items: View[]; canShare: boolean }>(`/api/business/whatsapp-views${query}`, { signal });
      if (!result || !Array.isArray(result.items)) throw new Error("Não foi possível carregar as visões salvas.");
      if (!signal?.aborted && requestScope() === scope) { setViews(result.items); setCanShare(result.canShare === true); }
    } catch (err) { if (!signal?.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Visões indisponíveis."); }
  }, [scope, query]);
  useEffect(() => {
    if (!setFilter) return;
    const controller = new AbortController(); void loadViews(controller.signal); return () => controller.abort();
  }, [loadViews, setFilter]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void apiRequest<{ items: BusinessTag[] }>("/api/business/tags", { signal: controller.signal })
      .then(result => {
        if (!result || !Array.isArray(result.items)) throw new Error("Não foi possível carregar as etiquetas.");
        if (!controller.signal.aborted && requestScope() === scope) setTags(result.items.filter(tag => ["contact", "conversation"].includes(tag.scope)));
      })
      .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Etiquetas indisponíveis."); });
    return () => controller.abort();
  }, [open, manage, scope]);
  if (!filter || !setFilter) return null;
  function valid() {
    if (draft.fromDate && draft.toDate && draft.fromDate > draft.toDate) { setError("O início do período deve ser anterior ao fim."); return false; }
    return true;
  }
  async function saveView(update?: View) {
    if (busy || name.trim().length < 2 || !valid()) return;
    setBusy(true); setError("");
    try {
      await apiRequest(update ? `/api/business/whatsapp-views/${update.scope}/${encodeURIComponent(update.id)}` : "/api/business/whatsapp-views", {
        method: update ? "PUT" : "POST", body: JSON.stringify({ name: name.trim(), filters: draft, scope: update?.scope || (shared ? "team" : "personal"), inboxId,
          ...(update ? { expectedVersion: update.version } : {}) }),
      });
      if (requestScope() !== scope) return; setName(""); await loadViews();
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível salvar a visão."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  async function removeView(view: View) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await apiRequest(`/api/business/whatsapp-views/${view.scope}/${encodeURIComponent(view.id)}?expectedVersion=${view.version}${inboxId ? `&inboxId=${encodeURIComponent(inboxId)}` : ""}`, { method: "DELETE" });
      if (requestScope() !== scope) return; setViewId?.(""); await loadViews();
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível remover a visão."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  const editedView = views.find(view => view.id === viewId);
  return <div className="nx-whatsapp-advanced">
    <div className="flex flex-wrap gap-2"><Button size="sm" icon={<SlidersHorizontal size={14} />} onClick={() => { setDraft({ ...empty, ...filter }); setOpen(true); setError(""); }}>Filtros</Button>
      <Button size="sm" icon={<Tag size={14} />} onClick={() => { setDraft({ ...empty, ...filter }); setOpen(true); setError(""); }}>Etiquetas{filter.tagIds?.length ? ` (${filter.tagIds.length})` : ""}</Button>
      <Button size="sm" onClick={() => { setViewId?.(""); setFilter({ ...empty }); }}>Limpar filtros</Button></div>
    {!!views.length && <label className="nx-whatsapp-saved-select"><Bookmark size={13} /><select aria-label="Visões salvas" value={viewId} onChange={event => {
      const view = views.find(item => item.id === event.target.value); setViewId?.(event.target.value); if (view) setFilter(view.filters);
    }}><option value="">Visões salvas</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}{view.scope === "team" ? " · Equipe" : ""}</option>)}</select></label>}
    {!open && error && <p role="status" className="business-note">{error}</p>}
    {open && <BusinessDialog className="nx-whatsapp-dialog" title="Filtros de conversas" busy={busy} onClose={() => setOpen(false)}><div className="business-form">
      {inboxId && <><label>Responsável<select className="business-input" value={draft.responsavel} onChange={event => setDraft({ ...draft, responsavel: event.target.value as AttendanceFilter["responsavel"] })}>
        <option value="all">Todos</option><option value="me">Minhas</option><option value="none">Não atribuídas</option><option value="nora">Nora</option></select></label>
        <label>Estado<select className="business-input" value={draft.estado} onChange={event => setDraft({ ...draft, estado: event.target.value })}><option value="">Todos</option><option value="open">Aberta</option><option value="waiting_customer">Aguardando cliente</option><option value="resolved">Resolvida</option></select></label></>}
      <label>Tipo<select className="business-input" value={draft.kind || "all"} onChange={event => setDraft({ ...draft, kind: event.target.value as AttendanceFilter["kind"] })}><option value="all">Todos</option><option value="individual">Individual</option><option value="group">Grupo</option></select></label>
      <label className="is-check"><input type="checkbox" checked={!!draft.unread} onChange={event => setDraft({ ...draft, unread: event.target.checked })} />Somente não lidas</label>
      <div className="nx-whatsapp-filter-dates"><label>De<input type="date" className="business-input" min="1970-01-01" max="2100-12-31" value={draft.fromDate || ""} onChange={event => setDraft({ ...draft, fromDate: event.target.value })} /></label>
        <label>Até<input type="date" className="business-input" min="1970-01-01" max="2100-12-31" value={draft.toDate || ""} onChange={event => setDraft({ ...draft, toDate: event.target.value })} /></label></div>
      <small className="business-note">Período da última mensagem, no horário de Brasília.</small>
      <fieldset className="nx-whatsapp-label-choices"><legend>Com todas as etiquetas selecionadas</legend>{tags.map(tag => <label key={tag.id} className="nx-whatsapp-label-choice"><input type="checkbox"
        checked={!!draft.tagIds?.includes(tag.id)} disabled={!draft.tagIds?.includes(tag.id) && (draft.tagIds?.length || 0) >= 20}
        onChange={event => setDraft({ ...draft, tagIds: event.target.checked ? [...(draft.tagIds || []), tag.id] : draft.tagIds?.filter(id => id !== tag.id) })} />
        <Tag size={14} style={{ color: tag.color }} />{tag.name}</label>)}</fieldset>
      <Button size="sm" onClick={() => setManage(true)}>Gerenciar etiquetas</Button>
      <label>Nome da visão<input className="business-input" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
      {canShare && <label className="is-check"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />Compartilhar nova visão com a equipe</label>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || name.trim().length < 2} onClick={() => void saveView()}>Salvar nova visão</Button>
        {editedView?.canEdit && <><Button size="sm" disabled={busy || name.trim().length < 2} onClick={() => void saveView(editedView)}>Atualizar visão selecionada</Button><Button size="sm" disabled={busy} onClick={() => void removeView(editedView)}>Remover visão selecionada</Button></>}</div>
      {error && <p className="business-error" role="alert">{error}</p>}
      <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" disabled={busy} onClick={() => { if (valid()) { setOpen(false); setFilter?.(draft); } }}>Aplicar filtros</Button></footer>
    </div></BusinessDialog>}
    {manage && <TagManager tagScope="contact" onClose={() => setManage(false)} />}
  </div>;
}
