import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Camera, CameraOff, Circle, Clock3, Download, MessageSquareText, Mic, MicOff, MonitorUp, Paperclip, PhoneOff, Send, Settings2, SmilePlus, Users, Video, Volume2, Wifi, WifiOff, X } from "lucide-react";
import type { ReturnTypeOfTeamCall } from "./teamCallTypes";

type MeetingAttachment = { id: string; name: string; mimeType: string; size: number; url: string; expiresAt?: string };
type MeetingMessage = { id: string; senderId: string; senderName: string; text: string; attachments: MeetingAttachment[]; metadata?: Record<string, unknown>; createdAt: string };
type MeetingMember = { id: string; nome: string; fotoUrl?: string };

type TeamCallOverlayProps = {
  call: ReturnTypeOfTeamCall;
  messages: MeetingMessage[];
  members: MeetingMember[];
  currentUserId: string;
  onSendMessage: (text: string, files: File[]) => Promise<void>;
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
  const [messageFiles, setMessageFiles] = useState<File[]>([]);
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
    if ((!outgoing && !messageFiles.length) || sending) return;
    setSending(true);
    try {
      await onSendMessage(outgoing, messageFiles);
      setMessageText("");
      setMessageFiles([]);
    } finally { setSending(false); }
  }

  if (call.incoming && !call.active) {
    return createPortal(
      <div className="team-call-incoming-backdrop fixed inset-0 z-[180] grid place-items-center p-4">
        <section className="team-call-incoming-card w-full max-w-sm rounded-2xl border p-6 text-center shadow-2xl">
          <span className="team-call-control-surface mx-auto grid h-16 w-16 place-items-center rounded-full"><Video size={28} /></span>
          <p className="team-call-accent-text mt-5 text-xs font-bold uppercase tracking-[.18em]">Reunião iniciada</p>
          <h2 className="mt-2 text-xl font-black">{call.incoming.fromUserName}</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">Convidou você para {call.incoming.thread.scope === "direct" ? "uma chamada individual" : "uma reunião da equipe"}.</p>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Sua câmera entra desligada e pode ser ativada dentro da reunião.</p>
          <div className="mt-6 flex justify-center gap-4">
            <button type="button" onClick={call.rejectIncoming} className="grid h-14 w-14 place-items-center rounded-full bg-rose-600 hover:bg-rose-500" aria-label="Recusar chamada"><PhoneOff size={22} /></button>
            <button type="button" onClick={() => void call.acceptIncoming()} className="team-call-primary-button grid h-14 w-14 place-items-center rounded-full text-white" aria-label="Entrar na reunião"><Video size={22} /></button>
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
    <div className="team-call-shell fixed inset-0 z-[180] flex flex-col">
      <header className="team-call-header relative flex min-h-16 items-center justify-between gap-4 border-b px-3 py-2 shadow-lg">
        <div className="min-w-0 pl-1">
          <p className="truncate text-sm font-black">{call.active.title}</p>
          <p className="flex items-center gap-1.5 truncate text-[11px] text-[var(--text-secondary)]"><Clock3 size={12} /> {durationLabel(call.callElapsedSeconds)} · {call.status || "Na chamada"}</p>
        </div>
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Controles da reunião">
          {call.isHost && <button type="button" onClick={() => void (call.recording ? call.stopRecording() : call.startRecording())} className={`team-call-top-control ${call.recording ? "team-call-danger" : ""}`} aria-label={call.recording ? "Parar gravação" : "Gravar reunião"}><Circle size={18} fill={call.recording ? "currentColor" : "none"} /><span>{call.recording ? "Parar gravação" : "Gravar"}</span></button>}
          <button type="button" onClick={() => togglePanel("chat")} className={`team-call-top-control ${chatOpen ? "team-call-active" : ""}`} aria-label="Abrir chat da reunião"><MessageSquareText size={19} /><span>Chat</span></button>
          <button type="button" onClick={() => togglePanel("people")} className={`team-call-top-control ${peopleOpen ? "team-call-active" : ""}`} aria-label="Ver pessoas na reunião"><Users size={19} /><span>Pessoas</span></button>
          <div role="status" className={`team-call-top-control ${connectionColor}`} aria-label={`Qualidade da internet: ${connectionLabel}`} title={connectionLabel}>{call.connectionQuality === "offline" ? <WifiOff size={19} /> : <Wifi size={19} />}<span>{connectionLabel}</span></div>
          <button type="button" onClick={() => { setReactionsOpen((current) => !current); setDevicesOpen(false); setChatOpen(false); setPeopleOpen(false); }} className={`team-call-top-control ${reactionsOpen ? "team-call-active" : ""}`} aria-label="Enviar reação com emoji"><SmilePlus size={19} /><span>Reagir</span></button>
          <button type="button" onClick={() => void call.toggleScreenShare()} className={`team-call-top-control ${call.sharingScreen ? "team-call-active" : ""}`} aria-label={call.sharingScreen ? "Parar transmissão de tela" : "Transmitir tela"}><MonitorUp size={19} /><span>{call.sharingScreen ? "Parar tela" : "Transmitir tela"}</span></button>
          <button type="button" onClick={() => void call.toggleCamera()} className={`team-call-top-control ${call.cameraOff ? "team-call-danger" : ""}`} aria-label={call.cameraOff ? "Ativar câmera" : "Desativar câmera"}>{call.cameraOff ? <CameraOff size={19} /> : <Camera size={19} />}<span>Câmera</span></button>
          <button type="button" onClick={call.toggleMute} className={`team-call-top-control ${call.muted ? "team-call-danger" : ""}`} aria-label={call.muted ? "Ativar microfone" : "Silenciar microfone"}>{call.muted ? <MicOff size={19} /> : <Mic size={19} />}<span>Microfone</span></button>
          <button type="button" onClick={() => togglePanel("devices")} className={`team-call-top-control ${devicesOpen ? "team-call-active" : ""}`} aria-label="Selecionar câmera e dispositivos de áudio"><Settings2 size={19} /><span>Dispositivos</span></button>
          <button type="button" onClick={() => void (call.isHost ? call.endCall() : call.leaveCall())} className="team-call-top-control team-call-danger ml-2" aria-label={call.isHost ? "Encerrar reunião" : "Sair da reunião"}><PhoneOff size={20} /><span>{call.isHost ? "Encerrar" : "Sair"}</span></button>
        </nav>
        {devicesOpen && <DeviceSelector call={call} onClose={() => setDevicesOpen(false)} />}
        {reactionsOpen && <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 flex gap-1 rounded-2xl border p-2 shadow-2xl" aria-label="Reações da reunião">{["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].map((emoji) => <button key={emoji} type="button" onClick={() => { call.sendReaction(emoji); setReactionsOpen(false); }} className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-[#1b2128]" aria-label={`Reagir com ${emoji}`}>{emoji}</button>)}</section>}
      </header>

      {call.cameraPermission !== "granted" && (
        <section className="team-call-camera-permission flex items-center justify-between gap-4 border-b px-4 py-3" role="alert">
          <div className="flex min-w-0 items-center gap-3">
            <CameraOff size={20} className="shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-black">{call.cameraPermission === "requesting" ? "Solicitando acesso à câmera..." : call.cameraPermission === "unavailable" ? "Câmera indisponível" : "Permissão da câmera necessária"}</p>
              <p className="mt-0.5 text-xs text-[#9ca7b5]">{call.cameraPermission === "denied" ? "Clique no cadeado ao lado do endereço, escolha Câmera > Permitir e tente novamente." : "O Norium solicita a permissão, mas mantém sua câmera desligada até você ativá-la."}</p>
            </div>
          </div>
          {call.cameraPermission !== "requesting" && <button type="button" onClick={() => void call.requestCameraPermission()} className="team-call-primary-button shrink-0 rounded-lg px-4 py-2 text-xs font-black text-white">Permitir câmera</button>}
        </section>
      )}

      <div className="flex min-h-0 flex-1">
        <main className={`relative grid min-w-0 flex-1 gap-3 p-3 ${streams.length > 1 ? "md:grid-cols-2" : ""}`}>
          {call.recording && <div className="team-call-recording-badge absolute left-5 top-5 z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black text-rose-300"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> REC {durationLabel(call.recordingElapsedSeconds)}</div>}
          {streams.length ? streams.map((item) => <div key={item.userId} className="overflow-hidden rounded-xl border border-[var(--border)]"><StreamVideo stream={item.stream} sinkId={call.selectedSpeakerId} label={`Participante ${item.userId}`} /></div>) : <WaitingStage title={call.active.title} />}
          {call.localStream && !call.cameraOff && <div className="absolute bottom-5 right-5 h-28 w-44 overflow-hidden rounded-xl border border-[var(--border)] shadow-2xl md:h-40 md:w-60"><StreamVideo stream={call.localStream} muted label="Sua câmera" /></div>}
          <div className="pointer-events-none absolute bottom-8 left-6 z-20 flex items-end gap-3">{call.reactions.map((reaction) => <div key={reaction.id} className="team-call-reaction rounded-full bg-[#11151a] px-3 py-2 text-center shadow-xl"><span className="block text-3xl">{reaction.emoji}</span><small className="block max-w-24 truncate text-[10px] text-[#9ca7b5]">{reaction.userName}</small></div>)}</div>
        </main>

        {(chatOpen || peopleOpen) && <aside className="team-call-side-panel flex w-[min(92vw,390px)] shrink-0 flex-col border-l">
          <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4"><h3 className="font-black">{chatOpen ? "Chat da reunião" : "Pessoas"}</h3><button type="button" onClick={() => { setChatOpen(false); setPeopleOpen(false); }} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar painel"><X size={18} /></button></div>
          {chatOpen ? <MeetingChat messages={messages} currentUserId={currentUserId} listRef={chatListRef} messageText={messageText} messageFiles={messageFiles} sending={sending} onMessageText={setMessageText} onMessageFiles={setMessageFiles} onSubmit={submitMessage} onDownloadAttachment={onDownloadAttachment} /> : <PeoplePanel participantIds={participantIds} currentUserId={currentUserId} memberById={memberById} />}
        </aside>}
      </div>
    </div>, document.body,
  );
}

function DeviceSelector({ call, onClose }: { call: ReturnTypeOfTeamCall; onClose: () => void }) {
  return <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 grid w-[min(92vw,440px)] gap-3 rounded-2xl border p-4 text-left shadow-2xl" aria-label="Dispositivos da chamada">
    <div className="flex items-center justify-between"><div><p className="text-sm font-black">Dispositivos</p><p className="text-xs text-[var(--text-secondary)]">Troque câmera e áudio durante a chamada.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar dispositivos"><X size={17} /></button></div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Mic size={14} /> Dispositivo de entrada</span><select value={call.selectedMicrophoneId} onChange={(event) => void call.selectMicrophone(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value="">Padrão do sistema</option>{call.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Camera size={14} /> Câmera · {call.cameraPermission === "granted" ? "permitida" : "permissão pendente"}</span><select value={call.selectedCameraId} onChange={(event) => void call.selectCamera(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value="">Padrão do sistema</option>{call.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select></label>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Volume2 size={14} /> Dispositivo de saída</span><select value={call.selectedSpeakerId} disabled={!call.supportsSpeakerSelection} onChange={(event) => call.selectSpeaker(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none disabled:cursor-not-allowed disabled:opacity-55"><option value="">Padrão do sistema</option>{call.devices.speakers.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Saída", index)}</option>)}</select>{!call.supportsSpeakerSelection && <small className="font-medium text-amber-500">Neste navegador, a saída é escolhida nas configurações do sistema.</small>}</label>
  </section>;
}

function WaitingStage({ title }: { title: string }) {
  return <div className="team-call-waiting grid place-items-center rounded-xl border text-center"><div><span className="team-call-primary-button mx-auto grid h-36 w-36 place-items-center rounded-full text-4xl font-black text-white shadow-2xl">{initials(title)}</span><p className="mt-8 text-2xl font-black">Aguardando o ingresso de outros participantes...</p><p className="mt-2 text-sm text-[#9ca7b5]">O som de entrada tocará quando alguém conectar.</p></div></div>;
}

function MeetingChat({ messages, currentUserId, listRef, messageText, messageFiles, sending, onMessageText, onMessageFiles, onSubmit, onDownloadAttachment }: { messages: MeetingMessage[]; currentUserId: string; listRef: RefObject<HTMLDivElement | null>; messageText: string; messageFiles: File[]; sending: boolean; onMessageText: (value: string) => void; onMessageFiles: (files: File[]) => void; onSubmit: (event: FormEvent) => void; onDownloadAttachment: (attachment: MeetingAttachment) => void }) {
  return <><div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{messages.length ? messages.map((message) => <article key={message.id} className={message.senderId === currentUserId ? "ml-8" : "mr-8"}><div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><strong className="truncate text-[var(--text)]">{message.senderName}</strong><time>{timeLabel(message.createdAt)}</time></div>{message.text && <p className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${message.senderId === currentUserId ? "bg-[var(--primary)] text-white" : "bg-[var(--surface-hover)] text-[var(--text)]"}`}>{message.text}</p>}{message.attachments.map((attachment) => <button key={attachment.id} type="button" onClick={() => onDownloadAttachment(attachment)} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-left hover:bg-[var(--surface-hover)]"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--surface-hover)] text-[var(--primary)]"><Download size={17} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs">{attachment.name}</strong>{attachment.expiresAt && <small className="text-[10px] text-amber-500">Disponível por 24 horas</small>}</span></button>)}</article>) : <div className="grid h-full place-items-center text-center text-sm text-[var(--text-secondary)]"><p>As mensagens e os arquivos enviados aqui também ficam no chat da equipe.</p></div>}</div><form onSubmit={onSubmit} className="border-t border-[var(--border)] p-4">{messageFiles.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{messageFiles.map((file, index) => <span key={`${file.name}-${file.size}-${index}`} className="flex max-w-48 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs"><span className="truncate">{file.name}</span><button type="button" onClick={() => onMessageFiles(messageFiles.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover ${file.name}`}><X size={13} /></button></span>)}</div>}<div className="flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-2"><label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg text-[var(--primary)] hover:bg-[var(--surface-hover)]" aria-label="Anexar arquivos no chat da reunião"><Paperclip size={19} /><input type="file" multiple className="hidden" onChange={(event) => { onMessageFiles([...messageFiles, ...Array.from(event.target.files || [])]); event.currentTarget.value = ""; }} /></label><textarea value={messageText} onChange={(event) => onMessageText(event.target.value)} rows={2} maxLength={2000} placeholder="Digite uma mensagem" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-secondary)]" /><button type="submit" disabled={(!messageText.trim() && !messageFiles.length) || sending} className="grid h-10 w-10 place-items-center rounded-lg text-[var(--primary)] hover:bg-[var(--surface-hover)] disabled:opacity-35" aria-label="Enviar mensagem"><Send size={19} /></button></div></form></>;
}

function PeoplePanel({ participantIds, currentUserId, memberById }: { participantIds: string[]; currentUserId: string; memberById: Map<string, MeetingMember> }) {
  return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">{participantIds.map((participantId) => { const participant = memberById.get(participantId); const name = participant?.nome || (participantId === currentUserId ? "Você" : `Participante ${participantId}`); return <div key={participantId} className="flex items-center gap-3 rounded-xl bg-[var(--surface-hover)] p-3"><span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-[var(--primary)] font-black text-white">{participant?.fotoUrl ? <img src={participant.fotoUrl} alt="" className="h-full w-full object-cover" /> : initials(name)}</span><span><strong className="block text-sm">{name}</strong><small className="text-emerald-500">Na reunião</small></span></div>; })}</div>;
}
