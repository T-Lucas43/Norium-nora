import { Users, Video } from "lucide-react";
import type { TeamCallSocketEvent } from "./CallSession";

export default function TeamActiveCallCard({ meeting, busy, joined = false, onJoin }: {
  meeting: TeamCallSocketEvent;
  busy: boolean;
  joined?: boolean;
  onJoin: () => void;
}) {
  const startedAt = meeting.startedAt ? new Date(meeting.startedAt) : null;
  return (
    <section className="nx-card p-4 text-[var(--nx-text)]" aria-label="Prévia da reunião ativa">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--nx-primary)] text-white"><Video size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">Reunião em andamento</p>
          <p className="mt-1 text-[12.5px] text-[var(--nx-text-3)]">Organizada por {meeting.fromUserName || "Membro"}</p>
          <p className="mt-1 flex items-center gap-1 text-[12.5px] text-[var(--nx-text-3)]"><Users size={13} />
            {meeting.joinedUserIds?.length || 1} na chamada
            {startedAt && !Number.isNaN(startedAt.getTime()) && ` · desde ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
      </div>
      <button type="button" onClick={onJoin} disabled={busy || joined} className="nx-btn is-primary mt-3 w-full disabled:cursor-wait">
        {joined ? "Você está nesta reunião" : busy ? "Conectando..." : "Ingressar na reunião"}
      </button>
      <p className="mt-2 text-[12.5px] text-[var(--nx-text-3)]">Sua câmera entra desligada. O áudio e o vídeo só são recebidos após ingressar.</p>
    </section>
  );
}
