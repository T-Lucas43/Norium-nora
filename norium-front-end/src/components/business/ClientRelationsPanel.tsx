import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import { showConfirm } from "../shared/AppDialogProvider";
import BusinessDialog from "./BusinessDialog";

type Kind = "proposal" | "contract";
type Relation = { type: Kind; id: string; title: string; status: string; origin: string; version: number | null; canUnlink: boolean };
type Page = { items: Relation[]; total: number; nextOffset: number | null };
type Option = { type: Kind; id: string; title: string; status: string; linked: boolean };
const kindLabel = (kind: Kind) => kind === "proposal" ? "Proposta" : "Contrato";

function openDocument(item: Relation) {
  const link = { tab: "Propostas", entityType: item.type, entityId: item.id };
  localStorage.setItem("norium-deep-link", JSON.stringify(link));
  window.dispatchEvent(new CustomEvent("norium:deep-link", { detail: link }));
}

export default function ClientRelationsPanel({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const scope = requestScope(); const [page, setPage] = useState<Page>({ items: [], total: 0, nextOffset: null });
  const [offset, setOffset] = useState(0); const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true); setError("");
    try { const data = await apiRequest<Page>(`/api/business/clients/${encodeURIComponent(clientId)}/relations?offset=${offset}&limit=25`, { signal });
      if (!Array.isArray(data.items)) throw new Error("Resposta inválida ao consultar documentos vinculados.");
      if (!signal.aborted && requestScope() === scope) setPage(data);
    } catch (err) { if (!signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível consultar os documentos vinculados."); }
    finally { if (!signal.aborted && requestScope() === scope) setLoading(false); }
  }, [clientId, offset, scope]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, revision]);
  useEffect(() => { setPage({ items: [], total: 0, nextOffset: null }); setOffset(0); setOpen(false); setBusy(false); }, [clientId, scope]);
  useEffect(() => { const update = (event: Event) => { if ((event as CustomEvent<{ clientId: string }>).detail?.clientId === clientId && requestScope() === scope) setRevision(value => value+1); };
    window.addEventListener("norium:client-relations-changed", update); return () => window.removeEventListener("norium:client-relations-changed", update);
  }, [clientId, scope]);
  async function remove(item: Relation) {
    if (busy || !canEdit || !item.canUnlink || item.version == null) return;
    const confirmed = await showConfirm({ title: "Desvincular documento?", description: `“${item.title}” continuará em Documentos. Seu compartilhamento será preservado.`, confirmLabel: "Desvincular", tone: "danger" });
    if (!confirmed || requestScope() !== scope) return; setBusy(true); setError("");
    try { await apiRequest(`/api/business/clients/${encodeURIComponent(clientId)}/relations/${item.type}/${encodeURIComponent(item.id)}?expectedVersion=${item.version}`, { method: "DELETE" });
      if (requestScope() === scope) setRevision(value => value+1);
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível desfazer o vínculo."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  return <section className="client-block">
    <div className="business-toolbar"><h3 className="flex items-center gap-2"><Link2 size={16} />Documentos vinculados</h3>{canEdit && <Button size="sm" onClick={() => setOpen(true)}>Vincular</Button>}</div>
    {loading && <p className="business-note" role="status">Consultando documentos…</p>}
    {error && <p className="business-error" role="alert">{error}</p>}
    {!loading && !error && !page.total && <p className="business-note">Nenhuma proposta ou contrato vinculado e disponível para seu acesso.</p>}
    <div className="business-relations-list">{page.items.map(item => <div className="business-toolbar" key={`${item.type}:${item.id}`}>
      <div className="min-w-0"><button type="button" className="business-relation-title" onClick={() => openDocument(item)}>{item.title}<ExternalLink size={13} /></button><small className="business-note">{kindLabel(item.type)}{item.origin === "primary" ? " · Cliente principal" : ""}</small></div>
      {canEdit && item.canUnlink && <Button size="sm" disabled={busy} icon={<Unlink size={13} />} aria-label={`Desvincular ${item.title}`} onClick={() => void remove(item)}>Desvincular</Button>}
    </div>)}</div>
    {(offset > 0 || page.nextOffset != null) && <div className="business-pagination"><Button size="sm" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value-25))}>Anterior</Button><Button size="sm" disabled={page.nextOffset == null || loading} onClick={() => setOffset(page.nextOffset ?? offset)}>Próxima</Button></div>}
    {open && <RelationPicker clientId={clientId} onClose={() => setOpen(false)} onLinked={() => { setOpen(false); setOffset(0); setRevision(value => value+1); }} />}
  </section>;
}

function RelationPicker({ clientId, onClose, onLinked }: { clientId: string; onClose: () => void; onLinked: () => void }) {
  const scope = requestScope(); const [kind, setKind] = useState<Kind>("proposal"); const [query, setQuery] = useState(""); const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ items: Option[]; total: number; nextOffset: number | null }>({ items: [], total: 0, nextOffset: null });
  const [choice, setChoice] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(""); setPage({ items: [], total: 0, nextOffset: null });
    const timer = window.setTimeout(() => {
      void apiRequest<typeof page>(`/api/business/clients/${encodeURIComponent(clientId)}/relation-options?kind=${kind}&query=${encodeURIComponent(query)}&offset=${offset}&limit=25`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted && requestScope() === scope) setPage(result); })
        .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível buscar os documentos."); })
        .finally(() => { if (!controller.signal.aborted && requestScope() === scope) setLoading(false); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [clientId, kind, query, offset, scope]);
  async function link() {
    if (!choice || busy || loading || requestScope() !== scope || !page.items.some(item => item.id === choice && !item.linked)) return;
    setBusy(true); setError("");
    try { await apiRequest(`/api/business/clients/${encodeURIComponent(clientId)}/relations`, { method: "POST", body: JSON.stringify({ resourceType: kind, resourceId: choice }) }); if (requestScope() === scope) onLinked(); }
    catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível vincular o documento."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title="Vincular documento ao cliente" busy={busy} onClose={onClose}><div className="business-form">
    <p className="business-note">Selecione uma proposta ou contrato que você pode editar. O vínculo organiza os registros e preserva as permissões de cada um.</p>
    <label>Tipo<select className="business-input" value={kind} onChange={event => { setKind(event.target.value as Kind); setChoice(""); setOffset(0); }}><option value="proposal">Proposta</option><option value="contract">Contrato</option></select></label>
    <label>Buscar documento<input className="business-input" value={query} maxLength={160} onChange={event => { setQuery(event.target.value); setChoice(""); setOffset(0); }} /></label>
    {loading && <p role="status">Buscando documentos…</p>}{error && <p className="business-error" role="alert">{error}</p>}
    {!loading && !error && !page.total && <p className="business-note">Nenhum documento disponível com esses critérios.</p>}
    <div className="business-relations-list">{page.items.map(item => <label className="business-relation-choice" key={item.id}><input type="radio" name="document-relation" value={item.id} disabled={item.linked || busy} checked={choice === item.id} onChange={() => setChoice(item.id)} /><span>{item.title}{item.linked && <small>Já vinculado</small>}</span></label>)}</div>
    <div className="business-pagination"><span>{page.total} documentos</span><div className="flex gap-2"><Button size="sm" disabled={!offset || loading || busy} onClick={() => { setOffset(value => Math.max(0, value-25)); setChoice(""); }}>Anterior</Button><Button size="sm" disabled={page.nextOffset == null || loading || busy} onClick={() => { setOffset(page.nextOffset ?? offset); setChoice(""); }}>Próxima</Button></div></div>
    <footer><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!choice || loading} onClick={() => void link()}>Vincular documento</Button></footer>
  </div></BusinessDialog>;
}
