import { useEffect, useRef, useState } from "react";
import { Archive, CheckCheck, Check, Tag, UserRound } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";
import BusinessDialog from "../business/BusinessDialog";
import Button from "../shared/Button";
import ConfirmDialog from "../shared/ConfirmDialog";
import type { ChatConversa } from "./types";
import { useWhatsAppScope } from "./WhatsAppScope";
import type { TeamMember } from "./TeamAttendance";

export default function ConversationBulkBar({ ids, conversations, onTags, onClear, onExport, onUpdated }: {
  ids: string[]; conversations: ChatConversa[]; onTags: () => void; onClear: () => void; onExport: () => void; onUpdated: () => void;
}) {
  const { inboxId, prefix } = useWhatsAppScope(), scope = requestScope();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [assign, setAssign] = useState(false), [resolve, setResolve] = useState(false), [target, setTarget] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]), [loading, setLoading] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!assign || !inboxId) return;
    const controller = new AbortController(); setLoading(true); setError("");
    void apiRequest<{ items: TeamMember[] }>(`${prefix}/membros`, { signal: controller.signal })
      .then(result => {
        if (!result || !Array.isArray(result.items)) throw new Error("Não foi possível consultar os responsáveis.");
        if (!controller.signal.aborted && requestScope() === scope) setMembers(result.items);
      })
      .catch(err => { if (!controller.signal.aborted && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível consultar os responsáveis."); })
      .finally(() => { if (!controller.signal.aborted && requestScope() === scope) setLoading(false); });
    return () => controller.abort();
  }, [assign, inboxId, prefix, scope]);
  async function run(acao: "arquivar" | "lida" | "atribuir" | "resolver") {
    if (busy || !ids.length || ids.length > 200 || requestScope() !== scope) return;
    setBusy(true); setError("");
    const versions = Object.fromEntries(conversations.filter(row => ids.includes(row.id)).map(row => [row.id, row.assignee?.version ?? 0]));
    const parametros = acao === "atribuir" || acao === "resolver" ? { versions, ...(acao === "atribuir" ? { assigneeUserId: target || null } : {}) } : { valor: true };
    try {
      await apiRequest("/api/chat/conversas/lote", { method: "POST", body: JSON.stringify({ ids, inboxId, acao, parametros }) });
      if (!active.current || requestScope() !== scope) return;
      setAssign(false); setResolve(false); onClear(); onUpdated();
    } catch (err) { if (active.current && requestScope() === scope) setError(err instanceof Error ? err.message : "Não foi possível alterar a seleção."); }
    finally { if (active.current && requestScope() === scope) setBusy(false); }
  }
  return <div className="business-conversation-bulk nx-whatsapp-bulk" role="region" aria-label="Ações para conversas selecionadas">
    <strong>{ids.length}/200 selecionadas</strong>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" icon={<Tag size={14} />} disabled={!ids.length || busy} onClick={onTags}>Etiquetar</Button>
      {inboxId && <><Button size="sm" icon={<UserRound size={14} />} disabled={!ids.length || busy} onClick={() => setAssign(true)}>Atribuir</Button>
        <Button size="sm" icon={<Check size={14} />} disabled={!ids.length || busy} onClick={() => setResolve(true)}>Resolver</Button></>}
      <Button size="sm" icon={<Archive size={14} />} disabled={!ids.length || busy} onClick={() => void run("arquivar")}>Arquivar</Button>
      <Button size="sm" icon={<CheckCheck size={14} />} title="Marca como lida no Norium, sem enviar recibos ao WhatsApp" disabled={!ids.length || busy} onClick={() => void run("lida")}>Marcar como lida</Button>
      <Button size="sm" disabled={!ids.length || busy} onClick={onExport}>Exportar contatos</Button>
      <Button size="sm" disabled={busy} onClick={onClear}>Limpar</Button>
    </div>
    {error && <p role="alert" className="business-error">{error}</p>}
    {assign && <BusinessDialog className="nx-whatsapp-dialog" title="Atribuir seleção" busy={busy} onClose={() => setAssign(false)}><div className="business-form">
      <p>O acesso de quem atendia anteriormente será atualizado.</p>
      <label>Responsável<select className="business-input" disabled={loading || busy} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">Sem responsável</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></label>
      {error && <p role="alert" className="business-error">{error}</p>}
      <footer><Button disabled={busy} onClick={() => setAssign(false)}>Cancelar</Button><Button variant="primary" loading={busy} disabled={loading} onClick={() => void run("atribuir")}>Confirmar atribuição</Button></footer>
    </div></BusinessDialog>}
    {resolve && <ConfirmDialog title="Resolver seleção?" description={`Marcar ${ids.length} conversas como resolvidas. Uma nova resposta do cliente reabre o atendimento.`}
      confirmLabel="Resolver conversas" busy={busy} onConfirm={() => void run("resolver")} onCancel={() => setResolve(false)} />}
  </div>;
}
