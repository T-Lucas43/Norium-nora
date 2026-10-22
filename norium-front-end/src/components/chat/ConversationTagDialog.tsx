import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Tag } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import BusinessDialog from "../business/BusinessDialog";
import Button from "../shared/Button";
import { useWhatsAppScope } from "./WhatsAppScope";

type Label = { id: string; name: string; color: string; selectedCount: number };
type Projection = { items: Label[]; totalContacts: number };

function LabelCheck({ label, total, changed, onChange, disabled }: {
  label: Label; total: number; changed?: boolean; onChange: (value: boolean) => void; disabled: boolean;
}) {
  const mixed = changed === undefined && label.selectedCount > 0 && label.selectedCount < total;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="nx-whatsapp-label-choice">
    <input ref={ref} type="checkbox" checked={changed ?? (total > 0 && label.selectedCount === total)}
      aria-checked={mixed ? "mixed" : changed ?? (total > 0 && label.selectedCount === total)}
      disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <Tag size={15} style={{ color: label.color }} /><span>{label.name}</span>
    <small>{changed === undefined ? label.selectedCount : changed ? total : 0}/{total} contatos</small>
  </label>;
}

/** Selection counts come from canonical contacts, including explicit PN/LID aliases. */
export default function ConversationTagDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { inboxId } = useWhatsAppScope(), scope = requestScope();
  const signature = [...new Set(ids)].join("\0");
  const [projection, setProjection] = useState<Projection>({ items: [], totalContacts: 0 });
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState(""), [name, setName] = useState(""), [color, setColor] = useState("#3b82f6");
  const [creating, setCreating] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(true);
  const valid = () => active.current && requestScope() === scope;
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await apiRequest<Projection>("/api/chat/conversas/lote/etiquetas", {
        method: "POST", body: JSON.stringify({ ids: signature.split("\0"), inboxId }), signal,
      });
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.totalContacts) || result.totalContacts < 1 || result.totalContacts > 200)
        throw new Error("Não foi possível carregar as etiquetas desta seleção.");
      if (active.current && !signal?.aborted && requestScope() === scope) setProjection(result);
    } catch (err) { if (active.current && !signal?.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível carregar as etiquetas."); }
    finally { if (active.current && !signal?.aborted && requestScope() === scope) setLoading(false); }
  }, [signature, inboxId, scope]);
  useEffect(() => {
    active.current = true; const controller = new AbortController(); setChanges({}); void load(controller.signal);
    return () => { active.current = false; controller.abort(); };
  }, [load]);
  async function save() {
    if (busy || !valid() || !Object.keys(changes).length || Object.keys(changes).length > 20) return;
    setBusy(true); setError("");
    try {
      await apiRequest("/api/chat/conversas/lote", { method: "POST", body: JSON.stringify({ ids, inboxId, acao: "etiquetar",
        parametros: { changes: Object.entries(changes).map(([tagId, apply]) => ({ tagId, apply })) } }) });
      if (!valid()) return;
      window.dispatchEvent(new Event("norium:conversation-tags-changed")); onClose();
    } catch (err) { if (valid()) setError(err instanceof Error ? err.message : "Não foi possível salvar as etiquetas."); }
    finally { if (valid()) setBusy(false); }
  }
  async function create() {
    if (busy || name.trim().length < 2 || !valid()) return;
    setBusy(true); setError("");
    try {
      const result = await apiRequest<{ item: Label }>("/api/business/tags", { method: "POST", body: JSON.stringify({ name: name.trim(), color, scope: "contact" }) });
      if (!valid()) return;
      setChanges(current => ({ ...current, [result.item.id]: true })); setName(""); setCreating(false); setQuery("");
      window.dispatchEvent(new Event("norium:business-tags-changed")); await load();
    } catch (err) { if (valid()) setError(err instanceof Error ? err.message : "Não foi possível criar a etiqueta."); }
    finally { if (valid()) setBusy(false); }
  }
  return <BusinessDialog className="nx-whatsapp-dialog" title="Etiquetas dos contatos" busy={busy} onClose={onClose}>
    <div className="business-form">
      <p>{loading ? "Carregando etiquetas…" : `${projection.totalContacts} contatos selecionados`}</p>
      <label className="nx-conv-search"><Search size={15} /><input aria-label="Buscar etiqueta" placeholder="Buscar etiqueta" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="nx-whatsapp-label-choices">
        {projection.items.filter(label => label.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(label => <LabelCheck key={label.id}
          label={label} total={projection.totalContacts} changed={changes[label.id]} disabled={busy || loading}
          onChange={value => setChanges(current => ({ ...current, [label.id]: value }))} />)}
        {!loading && !projection.items.length && <p className="business-note">Nenhuma etiqueta cadastrada.</p>}
      </div>
      <Button size="sm" icon={<Plus size={14} />} disabled={busy} onClick={() => { setCreating(value => !value); setName(query.slice(0, 60)); }}>Criar etiqueta</Button>
      {creating && <div className="nx-whatsapp-label-create">
        <label>Nome da etiqueta<input className="business-input" maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Cor<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
        <Button disabled={busy || name.trim().length < 2} onClick={() => void create()}>Criar</Button>
      </div>}
      <p className="business-note">Etiquetas valem para o contato em Conversas, Clientes, Caixa de entrada e nas regras da Nora.</p>
      {Object.keys(changes).length > 20 && <p role="alert">Altere até 20 etiquetas por vez.</p>}
      {error && <p className="business-error" role="alert">{error}</p>}
      <footer><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy}
        disabled={loading || !Object.keys(changes).length || Object.keys(changes).length > 20} onClick={() => void save()}>Salvar etiquetas</Button></footer>
    </div>
  </BusinessDialog>;
}
