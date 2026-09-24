import { useEffect, useState } from "react";
import { BriefcaseBusiness, CheckSquare2, Clock3, Eye, FileText, Mail, MessageCircle, Phone, UserRound, UsersRound, X } from "lucide-react";
import type { NoriumUser } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import Button from "../shared/Button";
import { formatMemberLastAccess } from "./teamMemberPresence";

type ProfileItem = { id?: string; title?: string; name?: string; company?: string; status?: string; dueDate?: string; accessRole?: string };
type FullProfile = {
  team?: { name?: string } | null;
  pendingTasks: ProfileItem[];
  sharedClients: ProfileItem[];
  sharedProposals: ProfileItem[];
  sharedDocuments: ProfileItem[];
  counts: { pendingTasks: number; clients: number; proposals: number; documents: number };
};

function memberInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

function Collection({ title, icon: Icon, items, empty }: { title: string; icon: typeof CheckSquare2; items: ProfileItem[]; empty: string }) {
  return <section className="rounded-2xl border border-white/10 bg-[#0c121c] p-4">
    <h3 className="flex items-center gap-2 text-sm font-black"><Icon size={16} className="text-cyan-300" />{title}<span className="ml-auto rounded-full bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-200">{items.length}</span></h3>
    <div className="mt-3 grid gap-2">
      {items.slice(0, 8).map((item, index) => <div key={item.id || `${title}-${index}`} className="rounded-xl border border-white/8 bg-black/20 px-3 py-2"><strong className="block truncate text-xs">{item.title || item.name || "Item compartilhado"}</strong><small className="mt-0.5 block truncate text-slate-400">{item.company || item.status || item.dueDate || item.accessRole || "Vinculado ao membro"}</small></div>)}
      {!items.length && <p className="py-2 text-xs font-semibold text-slate-500">{empty}</p>}
    </div>
  </section>;
}

export default function TeamMemberPresenceDialog({ member, online, isCurrentUser, token, onClose, onMessage, onCall }: {
  member: NoriumUser;
  online: boolean;
  isCurrentUser: boolean;
  token: string;
  onClose: () => void;
  onMessage: () => void;
  onCall: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!expanded || profile || loading) return;
    setLoading(true); setError("");
    authJson<FullProfile>(`/api/team-chat/members/${encodeURIComponent(member.id)}/profile`, token)
      .then(setProfile)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Não foi possível carregar o perfil completo."))
      .finally(() => setLoading(false));
  }, [expanded, loading, member.id, profile, token]);

  return <div className="fixed inset-0 z-[170] grid place-items-center bg-black/80 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label={`Detalhes de ${member.nome}`} className={`max-h-[92dvh] w-full overflow-y-auto rounded-3xl border border-cyan-400/30 bg-[#070b12] text-white shadow-2xl shadow-black/70 transition-all ${expanded ? "max-w-5xl" : "max-w-md"}`} onClick={(event) => event.stopPropagation()}>
      <div className="relative overflow-hidden rounded-t-3xl bg-gradient-to-br from-blue-600/35 via-cyan-500/15 to-transparent p-6">
        <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar detalhes do membro" className="absolute right-4 top-4"><X size={18} /></Button>
        <div className="flex items-center gap-4 pr-12">
          {member.fotoUrl ? <img src={member.fotoUrl} alt="" className="h-20 w-20 shrink-0 rounded-full border-2 border-cyan-300/50 object-cover shadow-xl" /> : <span className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-2 border-cyan-300/50 bg-blue-500/20 text-xl font-black text-blue-100">{memberInitials(member.nome)}</span>}
          <div className="min-w-0"><h2 className="truncate text-2xl font-black">{member.nome}</h2><p className="truncate text-sm font-semibold text-slate-300">{member.jobTitle || "Membro da equipe"}</p><p className={`mt-2 flex items-center gap-2 text-xs font-bold ${online ? "text-emerald-300" : "text-slate-400"}`}>{online ? <><span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.8)]" /><span>Online agora</span></> : <><Clock3 size={14} /><span>Offline</span><span>· {formatMemberLastAccess(member.lastLoginAt)}</span></>}</p></div>
        </div>
      </div>
      <div className="p-5">
        <div className={`grid gap-2 ${isCurrentUser ? "grid-cols-1" : "grid-cols-3"}`}>
          {!isCurrentUser && <><Button variant="secondary" onClick={onMessage} icon={<MessageCircle size={16} />}>Conversar</Button><Button onClick={onCall} icon={<Phone size={16} />}>Ligar</Button></>}
          <Button variant="secondary" onClick={() => setExpanded((value) => !value)} icon={<Eye size={16} />}>{expanded ? "Fechar detalhes" : "Perfil completo"}</Button>
        </div>
        {isCurrentUser && !expanded && <p className="mt-4 flex items-center justify-center gap-2 text-xs font-semibold text-slate-400"><UserRound size={14} /> Este é o seu perfil</p>}
        {expanded && <div className="mt-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-[#0c121c] p-4"><Mail size={17} className="text-cyan-300"/><small className="mt-3 block text-slate-500">E-mail</small><strong className="mt-1 block break-all text-sm">{member.email}</strong></div>
            <div className="rounded-2xl border border-white/10 bg-[#0c121c] p-4"><UsersRound size={17} className="text-cyan-300"/><small className="mt-3 block text-slate-500">Equipe</small><strong className="mt-1 block text-sm">{profile?.team?.name || (loading ? "Carregando…" : "Equipe Norium")}</strong></div>
            <div className="rounded-2xl border border-white/10 bg-[#0c121c] p-4"><BriefcaseBusiness size={17} className="text-cyan-300"/><small className="mt-3 block text-slate-500">Cargo e posição</small><strong className="mt-1 block text-sm">{member.jobTitle || "Membro"}</strong></div>
          </div>
          {loading && <p className="py-12 text-center text-sm font-bold text-cyan-200">Reunindo vínculos permitidos deste perfil…</p>}
          {error && <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm font-semibold text-red-200">{error}</div>}
          {profile && <div className="mt-4 grid gap-3 md:grid-cols-2"><Collection title="Tarefas pendentes" icon={CheckSquare2} items={profile.pendingTasks} empty="Nenhuma tarefa pendente vinculada." /><Collection title="Clientes compartilhados" icon={UsersRound} items={profile.sharedClients} empty="Nenhum cliente compartilhado." /><Collection title="Propostas compartilhadas" icon={BriefcaseBusiness} items={profile.sharedProposals} empty="Nenhuma proposta compartilhada." /><Collection title="Documentos compartilhados" icon={FileText} items={profile.sharedDocuments} empty="Nenhum documento compartilhado." /></div>}
        </div>}
      </div>
    </section>
  </div>;
}
