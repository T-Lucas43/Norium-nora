import { CalendarClock, Clock3, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { NoriumUser } from "../../types/auth";
import Button from "../shared/Button";

export type TeamMeetingScheduleInput = {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  participantIds: string[];
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function defaultStartValue() {
  const date = new Date();
  date.setMinutes(Math.ceil((date.getMinutes() + 10) / 15) * 15, 0, 0);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIso(value: string) {
  return new Date(value).toISOString();
}

export default function TeamMeetingSchedulerDialog({
  scopeLabel,
  members,
  currentUserId,
  saving,
  onClose,
  onSave,
}: {
  scopeLabel: string;
  members: NoriumUser[];
  currentUserId: string;
  saving: boolean;
  onClose: () => void;
  onSave: (input: TeamMeetingScheduleInput) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(defaultStartValue);
  const [duration, setDuration] = useState("30");
  const [participantIds, setParticipantIds] = useState<string[]>(() => members.map((member) => member.id));
  const activeMembers = useMemo(() => members.filter((member) => member.status === "ativo"), [members]);
  const minStartsAt = useMemo(() => defaultStartValue(), []);
  const canSave = title.trim().length >= 2 && participantIds.includes(currentUserId) && Boolean(startsAt);

  function submit() {
    if (!canSave) return;
    const startDate = new Date(startsAt);
    const endDate = new Date(startDate.getTime() + Number(duration) * 60_000);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return;
    onSave({
      title: title.trim(),
      description: description.trim(),
      startsAt: toIso(startsAt),
      endsAt: endDate.toISOString(),
      participantIds: Array.from(new Set(participantIds)),
    });
  }

  return (
    <div className="fixed inset-0 z-[160] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Agendar reunião" className="w-full max-w-lg nx-card p-5 text-[var(--nx-text)] shadow-[0_24px_64px_rgba(15,23,42,.3)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]"><CalendarClock size={20} /></span><div><p className="text-[12.5px] font-medium text-[var(--nx-text-3)]">{scopeLabel}</p><h2 className="mt-1 text-xl font-semibold">Agendar reunião</h2></div></div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Fechar agendamento"><X size={18} /></Button>
        </div>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Título<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Ex.: Alinhamento da proposta" className="h-9 rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-[13.5px] text-[var(--nx-text)] outline-none focus:border-blue-400" /></label>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <label className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Data e hora local<input type="datetime-local" value={startsAt} min={minStartsAt} onChange={(event) => setStartsAt(event.target.value)} className="h-9 rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-[13.5px] text-[var(--nx-text)] outline-none focus:border-blue-400" /></label>
            <label className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Duração<select value={duration} onChange={(event) => setDuration(event.target.value)} className="h-9 rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] px-3 text-[13.5px] text-[var(--nx-text)] outline-none"><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hora</option><option value="90">1h30</option><option value="120">2 horas</option></select></label>
          </div>
          <label className="grid gap-1.5 text-[12.5px] font-medium text-[var(--nx-text-2)]">Pauta ou descrição<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1200} rows={3} placeholder="Objetivo, contexto e próximos passos" className="resize-y rounded-lg border border-[var(--nx-border-strong)] bg-[var(--nx-surface)] p-3 text-[13.5px] text-[var(--nx-text)] outline-none focus:border-blue-400" /></label>
          <div>
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--nx-text-2)]"><Users size={14} /> Convidados ({participantIds.length})</p>
            <div className="mt-2 grid max-h-36 gap-2 overflow-y-auto sm:grid-cols-2">
              {activeMembers.map((member) => {
                const checked = participantIds.includes(member.id);
                const locked = member.id === currentUserId;
                return <label key={member.id} className="flex items-center gap-3 rounded-lg border border-[var(--nx-border)] bg-[var(--nx-surface-2)] p-3 text-[13px] font-medium"><input type="checkbox" checked={checked} disabled={locked} onChange={() => setParticipantIds((current) => checked ? current.filter((id) => id !== member.id) : [...current, member.id])} className="accent-blue-500" /><span className="truncate">{member.nome}{locked ? " (você)" : ""}</span></label>;
              })}
            </div>
          </div>
          <p className="flex items-center gap-2 text-[12.5px] text-[var(--nx-text-3)]"><Clock3 size={14} /> Os convidados receberão um aviso e um lembrete 10 minutos antes.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={!canSave} onClick={submit} icon={<CalendarClock size={16} />}>Agendar reunião</Button></div>
      </section>
    </div>
  );
}
