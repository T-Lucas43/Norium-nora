import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Camera, CameraOff, Mic, MicOff, MonitorUp, PhoneOff, Video } from "lucide-react";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

function StreamVideo({ stream, muted = false, label }: { stream: MediaStream; muted?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className="h-full w-full rounded-xl bg-black object-cover" />;
}

export default function TeamCallOverlay({ call }: { call: ReturnTypeOfTeamCall }) {
  if (call.incoming && !call.active) {
    return createPortal(
      <div className="fixed inset-0 z-[180] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
        <section className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#11151b] p-6 text-center text-white shadow-2xl">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-blue-500/18 text-blue-300"><Video size={28} /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[.18em] text-blue-300">Chamada recebida</p>
          <h2 className="mt-2 text-xl font-black">{call.incoming.fromUserName}</h2>
          <p className="mt-2 text-sm text-white/60">{call.incoming.mode === "video" ? "Chamada de video" : "Chamada de voz"}</p>
          <div className="mt-6 flex justify-center gap-4">
            <button type="button" onClick={call.rejectIncoming} className="grid h-14 w-14 place-items-center rounded-full bg-rose-600 hover:bg-rose-500" aria-label="Recusar chamada"><PhoneOff size={22} /></button>
            <button type="button" onClick={() => void call.acceptIncoming()} className="grid h-14 w-14 place-items-center rounded-full bg-emerald-600 hover:bg-emerald-500" aria-label="Atender chamada"><Video size={22} /></button>
          </div>
        </section>
      </div>,
      document.body,
    );
  }
  if (!call.active) return null;

  const streams = call.remoteStreams;
  return createPortal(
    <div className="fixed inset-0 z-[180] flex flex-col bg-[#07090c] text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div><p className="text-xs font-bold uppercase tracking-wide text-blue-300">Modo Equipe</p><h2 className="text-lg font-black">{call.active.title}</h2></div>
        <p className="text-xs font-semibold text-white/60">{call.status || "Na chamada"}</p>
      </header>
      <main className={`grid min-h-0 flex-1 gap-3 p-3 ${streams.length > 1 ? "md:grid-cols-2" : ""}`}>
        {streams.length ? streams.map((item) => <StreamVideo key={item.userId} stream={item.stream} label={`Participante ${item.userId}`} />) : (
          <div className="grid place-items-center rounded-xl border border-white/10 bg-white/[.03] text-center">
            <div><Video className="mx-auto text-blue-300" size={42} /><p className="mt-4 font-bold">Aguardando participantes...</p></div>
          </div>
        )}
        {call.localStream && (
          <div className="absolute bottom-24 right-4 h-28 w-44 overflow-hidden rounded-xl border border-white/20 shadow-2xl md:h-40 md:w-60">
            <StreamVideo stream={call.localStream} muted label="Sua camera" />
          </div>
        )}
      </main>
      <footer className="flex items-center justify-center gap-3 border-t border-white/10 bg-black/30 px-4 py-4">
        <button type="button" onClick={call.toggleMute} className={`grid h-12 w-12 place-items-center rounded-full ${call.muted ? "bg-rose-600" : "bg-white/10 hover:bg-white/20"}`} aria-label={call.muted ? "Ativar microfone" : "Silenciar microfone"}>{call.muted ? <MicOff size={20} /> : <Mic size={20} />}</button>
        {call.active.mode === "video" && <button type="button" onClick={call.toggleCamera} className={`grid h-12 w-12 place-items-center rounded-full ${call.cameraOff ? "bg-rose-600" : "bg-white/10 hover:bg-white/20"}`} aria-label={call.cameraOff ? "Ativar camera" : "Desativar camera"}>{call.cameraOff ? <CameraOff size={20} /> : <Camera size={20} />}</button>}
        {call.active.mode === "video" && <button type="button" onClick={() => void call.toggleScreenShare()} className={`grid h-12 w-12 place-items-center rounded-full ${call.sharingScreen ? "bg-blue-600" : "bg-white/10 hover:bg-white/20"}`} aria-label="Compartilhar tela"><MonitorUp size={20} /></button>}
        <button type="button" onClick={call.endCall} className="grid h-12 w-16 place-items-center rounded-full bg-rose-600 hover:bg-rose-500" aria-label="Encerrar chamada"><PhoneOff size={22} /></button>
      </footer>
    </div>,
    document.body,
  );
}
