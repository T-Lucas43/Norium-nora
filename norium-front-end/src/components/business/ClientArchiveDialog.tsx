import { useState } from "react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import type { Client } from "../clients/clientModel";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";

type Status = "updated" | "unchanged" | "conflict" | "not_allowed" | "reload_required";
type Result = { items: { id: string; status: Status }[]; updated: number; total: number };
const descriptions: Record<Status, string> = {
  updated: "Concluído",
  unchanged: "O cadastro já estava neste estado",
  conflict: "O cadastro mudou. Recarregue e confira antes de tentar novamente.",
  not_allowed: "Cadastro indisponível ou sem permissão de edição.",
  reload_required: "Recarregue a lista para conferir o resultado antes de repetir.",
};

export default function ClientArchiveDialog({ clients, archived, onClose, onComplete, onClear }: {
  clients: Client[]; archived: boolean; onClose: () => void; onComplete: () => void; onClear?: () => void;
}) {
  const [scope] = useState(requestScope);
  const [selection] = useState(() => clients.map(client => ({ id: client.id, name: client.name, expectedUpdatedAt: client.updatedAt })));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  function close() { if (result) onClear?.(); onClose(); }
  async function confirm() {
    if (requestScope() !== scope || busy || result || error || !selection.length || selection.length > 100) return;
    setBusy(true);
    try {
      const data = await apiRequest<Result>("/api/business/clients/archive", { method: "POST",
        body: JSON.stringify({ archived, clients: selection.map(({ id, expectedUpdatedAt }) => ({ id, expectedUpdatedAt })) }) });
      if (requestScope() === scope) { setResult(data); onComplete(); }
    } catch (reason) {
      if (requestScope() === scope) { setError(reason instanceof Error ? reason.message : "Recarregue a lista para conferir o resultado antes de repetir."); onComplete(); }
    } finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title={archived ? "Arquivar clientes" : "Restaurar clientes"} busy={busy} onClose={close}>
    <div className="business-form">
      <p>{archived ? "Os cadastros sairão da lista em uso e poderão ser restaurados pela visão Arquivados." : "Os cadastros voltarão à lista em uso com o status e as informações preservados."}</p>
      <p className="business-note">Histórico, arquivos, documentos vinculados e compartilhamento serão mantidos.</p>
      {error && <p role="alert" className="business-error">{error}</p>}
      {result && <p role="status">{result.updated} de {result.total} cadastros alterados. Confira o resultado de cada um.</p>}
      <ul className="business-selection-list">{selection.map(client => {
        const outcome = result?.items.find(item => item.id === client.id);
        return <li key={client.id}><strong>{client.name}</strong>{outcome && <span className={outcome.status === "updated" || outcome.status === "unchanged" ? "business-note" : "business-error"}>{descriptions[outcome.status]}</span>}</li>;
      })}</ul>
      <footer><Button disabled={busy} onClick={close}>{result || error ? "Fechar" : "Cancelar"}</Button>
        {!result && !error && <Button variant="primary" loading={busy} disabled={!selection.length || selection.length > 100} onClick={() => void confirm()}>
          {archived ? "Confirmar arquivamento" : "Confirmar restauração"} ({selection.length})
        </Button>}
      </footer>
    </div>
  </BusinessDialog>;
}
