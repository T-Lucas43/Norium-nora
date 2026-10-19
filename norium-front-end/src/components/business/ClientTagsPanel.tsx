import { useCallback, useEffect, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";
import TagManager from "./TagManager";
type Label = { id: string; name: string; color: string; scope: string };

export default function ClientTagsPanel({ clientId, conversationId, canEdit }: { clientId?: string; conversationId?: string; canEdit: boolean }) {
  const scope = requestScope();
  const resourceId = clientId || conversationId || "";
  const tagScope = conversationId ? "contact" : "client";
  const changePath = conversationId ? "/api/business/tags/conversations" : "/api/business/tags/clients";
  const resourceField = conversationId ? "conversationIds" : "clientIds";
  const [labels, setLabels] = useState<Label[]>([]); const [available, setAvailable] = useState<Label[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [open, setOpen] = useState(false);
  const [name, setName] = useState(""); const [color, setColor] = useState("#3b82f6"); const [selected, setSelected] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const [all, linked] = await Promise.all([apiRequest<{ items: Label[] }>(`/api/business/tags?scope=${tagScope}`, { signal }), apiRequest<{ items: Label[] }>(`/api/business/tags/${conversationId ? "conversation" : "client"}/${encodeURIComponent(resourceId)}`, { signal })]);
      if (!signal?.aborted && requestScope() === scope) { setAvailable(all.items); setLabels(linked.items); }
    } catch (err) { if (!signal?.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível consultar as etiquetas."); }
  }, [resourceId, tagScope, conversationId, scope]);
  useEffect(() => { const controller = new AbortController(); setLabels([]); setAvailable([]); setError(""); setOpen(false); setManageOpen(false); setBusy(false); setSelected(""); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { const refresh = () => void load(); window.addEventListener("norium:business-tags-changed", refresh); return () => window.removeEventListener("norium:business-tags-changed", refresh); }, [load]);
  async function apply(id: string, shouldApply: boolean) {
    if (busy || !canEdit || requestScope() !== scope) return; setBusy(true); setError("");
    try { await apiRequest(changePath, { method: "POST", body: JSON.stringify({ [resourceField]: [resourceId], tagId: id, apply: shouldApply }) });
      if (requestScope() !== scope) return;
      window.dispatchEvent(new Event(clientId ? "norium:client-tags-changed" : "norium:conversation-tags-changed")); await load(); setOpen(false); }
    catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao alterar etiquetas."); } finally { if (requestScope() === scope) setBusy(false); }
  }
  async function create() {
    if (busy || !canEdit || name.trim().length < 2 || requestScope() !== scope) return; setBusy(true); setError("");
    try { const result = await apiRequest<{ item: Label }>("/api/business/tags", { method: "POST", body: JSON.stringify({ name: name.trim(), color, scope: tagScope }) });
      if (requestScope() !== scope) return;
      await apiRequest(changePath, { method: "POST", body: JSON.stringify({ [resourceField]: [resourceId], tagId: result.item.id, apply: true }) });
      if (requestScope() !== scope) return;
      window.dispatchEvent(new Event(clientId ? "norium:client-tags-changed" : "norium:conversation-tags-changed"));
      await load(); setOpen(false); setName("");
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao criar etiqueta."); } finally { if (requestScope() === scope) setBusy(false); }
  }
  return <section className="client-block"><div className="business-toolbar"><h3 className="flex items-center gap-2"><Tag size={16} /> Etiquetas compartilhadas</h3>
    <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setManageOpen(true)}>Gerenciar</Button>{canEdit && <Button size="sm" icon={<Plus size={14} />} onClick={() => setOpen(true)}>Adicionar</Button>}</div></div>
    {error && <p role="alert" className="business-error">{error}</p>}
    <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>{labels.map(item => <span key={item.id} className="business-badge"><span aria-hidden="true" style={{ background: item.color, width: 7, height: 7, borderRadius: 9 }} />{item.name}
      {canEdit && <button type="button" disabled={busy} aria-label={`Remover etiqueta ${item.name}`} onClick={() => void apply(item.id, false)}><X size={13} /></button>}</span>)}</div>
    {!labels.length && <p className="business-note">Nenhuma etiqueta neste {conversationId ? "contato" : "cliente"}.</p>}
    {open && <BusinessDialog title={conversationId ? "Etiquetas do contato" : "Etiquetas do cliente"} busy={busy} onClose={() => setOpen(false)}>
      <div className="business-form"><label>Usar uma etiqueta existente<select className="business-input" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Selecione</option>{available.filter(item => !labels.some(current => current.id === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <Button disabled={!selected || busy} onClick={() => void apply(selected, true)}>Aplicar etiqueta</Button>
        <hr /><h3>Criar etiqueta</h3><label>Nome<input className="business-input" value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
        <label>Cor<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
        {error && <p role="alert" className="business-error">{error}</p>}
        <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" disabled={name.trim().length < 2} loading={busy} onClick={() => void create()}>Criar e aplicar</Button></footer></div>
    </BusinessDialog>}
    {manageOpen && <TagManager tagScope={conversationId ? "contact" : "client"} onClose={() => setManageOpen(false)} />}
  </section>;
}
