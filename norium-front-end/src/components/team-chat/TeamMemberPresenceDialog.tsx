import { Clock3, MessageCircle, Phone, UserRound, X } from "lucide-react";
import type { NoriumUser } from "../../types/auth";
import Button from "../shared/Button";
import { formatMemberLastAccess } from "./teamMemberPresence";

function memberInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "N"}${parts[1]?.[0] || ""}`.toUpperCase();
}

export default function TeamMemberPresenceDialog({
  member,
  online,
  isCurrentUser,
  onClose,
  onMessage,
  onCall,
}: {
  member: NoriumUser;
  online: boolean;
  isCurrentUser: boolean;
  onClose: () => void;
  onMessage: () => void;
  onCall: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[170] grid place-items-center bg-black/80 p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Detalhes de ${member.nome}`}
        className="w-full max-w-sm rounded-2xl border border-blue-500/35 bg-[#070b12] p-5 text-white shadow-2xl shadow-black/70"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {member.fotoUrl ? (
              <img src={member.fotoUrl} alt="" className="h-12 w-12 shrink-0 rounded-full border border-blue-400/35 object-cover" />
            ) : (
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-blue-400/35 bg-blue-500/15 text-sm font-black text-blue-100">
                {memberInitials(member.nome)}
              </span>
            )}
            <div className="min-w-0">
              <h2 className="truncate text-base font-black">{member.nome}</h2>
              <p className="truncate text-xs font-semibold text-slate-400">{member.jobTitle || "Membro da equipe"}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar detalhes do membro"><X size={18} /></Button>
        </div>

        <div className="mt-5 rounded-xl border border-white/10 bg-[#0c121c] p-4">
          <div className="flex items-center gap-3">
            {online ? <span className="h-3 w-3 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.75)]" /> : <Clock3 size={16} className="text-blue-300" />}
            <div>
              <strong className={online ? "text-sm text-emerald-300" : "text-sm text-slate-100"}>{online ? "Online agora" : "Offline"}</strong>
              {!online && <p className="mt-1 text-xs font-semibold text-slate-400">{formatMemberLastAccess(member.lastLoginAt)}</p>}
            </div>
          </div>
        </div>

        {!isCurrentUser && (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={onMessage} icon={<MessageCircle size={16} />}>Mensagem</Button>
            <Button onClick={onCall} icon={<Phone size={16} />}>Ligar</Button>
          </div>
        )}
        {isCurrentUser && (
          <p className="mt-4 flex items-center justify-center gap-2 text-xs font-semibold text-slate-400"><UserRound size={14} /> Este é o seu perfil</p>
        )}
      </section>
    </div>
  );
}
