import { useEffect, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";
import type { BusinessTag } from "./TagManager";

export default function SelectionTagDialog({ ids, target, onClose }: {
  ids: string[]; target: "clients" | "conversations" | "contacts"; onClose: () => void;
}) {
  const scope = requestScope(); const [labels, setLabels] = useState<BusinessTag[]>([]);
  const [selected, setSelected] = useState(""); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  useEffect(() => { const controller = new AbortController(); setLoading(true);
    void apiRequest<{ items: BusinessTag[] }>(`/api/business/tags?scope=${target === "clients" ? "client" : "contact"}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && requestScope() === scope) setLabels(result.items); })
      .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Falha ao consultar etiquetas."); })
      .finally(() => { if (!controller.signal.aborted && requestScope() === scope) setLoading(false); });
    return () => controller.abort();
  }, [scope, target]);
  async function apply(shouldApply: boolean) {
    if (!selected || busy || !ids.length || ids.length > 100 || requestScope() !== scope) return;
    setBusy(true); setError("");
    try { await apiRequest(`/api/business/tags/${target}`, { method: "POST", body: JSON.stringify({
        [target === "clients" ? "clientIds" : target === "contacts" ? "contactIds" : "conversationIds"]: ids, tagId: selected, apply: shouldApply }) });
      if (requestScope() !== scope) return;
      window.dispatchEvent(new Event(target === "clients" ? "norium:client-tags-changed" : "norium:conversation-tags-changed")); onClose();
    } catch (err) { if (requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível alterar as etiquetas da seleção."); }
    finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title={`Etiquetas de ${ids.length} ${target === "clients" ? "clientes" : target === "contacts" ? "contatos" : "conversas"}`} busy={busy} onClose={onClose}>
    <div className="business-form">
      {loading && <p role="status">Carregando etiquetas…</p>}
      <label>Etiqueta<select className="business-input" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Selecione</option>{labels.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
      {!loading && !labels.length && <p className="business-note">Crie uma etiqueta em Gerenciar etiquetas antes de aplicá-la à seleção.</p>}
      <p className="business-note">A alteração será aplicada à seleção, após conferir seu acesso a cada registro. Limite de 100 por lote.</p>
      {error && <p className="business-error" role="alert">{error}</p>}
      <footer><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy || !selected || loading} onClick={() => void apply(false)}>Remover etiqueta</Button><Button variant="primary" loading={busy} disabled={!selected || loading} onClick={() => void apply(true)}>Aplicar etiqueta</Button></footer>
    </div>
  </BusinessDialog>;
}
