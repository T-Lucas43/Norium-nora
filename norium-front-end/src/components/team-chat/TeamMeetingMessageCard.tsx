import { CalendarCheck2, CalendarPlus, Clock3, PlayCircle, Users, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Button from "../shared/Button";

function formatMeetingDate(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "Horário não informado";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function TeamMeetingMessageCard({
  metadata,
  currentUserId,
  onAddToCalendar,
  onStart,
}: {
  metadata: Record<string, unknown>;
  currentUserId: string;
  onAddToCalendar: (meetingId: string) => Promise<void>;
  onStart: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(() => Array.isArray(metadata.agendaAddedBy) && metadata.agendaAddedBy.map(String).includes(currentUserId));
  const meetingId = String(metadata.meetingId || "");
  const description = String(metadata.description || "");
  const participantIds = useMemo(() => Array.isArray(metadata.participantIds) ? metadata.participantIds.map(String) : [], [metadata.participantIds]);
  const agendaAddedBy = useMemo(() => Array.isArray(metadata.agendaAddedBy) ? metadata.agendaAddedBy.map(String) : [], [metadata.agendaAddedBy]);
  useEffect(() => {
    setAdded(agendaAddedBy.includes(currentUserId));
  }, [agendaAddedBy, currentUserId]);
  const invited = participantIds.includes(currentUserId);
  async function addToCalendar() {
    if (!meetingId || adding || added) return;
    setAdding(true);
    try {
      await onAddToCalendar(meetingId);
      setAdded(true);
    } finally {
      setAdding(false);
    }
  }

  return <div className="nx-card mt-2 max-w-[520px] p-3 text-[var(--nx-text)]">
    <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--nx-primary-soft)] text-[var(--nx-primary-text)]"><CalendarCheck2 size={17} /></span><div className="min-w-0 flex-1"><strong className="block truncate text-[13.5px] font-semibold">{String(metadata.title || "Reunião da equipe")}</strong><span className="mt-1 flex items-center gap-1 text-[12.5px] text-[var(--nx-text-3)]"><Clock3 size={13} /> {formatMeetingDate(metadata.startsAt)}</span><span className="mt-1 flex items-center gap-1 text-[12.5px] text-[var(--nx-text-3)]"><Users size={13} /> {participantIds.length} convidado(s)</span></div></div>
    {description && <p className="mt-3 text-[13px] leading-5 text-[var(--nx-text-2)]">{description}</p>}
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void addToCalendar()} loading={adding} disabled={!invited || added} icon={added ? <Check size={14} /> : <CalendarPlus size={14} />}>{added ? "Adicionada à agenda" : "Adicionar à minha agenda"}</Button><Button size="sm" variant="ghost" onClick={onStart} icon={<PlayCircle size={14} />}>Abrir chamada</Button></div>
  </div>;
}
