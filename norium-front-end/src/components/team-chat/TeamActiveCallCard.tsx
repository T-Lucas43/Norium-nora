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
    <section className="rounded-xl border border-blue-500 bg-[#0b1523] p-4 text-white" aria-label="Prévia da reunião ativa">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-blue-600"><Video size={24} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black">Reunião em andamento</p>
          <p className="mt-1 text-xs text-slate-300">Organizada por {meeting.fromUserName || "Membro"}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-slate-300"><Users size={13} />
            {meeting.joinedUserIds?.length || 1} na chamada
            {startedAt && !Number.isNaN(startedAt.getTime()) && ` · desde ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
      </div>
      <button type="button" onClick={onJoin} disabled={busy || joined} className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60">
        {joined ? "Você está nesta reunião" : busy ? "Conectando..." : "Ingressar na reunião"}
      </button>
      <p className="mt-2 text-xs text-slate-300">Sua câmera entra desligada. O áudio e o vídeo só são recebidos após ingressar.</p>
    </section>
  );
}
