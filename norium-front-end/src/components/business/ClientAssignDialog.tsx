import { useEffect, useState } from "react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import type { Client } from "../clients/clientModel";
import Button from "../shared/Button";
import BusinessDialog from "./BusinessDialog";

type Outcome = { id: string; status: "updated" | "conflict" | "not_allowed" | "assignee_no_access" | "reload_required" };
type Result = { items: Outcome[]; updated: number; total: number };
const descriptions: Record<Outcome["status"], string> = {
  updated: "Responsável atualizado",
  conflict: "O cadastro mudou. Recarregue e confira antes de tentar novamente.",
  not_allowed: "Cadastro indisponível ou sem permissão de edição.",
  assignee_no_access: "A pessoa não tem acesso a este cadastro. Revise o compartilhamento na ficha.",
  reload_required: "Recarregue a lista para conferir o resultado antes de uma nova alteração.",
};

export default function ClientAssignDialog({ clients, onClose, onComplete }: {
  clients: Client[]; onClose: () => void; onComplete: () => void;
}) {
  const [dialogScope] = useState(requestScope);
  const [selection] = useState(() => clients.map(client => ({ id: client.id, name: client.name, expectedUpdatedAt: client.updatedAt })));
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    const controller = new AbortController(), scope = requestScope();
    void apiRequest<{ items: typeof members }>("/api/business/clients/assignees", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted && requestScope() === scope) setMembers(data.items); })
      .catch(reason => { if (!controller.signal.aborted && requestScope() === scope) setError(reason instanceof Error ? reason.message : "Não foi possível consultar a equipe."); })
      .finally(() => { if (!controller.signal.aborted && requestScope() === scope) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function confirm() {
    if (requestScope() !== dialogScope || busy || loading || result) return;
    setBusy(true); setError(""); const scope = requestScope();
    try {
      const data = await apiRequest<Result>("/api/business/clients/assign", { method: "POST",
        body: JSON.stringify({ userId, clients: selection.map(({ id, expectedUpdatedAt }) => ({ id, expectedUpdatedAt })) }) });
      if (requestScope() === scope) { setResult(data); onComplete(); }
    } catch (reason) {
      if (requestScope() === scope) { setError(reason instanceof Error ? reason.message : "Não foi possível concluir. Recarregue a lista antes de repetir."); onComplete(); }
    } finally { if (requestScope() === scope) setBusy(false); }
  }
  return <BusinessDialog title="Responsável pelos clientes selecionados" busy={busy} onClose={onClose}>
    <div className="business-form">
      <p>Confira os {selection.length} cadastros selecionados antes de confirmar.</p>
      <label>Responsável<select className="business-input" value={userId} disabled={loading || busy || !!result} onChange={event => setUserId(event.target.value)}>
        <option value="">Sem responsável</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></label>
      {loading && <p role="status">Carregando equipe…</p>}
      <p className="business-note">A pessoa precisa ter acesso à ficha. Esta alteração mantém as permissões e o proprietário do cadastro.</p>
      {error && <p role="alert" className="business-error">{error}</p>}
      {result && <p role="status">{result.updated} de {result.total} cadastros atualizados.</p>}
      <ul className="business-selection-list">{selection.map(client => {
        const outcome = result?.items.find(item => item.id === client.id);
        return <li key={client.id}><strong>{client.name}</strong>{outcome && <span className={outcome.status === "updated" ? "business-note" : "business-error"}>{descriptions[outcome.status]}</span>}</li>;
      })}</ul>
      <footer><Button disabled={busy} onClick={onClose}>{result ? "Fechar" : "Cancelar"}</Button>
        {!result && <Button variant="primary" loading={busy} disabled={loading || !!error || !selection.length || selection.length > 100} onClick={() => void confirm()}>
          {userId ? "Confirmar responsável" : "Confirmar sem responsável"}
        </Button>}
      </footer>
    </div>
  </BusinessDialog>;
}
