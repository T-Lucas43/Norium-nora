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

  return <div className="mt-2 rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-blue-50">
    <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/20 text-blue-200"><CalendarCheck2 size={17} /></span><div className="min-w-0 flex-1"><strong className="block truncate text-sm">{String(metadata.title || "Reunião da equipe")}</strong><span className="mt-1 flex items-center gap-1 text-xs font-semibold text-blue-100/75"><Clock3 size={13} /> {formatMeetingDate(metadata.startsAt)}</span><span className="mt-1 flex items-center gap-1 text-xs font-semibold text-blue-100/75"><Users size={13} /> {participantIds.length} convidado(s)</span></div></div>
    {description && <p className="mt-3 text-xs font-semibold leading-5 text-blue-50/80">{description}</p>}
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void addToCalendar()} loading={adding} disabled={!invited || added} icon={added ? <Check size={14} /> : <CalendarPlus size={14} />}>{added ? "Adicionada à agenda" : "Adicionar à minha agenda"}</Button><Button size="sm" variant="ghost" onClick={onStart} icon={<PlayCircle size={14} />}>Abrir chamada</Button></div>
  </div>;
}
