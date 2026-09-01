import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Camera, CameraOff, Circle, Download, MessageSquareText, Mic, MicOff, MonitorUp, PhoneOff, Send, Settings2, SmilePlus, Users, Video, Volume2, Wifi, WifiOff, X } from "lucide-react";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

type MeetingAttachment = { id: string; name: string; mimeType: string; size: number; url: string; expiresAt?: string };
type MeetingMessage = { id: string; senderId: string; senderName: string; text: string; attachments: MeetingAttachment[]; metadata?: Record<string, unknown>; createdAt: string };
type MeetingMember = { id: string; nome: string; fotoUrl?: string };

type TeamCallOverlayProps = {
  call: ReturnTypeOfTeamCall;
  messages: MeetingMessage[];
  members: MeetingMember[];
  currentUserId: string;
  onSendMessage: (text: string) => Promise<void>;
  onDownloadAttachment: (attachment: MeetingAttachment) => void;
};

function StreamVideo({ stream, muted = false, label, sinkId = "" }: { stream: MediaStream; muted?: boolean; label: string; sinkId?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  useEffect(() => {
    const element = ref.current as (HTMLVideoElement & { setSinkId?: (deviceId: string) => Promise<void> }) | null;
    if (!muted && sinkId && element?.setSinkId) void element.setSinkId(sinkId).catch(() => undefined);
  }, [muted, sinkId]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className="h-full w-full bg-black object-cover" />;
}

function deviceLabel(device: MediaDeviceInfo, prefix: string, index: number) {
  return device.label || `${prefix} ${index + 1}`;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "N";
}

function durationLabel(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export default function TeamCallOverlay({ call, messages, members, currentUserId, onSendMessage, onDownloadAttachment }: TeamCallOverlayProps) {
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  useEffect(() => {
    if (!chatOpen) return;
    const frame = window.requestAnimationFrame(() => chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight, behavior: "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [chatOpen, messages.length]);

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const outgoing = messageText.trim();
    if (!outgoing || sending) return;
    setSending(true);
    try { await onSendMessage(outgoing); setMessageText(""); } finally { setSending(false); }
  }

  if (call.incoming && !call.active) {
    return createPortal(
      <div className="fixed inset-0 z-[180] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
        <section className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#11151b] p-6 text-center text-white shadow-2xl">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-blue-500/18 text-blue-300"><Video size={28} /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[.18em] text-blue-300">Chamada recebida</p>
          <h2 className="mt-2 text-xl font-black">{call.incoming.fromUserName}</h2>
          <p className="mt-2 text-sm text-white/60">{call.incoming.mode === "video" ? "Chamada de vídeo" : "Chamada de voz"}</p>
          <div className="mt-6 flex justify-center gap-4">
            <button type="button" onClick={call.rejectIncoming} className="grid h-14 w-14 place-items-center rounded-full bg-rose-600 hover:bg-rose-500" aria-label="Recusar chamada"><PhoneOff size={22} /></button>
            <button type="button" onClick={() => void call.acceptIncoming()} className="grid h-14 w-14 place-items-center rounded-full bg-emerald-600 hover:bg-emerald-500" aria-label="Atender chamada"><Video size={22} /></button>
          </div>
        </section>
      </div>, document.body,
    );
  }
  if (!call.active) return null;

  const streams = call.remoteStreams;
  const participantIds = Array.from(new Set([currentUserId, ...streams.map((item) => item.userId)]));
  const togglePanel = (panel: "chat" | "people" | "devices") => {
    setChatOpen(panel === "chat" ? !chatOpen : false);
    setPeopleOpen(panel === "people" ? !peopleOpen : false);
    setDevicesOpen(panel === "devices" ? !devicesOpen : false);
    setReactionsOpen(false);
  };
  const connectionLabel = { offline: "Sem internet", connecting: "Conectando", poor: "Conexão fraca", fair: "Conexão estável", good: "Conexão excelente" }[call.connectionQuality];
  const connectionColor = { offline: "text-rose-300", connecting: "text-amber-300", poor: "text-rose-300", fair: "text-amber-300", good: "text-emerald-300" }[call.connectionQuality];

  return createPortal(
    <div className="fixed inset-0 z-[180] flex flex-col bg-[#1b1b1b] text-white">
      <header className="relative flex min-h-16 items-center justify-between gap-4 border-b border-white/10 bg-[#242424] px-3 py-2 shadow-lg">
        <div className="min-w-0 pl-1"><p className="truncate text-sm font-black">{call.active.title}</p><p className="truncate text-[11px] text-white/55">{call.status || "Na chamada"}</p></div>
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Controles da reunião">
          {call.isHost && <button type="button" onClick={() => void (call.recording ? call.stopRecording() : call.startRecording())} className={`team-call-top-control ${call.recording ? "text-rose-300" : ""}`} aria-label={call.recording ? "Parar gravação" : "Gravar reunião"}><Circle size={18} fill={call.recording ? "currentColor" : "none"} /><span>{call.recording ? durationLabel(call.recordingElapsedSeconds) : "Gravar"}</span></button>}
          <button type="button" onClick={() => togglePanel("chat")} className={`team-call-top-control ${chatOpen ? "bg-white/15" : ""}`} aria-label="Abrir chat da reunião"><MessageSquareText size={19} /><span>Chat</span></button>
          <button type="button" onClick={() => togglePanel("people")} className={`team-call-top-control ${peopleOpen ? "bg-white/15" : ""}`} aria-label="Ver pessoas na reunião"><Users size={19} /><span>Pessoas</span></button>
          <div role="status" className={`team-call-top-control ${connectionColor}`} aria-label={`Qualidade da internet: ${connectionLabel}`} title={connectionLabel}>{call.connectionQuality === "offline" ? <WifiOff size={19} /> : <Wifi size={19} />}<span>{connectionLabel}</span></div>
          <button type="button" onClick={() => { setReactionsOpen((current) => !current); setDevicesOpen(false); setChatOpen(false); setPeopleOpen(false); }} className={`team-call-top-control ${reactionsOpen ? "bg-white/15" : ""}`} aria-label="Enviar reação com emoji"><SmilePlus size={19} /><span>Reagir</span></button>
          {call.active.mode === "video" && <button type="button" onClick={() => void call.toggleScreenShare()} className={`team-call-top-control ${call.sharingScreen ? "bg-blue-600" : ""}`} aria-label={call.sharingScreen ? "Parar transmissão de tela" : "Transmitir tela"}><MonitorUp size={19} /><span>Compartilhar</span></button>}
          {call.active.mode === "video" && <button type="button" onClick={call.toggleCamera} className={`team-call-top-control ${call.cameraOff ? "text-rose-300" : ""}`} aria-label={call.cameraOff ? "Ativar câmera" : "Desativar câmera"}>{call.cameraOff ? <CameraOff size={19} /> : <Camera size={19} />}<span>Câmera</span></button>}
          <button type="button" onClick={call.toggleMute} className={`team-call-top-control ${call.muted ? "text-rose-300" : ""}`} aria-label={call.muted ? "Ativar microfone" : "Silenciar microfone"}>{call.muted ? <MicOff size={19} /> : <Mic size={19} />}<span>Microfone</span></button>
          <button type="button" onClick={() => togglePanel("devices")} className={`team-call-top-control ${devicesOpen ? "bg-white/15" : ""}`} aria-label="Selecionar câmera e dispositivos de áudio"><Settings2 size={19} /><span>Dispositivos</span></button>
          <button type="button" onClick={() => void (call.isHost ? call.endCall() : call.leaveCall())} className="team-call-top-control ml-2 text-rose-300" aria-label={call.isHost ? "Encerrar reunião" : "Sair da reunião"}><PhoneOff size={20} /><span>{call.isHost ? "Encerrar" : "Sair"}</span></button>
        </nav>
        {devicesOpen && <DeviceSelector call={call} onClose={() => setDevicesOpen(false)} />}
        {reactionsOpen && <section className="absolute right-3 top-[calc(100%+10px)] z-20 flex gap-1 rounded-2xl border border-white/15 bg-[#252525] p-2 shadow-2xl" aria-label="Reações da reunião">{["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].map((emoji) => <button key={emoji} type="button" onClick={() => { call.sendReaction(emoji); setReactionsOpen(false); }} className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-white/10" aria-label={`Reagir com ${emoji}`}>{emoji}</button>)}</section>}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className={`relative grid min-w-0 flex-1 gap-3 p-3 ${streams.length > 1 ? "md:grid-cols-2" : ""}`}>
          {call.recording && <div className="absolute left-5 top-5 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-black text-rose-300"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> REC {durationLabel(call.recordingElapsedSeconds)}</div>}
          {streams.length ? streams.map((item) => <div key={item.userId} className="overflow-hidden rounded-xl border border-white/10"><StreamVideo stream={item.stream} sinkId={call.selectedSpeakerId} label={`Participante ${item.userId}`} /></div>) : <WaitingStage title={call.active.title} />}
          {call.localStream && <div className="absolute bottom-5 right-5 h-28 w-44 overflow-hidden rounded-xl border border-white/20 shadow-2xl md:h-40 md:w-60"><StreamVideo stream={call.localStream} muted label="Sua câmera" /></div>}
          <div className="pointer-events-none absolute bottom-8 left-6 z-20 flex items-end gap-3">{call.reactions.map((reaction) => <div key={reaction.id} className="team-call-reaction rounded-full bg-black/70 px-3 py-2 text-center shadow-xl"><span className="block text-3xl">{reaction.emoji}</span><small className="block max-w-24 truncate text-[10px] text-white/70">{reaction.userName}</small></div>)}</div>
        </main>

        {(chatOpen || peopleOpen) && <aside className="flex w-[min(92vw,390px)] shrink-0 flex-col border-l border-white/10 bg-[#242424]">
          <div className="flex h-14 items-center justify-between border-b border-white/10 px-4"><h3 className="font-black">{chatOpen ? "Chat da reunião" : "Pessoas"}</h3><button type="button" onClick={() => { setChatOpen(false); setPeopleOpen(false); }} className="rounded-lg p-2 hover:bg-white/10" aria-label="Fechar painel"><X size={18} /></button></div>
          {chatOpen ? <MeetingChat messages={messages} currentUserId={currentUserId} listRef={chatListRef} messageText={messageText} sending={sending} onMessageText={setMessageText} onSubmit={submitMessage} onDownloadAttachment={onDownloadAttachment} /> : <PeoplePanel participantIds={participantIds} currentUserId={currentUserId} memberById={memberById} />}
        </aside>}
      </div>
    </div>, document.body,
  );
}

function DeviceSelector({ call, onClose }: { call: ReturnTypeOfTeamCall; onClose: () => void }) {
  return <section className="absolute right-3 top-[calc(100%+10px)] z-20 grid w-[min(92vw,440px)] gap-3 rounded-2xl border border-white/15 bg-[#252525] p-4 text-left shadow-2xl" aria-label="Dispositivos da chamada">
    <div className="flex items-center justify-between"><div><p className="text-sm font-black">Dispositivos</p><p className="text-xs text-white/55">Troque câmera e áudio durante a chamada.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Fechar dispositivos"><X size={17} /></button></div>
    <label className="grid gap-1.5 text-xs font-bold text-white/70"><span className="flex items-center gap-2"><Mic size={14} /> Dispositivo de entrada</span><select value={call.selectedMicrophoneId} onChange={(event) => void call.selectMicrophone(event.target.value)} className="h-10 rounded-xl border border-white/15 bg-[#111] px-3 text-sm text-white outline-none"><option value="">Padrão do sistema</option>{call.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
    {call.active?.mode === "video" && <label className="grid gap-1.5 text-xs font-bold text-white/70"><span className="flex items-center gap-2"><Camera size={14} /> Câmera</span><select value={call.selectedCameraId} onChange={(event) => void call.selectCamera(event.target.value)} className="h-10 rounded-xl border border-white/15 bg-[#111] px-3 text-sm text-white outline-none"><option value="">Padrão do sistema</option>{call.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select></label>}
    <label className="grid gap-1.5 text-xs font-bold text-white/70"><span className="flex items-center gap-2"><Volume2 size={14} /> Dispositivo de saída</span><select value={call.selectedSpeakerId} disabled={!call.supportsSpeakerSelection} onChange={(event) => call.selectSpeaker(event.target.value)} className="h-10 rounded-xl border border-white/15 bg-[#111] px-3 text-sm text-white outline-none disabled:cursor-not-allowed disabled:opacity-55"><option value="">Padrão do sistema</option>{call.devices.speakers.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Saída", index)}</option>)}</select>{!call.supportsSpeakerSelection && <small className="font-medium text-amber-300/85">Neste navegador, a saída é escolhida nas configurações do sistema.</small>}</label>
  </section>;
}

function WaitingStage({ title }: { title: string }) {
  return <div className="grid place-items-center rounded-xl bg-[#1f1f1f] text-center"><div><span className="mx-auto grid h-36 w-36 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-violet-600 text-4xl font-black shadow-2xl">{initials(title)}</span><p className="mt-8 text-2xl font-black">Aguardando o ingresso de outros participantes...</p><p className="mt-2 text-sm text-white/45">O som de entrada tocará quando alguém conectar.</p></div></div>;
}

function MeetingChat({ messages, currentUserId, listRef, messageText, sending, onMessageText, onSubmit, onDownloadAttachment }: { messages: MeetingMessage[]; currentUserId: string; listRef: RefObject<HTMLDivElement | null>; messageText: string; sending: boolean; onMessageText: (value: string) => void; onSubmit: (event: FormEvent) => void; onDownloadAttachment: (attachment: MeetingAttachment) => void }) {
  return <><div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{messages.length ? messages.map((message) => <article key={message.id} className={message.senderId === currentUserId ? "ml-8" : "mr-8"}><div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-white/45"><strong className="truncate text-white/70">{message.senderName}</strong><time>{timeLabel(message.createdAt)}</time></div>{message.text && <p className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${message.senderId === currentUserId ? "bg-violet-600" : "bg-[#333]"}`}>{message.text}</p>}{message.attachments.map((attachment) => <button key={attachment.id} type="button" onClick={() => onDownloadAttachment(attachment)} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-white/10 bg-[#171717] p-3 text-left hover:bg-[#202020]"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-500/15 text-blue-300"><Download size={17} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs">{attachment.name}</strong>{attachment.expiresAt && <small className="text-[10px] text-amber-300">Disponível por 24 horas</small>}</span></button>)}</article>) : <div className="grid h-full place-items-center text-center text-sm text-white/45"><p>As mensagens enviadas aqui também ficam no chat da equipe.</p></div>}</div><form onSubmit={onSubmit} className="border-t border-white/10 p-4"><div className="flex items-end gap-2 rounded-xl border border-white/15 bg-[#181818] p-2"><textarea value={messageText} onChange={(event) => onMessageText(event.target.value)} rows={2} maxLength={2000} placeholder="Digite uma mensagem" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-white outline-none placeholder:text-white/35" /><button type="submit" disabled={!messageText.trim() || sending} className="grid h-10 w-10 place-items-center rounded-lg text-blue-300 hover:bg-white/10 disabled:opacity-35" aria-label="Enviar mensagem"><Send size={19} /></button></div></form></>;
}

function PeoplePanel({ participantIds, currentUserId, memberById }: { participantIds: string[]; currentUserId: string; memberById: Map<string, MeetingMember> }) {
  return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">{participantIds.map((participantId) => { const participant = memberById.get(participantId); const name = participant?.nome || (participantId === currentUserId ? "Você" : `Participante ${participantId}`); return <div key={participantId} className="flex items-center gap-3 rounded-xl bg-white/[.04] p-3"><span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-blue-600 font-black">{participant?.fotoUrl ? <img src={participant.fotoUrl} alt="" className="h-full w-full object-cover" /> : initials(name)}</span><span><strong className="block text-sm">{name}</strong><small className="text-emerald-300">Na reunião</small></span></div>; })}</div>;
}
