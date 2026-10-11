import "../../styles/screens/trabalho-comum.css";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, Pencil, ShieldCheck, UsersRound, X } from "lucide-react";
import { apiRequest } from "../../core/api/client";
import type { CommercialDocument, DocumentAccess, DocumentAccessPermission } from "../../features/commercial/types";
import { isProposal } from "../../features/commercial/types";
import { updateCommercialDocumentAccess } from "../../features/commercial/api";
import Button from "../shared/Button";

type TeamMember = { id: string; nome?: string; name?: string; email?: string; status?: string; fotoUrl?: string };

export default function DocumentAccessDialog({ document, onClose, onSaved }: {
  document: CommercialDocument;
  onClose: () => void;
  onSaved: (document: CommercialDocument) => void;
}) {
  const initial = document.access || { teamPermission: "none", people: [] };
  const [teamPermission, setTeamPermission] = useState<DocumentAccess["teamPermission"]>(initial.teamPermission);
  const [people, setPeople] = useState(() => new Map(initial.people.map((item) => [item.userId, item.permission])));
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ members: TeamMember[] }>("/api/team-chat/members")
      .then((response) => { if (active) setMembers(response.members.filter((item) => item.status === "ativo" && item.id !== document.createdBy)); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Não foi possível carregar a equipe."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [document.createdBy]);

  const selectedCount = people.size;
  const sortedMembers = useMemo(() => [...members].sort((a, b) => (a.nome || a.name || a.email || "").localeCompare(b.nome || b.name || b.email || "", "pt-BR")), [members]);

  function setPerson(userId: string, permission: DocumentAccessPermission | "none") {
    setPeople((current) => {
      const next = new Map(current);
      if (permission === "none") next.delete(userId);
      else next.set(userId, permission);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const updated = await updateCommercialDocumentAccess(isProposal(document) ? "proposal" : "contract", document.id, {
        teamPermission,
        people: [...people].map(([userId, permission]) => ({ userId, permission })),
      });
      onSaved(updated);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível salvar as permissões.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="nxw-remap fixed inset-0 z-[180] grid place-items-center bg-[rgba(12,13,16,.55)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="document-access-title" className="flex max-h-[min(760px,92dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] p-5">
          <div className="flex min-w-0 gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-400"><ShieldCheck size={19} /></span>
            <div><h2 id="document-access-title" className="truncate text-base font-black">Compartilhar “{document.title}”</h2><p className="mt-1 text-xs font-semibold text-[var(--text-secondary)]">Você é o proprietário e decide quem pode visualizar ou editar.</p></div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar permissões" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--border)] hover:bg-[var(--surface-hover)]"><X size={16} /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {error && <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300">{error}</p>}
          <section>
            <div className="mb-3 flex items-center gap-2"><UsersRound size={16} className="text-blue-400" /><div><h3 className="text-sm font-black">Equipe inteira</h3><p className="text-xs font-semibold text-[var(--text-secondary)]">A regra vale para todos os membros ativos.</p></div></div>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Permissão da equipe inteira">
              {(["none", "view", "edit"] as const).map((permission) => <button key={permission} type="button" aria-pressed={teamPermission === permission} onClick={() => setTeamPermission(permission)} className={`rounded-lg border px-3 py-3 text-xs font-black transition ${teamPermission === permission ? "border-blue-400 bg-blue-500/10 text-blue-300" : "border-[var(--border)] hover:bg-[var(--surface-hover)]"}`}>{permission === "none" ? "Sem acesso" : permission === "view" ? "Pode visualizar" : "Pode editar"}</button>)}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-black">Pessoas específicas</h3><p className="text-xs font-semibold text-[var(--text-secondary)]">A permissão individual pode ampliar o acesso dado à equipe.</p></div><span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-black">{selectedCount} selecionada{selectedCount === 1 ? "" : "s"}</span></div>
            {loading ? <p className="py-8 text-center text-sm font-bold text-[var(--text-secondary)]">Carregando membros…</p> : (
              <div className="divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-[var(--border)]">
                {sortedMembers.map((member) => {
                  const permission = people.get(member.id) || "none";
                  const name = member.nome || member.name || member.email || member.id;
                  return <div key={member.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-500/10 text-xs font-black text-blue-300">{name.slice(0, 2).toUpperCase()}</span><div className="min-w-0"><strong className="block truncate text-sm">{name}</strong>{member.email && <small className="block truncate font-semibold text-[var(--text-secondary)]">{member.email}</small>}</div></div>
                    <div className="flex gap-1.5">
                      <button type="button" aria-pressed={permission === "none"} onClick={() => setPerson(member.id, "none")} className={`rounded-md border px-2.5 py-2 text-xs font-bold ${permission === "none" ? "border-blue-400 text-blue-300" : "border-[var(--border)]"}`}>Sem acesso</button>
                      <button type="button" aria-pressed={permission === "view"} onClick={() => setPerson(member.id, "view")} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-bold ${permission === "view" ? "border-blue-400 bg-blue-500/10 text-blue-300" : "border-[var(--border)]"}`}><Eye size={13} /> Ver</button>
                      <button type="button" aria-pressed={permission === "edit"} onClick={() => setPerson(member.id, "edit")} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-bold ${permission === "edit" ? "border-blue-400 bg-blue-500/10 text-blue-300" : "border-[var(--border)]"}`}><Pencil size={13} /> Editar</button>
                    </div>
                  </div>;
                })}
                {!sortedMembers.length && <p className="p-5 text-center text-sm font-semibold text-[var(--text-secondary)]">Nenhum outro membro ativo nesta equipe.</p>}
              </div>
            )}
          </section>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[var(--border)] p-4"><p className="hidden text-xs font-semibold text-[var(--text-secondary)] sm:block">Somente você pode mudar estas permissões.</p><div className="ml-auto flex gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={() => void save()}>Salvar acesso</Button></div></footer>
      </section>
    </div>,
    globalThis.document.body,
  );
}
