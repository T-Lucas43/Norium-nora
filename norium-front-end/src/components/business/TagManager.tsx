import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Tag } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";

export type TagScope = "client" | "contact" | "conversation" | "opportunity";
export type BusinessTag = { id: string; name: string; color: string; scope: TagScope;
  active: boolean; version: number; canManage: boolean };

function announceTagsChanged() {
  window.dispatchEvent(new Event("norium:business-tags-changed"));
  window.dispatchEvent(new Event("norium:client-tags-changed"));
  window.dispatchEvent(new Event("norium:conversation-tags-changed"));
}

export default function TagManager({ tagScope, onClose }: { tagScope: TagScope; onClose: () => void }) {
  const scope = requestScope(); const [items, setItems] = useState<BusinessTag[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [draft, setDraft] = useState<BusinessTag | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try { const result = await apiRequest<{ items: BusinessTag[] }>(`/api/business/tags?scope=${tagScope}&includeArchived=true`, { signal });
      if (!signal?.aborted && requestScope() === scope) setItems(result.items);
    } catch (err) { if (!signal?.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível consultar as etiquetas."); }
    finally { if (!signal?.aborted && requestScope() === scope) setLoading(false); }
  }, [tagScope, scope]);
  useEffect(() => { const controller = new AbortController(); setItems([]); setDraft(null); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy || requestScope() !== scope) return; setBusy(true); setError("");
    try { await apiRequest(`/api/business/tags/${encodeURIComponent(draft.id)}`, { method: "PUT", body: JSON.stringify({
        name: draft.name, color: draft.color, active: draft.active, expectedVersion: draft.version }) });
      if (requestScope() !== scope) return;
      setDraft(null); announceTagsChanged(); await load();
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível salvar a etiqueta. Recarregue para conferir a versão atual."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title="Gerenciar etiquetas" busy={busy} onClose={onClose}>
    <div className="business-form">
      <p className="business-note">Quem criou a etiqueta e os gestores podem editar seu nome, cor e situação. As alterações aparecem nas fichas e filtros deste espaço de trabalho.</p>
      {error && <p role="alert" className="business-error">{error}</p>}
      {loading && <p role="status">Carregando etiquetas…</p>}
      {!loading && !items.length && <p className="business-note">Nenhuma etiqueta cadastrada. Crie a primeira na ficha de um cliente ou contato.</p>}
      <div className="business-tag-manager-list">{items.map(item => <div className="business-toolbar" key={item.id}>
        <span className="business-badge"><Tag size={13} style={{ color: item.color }} />{item.name}{!item.active && " · Arquivada"}</span>
        {item.canManage ? <Button size="sm" disabled={busy} icon={<Pencil size={13} />} onClick={() => { setDraft({ ...item }); setError(""); }}>Editar</Button> : <small className="business-note">Somente leitura</small>}
      </div>)}</div>
      {draft && <form className="business-form" onSubmit={event => void save(event)}>
        <h3>Editar {draft.name}</h3>
        <label>Nome<input className="business-input" required minLength={2} maxLength={60} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Cor<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
        <label className="is-check"><input type="checkbox" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })} />Etiqueta ativa</label>
        {!draft.active && <p className="business-note">Ao arquivar, ela sai das listas e filtros. Seus vínculos ficam preservados para uma eventual reativação.</p>}
        <footer><Button disabled={busy} onClick={() => setDraft(null)}>Cancelar edição</Button><Button type="submit" variant="primary" loading={busy} disabled={draft.name.trim().length < 2}>Salvar alterações</Button></footer>
      </form>}
      <footer><Button disabled={busy} onClick={onClose}>Concluir</Button></footer>
    </div>
  </BusinessDialog>;
}
