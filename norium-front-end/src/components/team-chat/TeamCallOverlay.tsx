import "./teamCall.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, Camera, CameraOff, Circle, Clock3, Download, FlipHorizontal2, Hand, Headphones, Maximize2, Minimize2, MessageSquareText, Mic, MicOff, MonitorUp, Move, Paperclip, PhoneOff, Pin, PinOff, Send, Settings2, SlidersHorizontal, SmilePlus, Users, Video, Volume2, VolumeX, Wifi, WifiOff, X } from "lucide-react";
import TeamCallStudio from "./TeamCallStudio";
import ParticipantAudio from "./ParticipantAudio";
import type { CallSessionCommands, CallSessionSnapshot } from "./CallSession";
import { callSessionView, type ReturnTypeOfTeamCall } from "./teamCallTypes";

type MeetingAttachment = { id: string; name: string; mimeType: string; size: number; url: string; expiresAt?: string };
type MeetingMessage = { id: string; senderId: string; senderName: string; text: string; attachments: MeetingAttachment[]; metadata?: Record<string, unknown>; createdAt: string };
type MeetingMember = { id: string; nome: string; fotoUrl?: string };

type TeamCallOverlayProps = {
  snapshot: CallSessionSnapshot;
  commands: CallSessionCommands;
  members: MeetingMember[];
  currentUserId: string;
  attachmentToken?: string;
  onDownloadAttachment: (attachment: MeetingAttachment) => void;
};

const MINIMIZED_CALL_KEY = "norium.team-call.minimized";

function storedMinimizedCall() {
  try { return sessionStorage.getItem(MINIMIZED_CALL_KEY) || ""; }
  catch { return ""; }
}

function StreamVideo({ stream, muted = false, label, sinkId = "", fit = "cover", mirrored = false }: { stream: MediaStream; muted?: boolean; label: string; sinkId?: string; fit?: "cover" | "contain"; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    return () => { if (element.srcObject === stream) element.srcObject = null; };
  }, [stream]);
  useEffect(() => {
    const element = ref.current as (HTMLVideoElement & { setSinkId?: (deviceId: string) => Promise<void> }) | null;
    if (!muted && sinkId && element?.setSinkId) void element.setSinkId(sinkId).catch(() => undefined);
  }, [muted, sinkId]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} data-mirrored={mirrored || undefined} className={`h-full w-full bg-black ${fit === "contain" ? "object-contain" : "object-cover"} ${mirrored ? "team-call-video-mirrored" : ""}`} />;
}

function DraggableScreenPreview({ stream }: { stream: MediaStream }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const moveTo = (x: number, y: number) => setPosition({
    x: Math.max(-Math.max(0, window.innerWidth - 210), Math.min(28, x)),
    y: Math.max(-Math.max(0, window.innerHeight - 170), Math.min(100, y)),
  });
  return <section className="team-call-local-preview pointer-events-auto overflow-hidden rounded-xl border shadow-2xl" style={{ transform: `translate3d(${position.x}px,${position.y}px,0)` }} aria-label="Prévia da sua tela compartilhada">
    <header
      role="button"
      tabIndex={0}
      className="team-call-preview-drag-handle flex cursor-move touch-none items-center justify-between gap-3 px-3 py-2 text-xs font-black"
      aria-label="Mover prévia da sua transmissão"
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 12;
        if (event.key === "ArrowLeft") moveTo(position.x - step, position.y);
        else if (event.key === "ArrowRight") moveTo(position.x + step, position.y);
        else if (event.key === "ArrowUp") moveTo(position.x, position.y - step);
        else if (event.key === "ArrowDown") moveTo(position.x, position.y + step);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        moveTo(drag.originX + event.clientX - drag.x, drag.originY + event.clientY - drag.y);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    ><span className="flex items-center gap-2"><Move size={13} /><MonitorUp size={14} /> Você está compartilhando</span><span className="text-emerald-400">AO VIVO</span></header>
    <div className="aspect-video bg-black"><StreamVideo stream={stream} muted fit="contain" label="Mini visualização da sua tela compartilhada" /></div>
  </section>;
}

function ParticipantAvatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  if (photoUrl && !photoFailed) {
    return <img src={photoUrl} alt={`Foto de ${name}`} className="h-full w-full rounded-full object-cover" onError={() => setPhotoFailed(true)} />;
  }
  return <>{initials(name)}</>;
}

function RemoteParticipantMedia({ stream, participantName, profilePhoto, sharing, videoEnabled }: { stream: MediaStream; participantName: string; profilePhoto?: string; sharing: boolean; videoEnabled: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoActive, setVideoActive] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = stream.getVideoTracks();
    const refresh = () => {
      const active = videoEnabled && tracks.some((track) => track.readyState !== "ended" && !track.muted);
      setVideoActive(active);
      // Limpar a fonte elimina o ultimo quadro mesmo com a faixa RTP viva.
      video.srcObject = active ? new MediaStream(tracks) : null;
      if (active) void video.play().catch(() => undefined);
    };
    tracks.forEach((track) => ["unmute", "mute", "ended"].forEach((event) => track.addEventListener(event, refresh)));
    refresh();
    return () => {
      tracks.forEach((track) => ["unmute", "mute", "ended"].forEach((event) => track.removeEventListener(event, refresh)));
      video.srcObject = null;
    };
  }, [stream, videoEnabled, sharing]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen();
    } catch { /* O navegador mantem a visualizacao na chamada. */ }
  };
  return <div ref={containerRef} className="relative h-full min-h-0 w-full bg-black">
    <video key={sharing ? "screen" : "camera"} ref={videoRef} autoPlay playsInline muted aria-label={sharing ? `Tela compartilhada por ${participantName}` : `Câmera de ${participantName}`} className={`h-full w-full bg-black ${sharing ? "object-contain" : "object-cover"} ${videoEnabled && videoActive ? "" : "invisible"}`} />
    {(!videoEnabled || !videoActive) && <div className="absolute inset-0 grid place-items-center bg-[#050709] p-3 text-center"><div><span className="team-call-primary-button mx-auto grid h-16 w-16 place-items-center overflow-hidden rounded-full text-xl font-black text-white">{sharing ? <MonitorUp size={24} /> : <ParticipantAvatar name={participantName} photoUrl={profilePhoto} />}</span><p className="mt-3 text-sm font-black">{sharing ? "Recebendo a transmissão de tela..." : `${participantName} está sem câmera`}</p></div></div>}
    {sharing && <button type="button" onClick={() => void toggleFullscreen()} className="team-call-screen-label absolute right-3 top-3 z-20 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-black" aria-label={`Ver tela de ${participantName} em tela cheia`}><Maximize2 size={15} /> Tela cheia</button>}
  </div>;
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

function bytesLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export default function TeamCallOverlay({ snapshot, commands, members, currentUserId, attachmentToken = "", onDownloadAttachment }: TeamCallOverlayProps) {
  const call = callSessionView(snapshot, commands);
  const beforeStudioEndRef = useRef<(() => Promise<boolean>) | null>(null);
  const endingRef = useRef(false);
  const finishCall = async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    try {
      updateMinimized(false);
      if (call.isHost && beforeStudioEndRef.current) {
        updateMinimized(false);
        if (!(await beforeStudioEndRef.current())) return;
      }
      await (call.isHost ? call.endCall() : call.leaveCall());
    } finally { endingRef.current = false; }
  };
  const messages = snapshot.conversation?.messages || [];
  const raisedHands = call.raisedHands || {};
  const [minimized, setMinimized] = useState(() => storedMinimizedCall() === snapshot.active?.callId);
  const [messageError, setMessageError] = useState("");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [messageFiles, setMessageFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [audioSettings, setAudioSettings] = useState<Record<string, { volume: number; screenVolume: number; microphoneMuted: boolean; screenMuted: boolean }>>({});
  const [watchedScreens, setWatchedScreens] = useState<Record<string, boolean>>({});
  const [outputMuted, setOutputMuted] = useState(false);
  const [mirrorLocalVideo, setMirrorLocalVideo] = useState(true);
  const [pinned, setPinned] = useState<{ userId: string; type: "member" | "screen" } | null>(null);
  const incomingDialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setAudioSettings({}); setWatchedScreens({}); setPinned(null); setMinimized(storedMinimizedCall() === call.active?.callId); setOutputMuted(false); setMessageText(""); setMessageFiles([]); setMessageError("");
    setStudioOpen(false); setChatOpen(false); setPeopleOpen(false); setQualityOpen(false); setDevicesOpen(false); setReactionsOpen(false);
  }, [call.active?.callId]);
  function updateMinimized(value: boolean) {
    setMinimized(value);
    try {
      if (value && call.active?.callId) sessionStorage.setItem(MINIMIZED_CALL_KEY, call.active.callId);
      else sessionStorage.removeItem(MINIMIZED_CALL_KEY);
    } catch { /* O armazenamento pode estar bloqueado sem interromper a chamada. */ }
  }
  useEffect(() => {
    if (pinned && (!call.remoteStreams.some((item) => item.userId === pinned.userId) ||
      (pinned.type === "screen" && !call.remoteScreenSharingIds.includes(pinned.userId)))) setPinned(null);
  }, [pinned, call.remoteStreams, call.remoteScreenSharingIds]);
  useEffect(() => {
    if (call.incoming && !call.active && !snapshot.prejoin) incomingDialogRef.current?.focus();
  }, [call.active, call.incoming, snapshot.prejoin]);
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
    setMessageError("");
    try {
      await call.sendMeetingMessage(outgoing, messageFiles);
      setMessageText("");
      setMessageFiles([]);
    } catch (error) { setMessageError(error instanceof Error ? error.message : "Não foi possível enviar a mensagem."); }
    finally { setSending(false); }
  }

  if (snapshot.prejoin) {
    const currentMember = members.find((member) => member.id === currentUserId);
    const displayName = currentMember?.nome || "Você";
    return createPortal(<CallPrejoin snapshot={snapshot} commands={commands} displayName={displayName} profilePhoto={currentMember?.fotoUrl} mirrorLocalVideo={mirrorLocalVideo} onMirrorLocalVideo={setMirrorLocalVideo} />, document.body);
  }

  if (!call.active && !call.incoming && snapshot.reconnectionNotice) {
    return createPortal(<div role="status" aria-live="assertive" className="fixed right-4 top-4 z-[182] max-w-sm rounded-xl border border-amber-400/40 bg-[#171b21] p-4 text-sm font-bold text-amber-100 shadow-2xl">{snapshot.reconnectionNotice}</div>, document.body);
  }

  if (!call.active && !call.incoming && snapshot.failureNotice) {
    return createPortal(
      <section role="alert" aria-live="assertive" className="fixed right-4 top-4 z-[183] max-w-sm rounded-xl border border-rose-400/40 bg-[#171b21] p-4 text-sm text-rose-100 shadow-2xl">
        <strong className="block">Não foi possível entrar na chamada</strong>
        <p className="mt-1">{snapshot.failureNotice}</p>
        <button type="button" onClick={commands.dismissFailure} className="mt-3 rounded-lg border border-rose-300/30 px-3 py-1.5 text-xs font-black hover:bg-rose-500/15" aria-label="Fechar aviso">Fechar</button>
      </section>,
      document.body,
    );
  }

  if (call.incoming && !call.active) {
    return createPortal(
      <div className="team-call-incoming-backdrop fixed inset-0 z-[180] grid place-items-center p-4">
        <section ref={incomingDialogRef} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); call.rejectIncoming(); } }} role="dialog" aria-modal="true" aria-labelledby="incoming-call-title" aria-describedby="incoming-call-description" className="team-call-incoming-card team-call-professional-invite w-full max-w-sm rounded-2xl border p-6 text-center shadow-2xl">
          <span className="team-call-control-surface mx-auto grid h-16 w-16 place-items-center rounded-full"><Video size={28} /></span>
          <p className="team-call-accent-text mt-5 text-xs font-bold uppercase tracking-[.18em]">Reunião iniciada</p>
          <h2 id="incoming-call-title" className="mt-2 text-xl font-black">{call.incoming.fromUserName}</h2>
          <p id="incoming-call-description" className="mt-2 text-sm text-[var(--text-secondary)]">Convidou você para {call.incoming.thread.scope === "direct" ? "uma chamada individual" : "uma reunião da equipe"}.</p>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Sua câmera entra desligada e pode ser ativada dentro da reunião.</p>
          {!call.ringtoneAudible && <p role="status" aria-live="assertive" className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-xs font-bold text-amber-200">Chamada recebida · alerta visual ativo</p>}
          <div className="mt-6 flex justify-center gap-4">
            <button type="button" onClick={call.rejectIncoming} className="grid h-14 w-14 place-items-center rounded-full bg-rose-600 hover:bg-rose-500" aria-label="Recusar chamada"><PhoneOff size={22} /></button>
            <button type="button" disabled={call.busy} onClick={() => void call.acceptIncoming()} className="team-call-primary-button grid h-14 w-14 place-items-center rounded-full text-white disabled:opacity-60" aria-label="Entrar na reunião"><Video size={22} /></button>
          </div>
        </section>
      </div>, document.body,
    );
  }
  if (!call.active) return null;

  const streams = call.remoteStreams;
  const updateAudio = (userId: string, patch: Partial<{ volume: number; screenVolume: number; microphoneMuted: boolean; screenMuted: boolean }>) =>
    setAudioSettings((current) => ({ ...current, [userId]: { ...(current[userId] || { volume: 100, screenVolume: 100, microphoneMuted: false, screenMuted: false }), ...patch } }));
  const toggleWatchingScreen = (userId: string) => setWatchedScreens((current) => {
    const nextValue = !current[userId];
    if (!nextValue && pinned?.userId === userId && pinned.type === "screen") setPinned(null);
    return { ...current, [userId]: nextValue };
  });
  const togglePin = (userId: string, type: "member" | "screen") =>
    setPinned((current) => current?.userId === userId && current.type === type ? null : { userId, type });
  const participantIds = Array.from(new Set([
    ...(snapshot.conversation?.participantIds || [currentUserId]),
    ...streams.map((item) => item.userId),
  ]));
  const tileCount = streams.reduce((total, item) => total + (call.remoteScreenSharingIds.includes(item.userId) ? 2 : 1), 0);
  const screenCount = streams.filter((item) => call.remoteScreenSharingIds.includes(item.userId)).length;
  const stageLayout = screenCount > 1 ? "team-call-stage-multi-screen"
    : screenCount === 1 ? "team-call-stage-single-screen"
      : pinned && tileCount > 1 ? "team-call-stage-pinned" : "";
  const stageStyle = {
    "--team-call-rows": Math.max(1, Math.ceil(tileCount / 2)),
    "--team-call-side-rows": Math.max(1, tileCount - 1),
    "--team-call-screen-columns": Math.max(1, screenCount, streams.length),
    "--team-call-member-rows": Math.max(1, Math.ceil(streams.length / Math.max(1, screenCount))),
  } as CSSProperties;
  const togglePanel = (panel: "chat" | "people" | "devices") => {
    setChatOpen(panel === "chat" ? !chatOpen : false);
    setPeopleOpen(panel === "people" ? !peopleOpen : false);
    setDevicesOpen(panel === "devices" ? !devicesOpen : false);
    setReactionsOpen(false);
    setQualityOpen(false);
  };
  const connectionLabel = { offline: "Sem internet", connecting: "Conectando", poor: "Conexão fraca", fair: "Conexão estável", good: "Conexão excelente" }[call.connectionQuality];
  const connectionColor = { offline: "text-rose-300", connecting: "text-amber-300", poor: "text-rose-300", fair: "text-amber-300", good: "text-emerald-300" }[call.connectionQuality];

  return createPortal(
    <>
    {minimized && <section className="team-call-minimized fixed bottom-4 right-4 z-[181] flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-2xl border p-3 shadow-2xl" aria-label="Chamada minimizada">
      <div className="min-w-0 flex-1 px-2"><strong className="block truncate text-sm">{call.active.title}</strong><small>{durationLabel(call.callElapsedSeconds)}{call.sharingScreen ? " · Transmitindo" : ""}{call.recording ? " · Gravando" : ""}</small></div>
      <button type="button" onClick={() => updateMinimized(false)} className="team-call-top-control" aria-label="Restaurar chamada"><Maximize2 size={18} /><span>Restaurar</span></button>
      <button type="button" onClick={call.toggleMute} className="team-call-top-control" aria-label={call.muted ? "Ativar microfone" : "Silenciar microfone"}>{call.muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
      {call.sharingScreen && <button type="button" onClick={() => void call.toggleScreenShare()} className="team-call-top-control" aria-label="Parar transmissão de tela"><MonitorUp size={18} /></button>}
      <button type="button" onClick={() => void finishCall()} className="team-call-top-control team-call-danger" aria-label={call.isHost ? "Encerrar reunião" : "Sair da reunião"}><PhoneOff size={18} /></button>
    </section>}
    <div className="team-call-shell team-call-professional fixed inset-0 z-[180] flex flex-col" style={minimized ? { display: "none" } : undefined}>
      <header className="team-call-header relative flex min-h-16 items-center justify-between gap-4 border-b px-3 py-2 shadow-lg">
        <div className="min-w-0 pl-1">
          <p className="truncate text-sm font-black">{call.active.title}</p>
          <p className="flex items-center gap-1.5 truncate text-[11px] text-[var(--text-secondary)]"><Clock3 size={12} /> {durationLabel(call.callElapsedSeconds)} · {call.status || "Na chamada"}</p>
        </div>
        <span className="team-call-room-badge"><Users size={14} /> {participantIds.length} participante{participantIds.length === 1 ? "" : "s"}</span>
      </header>

      {snapshot.reconnectionNotice && <div role="status" aria-live="polite" className="border-b border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-center text-xs font-bold text-emerald-200">{snapshot.reconnectionNotice}</div>}
      {snapshot.iceService && ["degraded", "unavailable"].includes(snapshot.iceService.status) && <div role="alert" className="border-b border-amber-400/30 bg-amber-500/10 px-4 py-2 text-center text-xs font-bold text-amber-100">{snapshot.iceService.detail}</div>}
      <div role="status" aria-label="Estados da chamada" aria-live="polite" className="flex flex-wrap items-center justify-center gap-2 border-b border-[var(--border)] px-4 py-2 text-xs font-bold">
        <span className={call.listenOnly || call.muted ? "text-amber-200" : "text-emerald-200"}>Microfone: {call.listenOnly ? "somente escuta" : call.muted ? "desligado" : "ligado"}</span>
        <span aria-hidden="true">·</span><span className={call.cameraOff ? "text-amber-200" : "text-emerald-200"}>Câmera: {call.cameraOff ? "desligada" : "ligada"}</span>
        <span aria-hidden="true">·</span><span className={call.sharingScreen ? "text-blue-200" : "text-[var(--text-secondary)]"}>Compartilhamento: {call.sharingScreen ? "ativo" : "desligado"}</span>
        <span aria-hidden="true">·</span><span className={call.recording ? "text-rose-200" : "text-[var(--text-secondary)]"}>Gravação: {call.recording ? "ativa" : "desligada"}</span>
      </div>

      {call.cameraPermission !== "unknown" && call.cameraPermission !== "granted" && (
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

      {Object.keys(raisedHands).length > 0 && <div className="team-call-hands flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs" role="status" aria-label="Mãos levantadas"><Hand size={16} />{Object.entries(raisedHands).sort((a, b) => a[1].localeCompare(b[1])).map(([id], index) => <span key={id}>{index + 1}. {id === currentUserId ? "Você" : memberById.get(id)?.nome || "Participante"}</span>)}</div>}
      <div className={`team-call-content flex min-h-0 flex-1 ${studioOpen ? "team-call-content-studio" : ""}`}>
        {snapshot.clientId && <TeamCallStudio beforeEndRef={beforeStudioEndRef} key={call.active.callId} callId={call.active.callId!} clientId={snapshot.clientId} currentUserId={currentUserId} isHost={call.isHost} visible={studioOpen} onOpen={() => { setStudioOpen(true); setChatOpen(false); setPeopleOpen(false); }} onClose={() => setStudioOpen(false)} />}
        <main className={`team-call-stage relative grid min-h-0 min-w-0 flex-1 gap-3 p-3 ${stageLayout} ${pinned?.type === "screen" ? "team-call-stage-screen-pinned" : ""} ${!stageLayout && tileCount > 1 ? "md:grid-cols-2" : ""}`} style={stageStyle} data-screen-count={screenCount}>
          {call.recording && <div role="status" aria-live="polite" className="team-call-recording-badge absolute left-5 top-5 z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black text-rose-300"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /><span>REC {durationLabel(call.recordingElapsedSeconds)}</span><span className="font-semibold text-rose-100">Todos foram avisados</span>{call.isHost && call.recordingUploadState !== "idle" && <span className="font-semibold text-rose-100">{call.recordingUploadState === "retrying" ? "Tentando envio novamente" : call.recordingUploadState === "finalizing" ? "Finalizando" : `Upload ${call.recordingUploadProgress}% · ${bytesLabel(call.recordingUploadedBytes)} enviados${call.recordingPendingBytes ? ` · ${bytesLabel(call.recordingPendingBytes)} pendentes` : ""}`}</span>}</div>}
          {streams.length ? streams.flatMap((item) => {
            const sharing = call.remoteScreenSharingIds.includes(item.userId);
            const participant = memberById.get(item.userId);
            const participantName = participant?.nome || "Participante";
            const settings = audioSettings[item.userId] || { volume: 100, screenVolume: 100, microphoneMuted: false, screenMuted: false };
            const watchingScreen = Boolean(watchedScreens[item.userId]);
            const memberPinned = pinned?.userId === item.userId && pinned.type === "member";
            const screenPinned = pinned?.userId === item.userId && pinned.type === "screen";
            const memberTile = <section key={`${item.userId}:member`} data-participant={item.userId} data-tile="member" data-pinned={memberPinned || undefined} className={`team-call-remote-tile team-call-member-tile relative flex min-h-56 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] ${memberPinned ? "team-call-pinned-tile" : ""}`}>
              <ParticipantAudio stream={item.stream} name={participantName} volume={settings.volume} screenVolume={settings.screenVolume} microphoneMuted={settings.microphoneMuted} screenMuted={settings.screenMuted || !watchingScreen} outputMuted={outputMuted} sinkId={call.selectedSpeakerId} />
              <div className="relative min-h-36 flex-1 overflow-hidden"><RemoteParticipantMedia stream={item.stream} participantName={participantName} profilePhoto={participant?.fotoUrl} sharing={false} videoEnabled={!sharing && call.remoteCameraEnabled?.[item.userId] === true} /></div>
              <div className="team-call-participant-controls flex flex-wrap items-center gap-2 border-t p-2">
                <strong className="mr-auto max-w-36 truncate text-xs">{participantName}</strong>
                <button type="button" aria-label={`${settings.microphoneMuted ? "Ouvir" : "Silenciar"} microfone de ${participantName} para mim`} aria-pressed={settings.microphoneMuted} onClick={() => updateAudio(item.userId, { microphoneMuted: !settings.microphoneMuted })} className="rounded-lg p-2 hover:bg-white/10">{settings.microphoneMuted ? <MicOff size={17} /> : <Mic size={17} />}</button>
                <label className="flex items-center gap-2 text-xs"><span className="sr-only">Volume de {participantName}</span><input aria-label={`Volume de ${participantName}`} type="range" min="0" max="200" step="5" value={settings.volume} onChange={(event) => updateAudio(item.userId, { volume: Number(event.target.value) })} className="w-24 accent-blue-500" /><span className="w-9">{settings.volume}%</span></label>
                <button type="button" onClick={() => togglePin(item.userId, "member")} aria-pressed={memberPinned} aria-label={`${memberPinned ? "Desafixar" : "Fixar"} ${participantName}`} className="flex items-center gap-1 rounded-lg p-2 text-xs hover:bg-white/10">{memberPinned ? <PinOff size={15} /> : <Pin size={15} />} Membro</button>
              </div>
            </section>;
            if (!sharing) return [memberTile];
            const screenTile = <section key={`${item.userId}:screen`} data-participant={item.userId} data-tile="screen" data-pinned={screenPinned || undefined} data-watching={watchingScreen || undefined} className={`team-call-remote-tile team-call-remote-screen relative flex min-h-56 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] ${screenPinned ? "team-call-pinned-tile" : ""}`}>
              <div className="relative min-h-36 flex-1 overflow-hidden">{watchingScreen ? <RemoteParticipantMedia stream={item.stream} participantName={participantName} sharing videoEnabled /> : <div className="team-call-screen-optin grid h-full place-content-center gap-3 p-6 text-center"><MonitorUp className="mx-auto text-blue-300" size={34} /><strong className="text-sm">{participantName} está transmitindo</strong><p className="text-xs text-[var(--text-secondary)]">A transmissão só será reproduzida quando você escolher assistir.</p><button type="button" onClick={() => toggleWatchingScreen(item.userId)} className="team-call-primary-button mx-auto rounded-lg px-4 py-2 text-xs font-black">Assistir transmissão</button></div>}<span className="team-call-screen-label absolute left-3 top-3 rounded-lg px-3 py-1.5 text-xs font-black"><MonitorUp size={14} /> Tela de {participantName}</span></div>
              <div className="team-call-participant-controls flex flex-wrap items-center gap-2 border-t p-2"><strong className="mr-auto max-w-44 truncate text-xs">Transmissão de {participantName}</strong>{watchingScreen && <><button type="button" aria-label={`${settings.screenMuted ? "Ouvir" : "Silenciar"} áudio da transmissão de ${participantName} para mim`} aria-pressed={settings.screenMuted} onClick={() => updateAudio(item.userId, { screenMuted: !settings.screenMuted })} className="rounded-lg p-2 hover:bg-white/10">{settings.screenMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><label className="flex items-center gap-2 text-xs"><span className="sr-only">Volume da transmissão de {participantName}</span><input aria-label={`Volume da transmissão de ${participantName}`} type="range" min="0" max="200" step="5" value={settings.screenVolume} onChange={(event) => updateAudio(item.userId, { screenVolume: Number(event.target.value) })} className="w-24 accent-blue-500" /><span className="w-9">{settings.screenVolume}%</span></label><button type="button" onClick={() => togglePin(item.userId, "screen")} aria-pressed={screenPinned} aria-label={`${screenPinned ? "Desafixar" : "Fixar"} transmissão de ${participantName}`} className="flex items-center gap-1 rounded-lg p-2 text-xs hover:bg-white/10">{screenPinned ? <PinOff size={15} /> : <Pin size={15} />} Transmissão</button><button type="button" onClick={() => toggleWatchingScreen(item.userId)} className="rounded-lg px-2 py-1.5 text-xs font-bold hover:bg-white/10">Parar de assistir</button></>}</div>
            </section>;
            return [screenTile, memberTile];
          }) : <WaitingStage title={call.active.title} />}
          {(call.screenStream || (call.localStream && !call.cameraOff)) && <div className="team-call-local-previews pointer-events-none absolute bottom-28 right-5 z-20 flex flex-col items-end gap-2">
            {call.screenStream && <DraggableScreenPreview stream={call.screenStream} />}
            {call.localStream && !call.cameraOff && <section className="team-call-camera-preview h-24 w-36 overflow-hidden rounded-xl border shadow-2xl md:h-28 md:w-44"><StreamVideo stream={call.localStream} muted label="Sua câmera" mirrored={mirrorLocalVideo} /></section>}
          </div>}
          <div className="pointer-events-none absolute bottom-8 left-6 z-20 flex items-end gap-3">{call.reactions.map((reaction) => <div key={reaction.id} className="team-call-reaction rounded-full bg-[#11151a] px-3 py-2 text-center shadow-xl"><span className="block text-3xl">{reaction.emoji}</span><small className="block max-w-24 truncate text-[10px] text-[#9ca7b5]">{reaction.userName}</small></div>)}</div>
        </main>

        {(chatOpen || peopleOpen) && <aside className="team-call-side-panel flex w-[min(92vw,390px)] shrink-0 flex-col border-l">
          <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4"><h3 className="font-black">{chatOpen ? "Chat da reunião" : "Pessoas"}</h3><button type="button" onClick={() => { setChatOpen(false); setPeopleOpen(false); }} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar painel"><X size={18} /></button></div>
          {chatOpen && <p className="border-b border-[var(--border)] px-4 py-2 text-xs text-[#9ca7b5]">Chat temporário: mensagens e anexos serão apagados ao encerrar esta reunião.</p>}
          {chatOpen && messageError && <p role="alert" className="px-4 py-2 text-xs text-rose-300">{messageError}</p>}
          {chatOpen ? <MeetingChat messages={messages} currentUserId={currentUserId} attachmentToken={attachmentToken} listRef={chatListRef} messageText={messageText} messageFiles={messageFiles} sending={sending} onMessageText={setMessageText} onMessageFiles={setMessageFiles} onSubmit={submitMessage} onDownloadAttachment={onDownloadAttachment} /> : <PeoplePanel participantIds={participantIds} currentUserId={currentUserId} memberById={memberById} raisedHands={raisedHands} />}
        </aside>}
      </div>
      <footer className="team-call-toolbar">
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Controles da reunião">
          <button type="button" onClick={() => updateMinimized(true)} className="team-call-top-control" aria-label="Minimizar chamada"><Minimize2 size={19} /><span>Minimizar</span></button>
          {call.isHost && <button type="button" onClick={() => void (call.recording ? call.stopRecording() : call.startRecording())} className={`team-call-top-control ${call.recording ? "team-call-danger" : ""}`} aria-label={call.recording ? "Parar gravação" : "Gravar reunião"}><Circle size={18} fill={call.recording ? "currentColor" : "none"} /><span>{call.recording ? "Parar gravação" : "Gravar"}</span></button>}
          <button type="button" onClick={() => { setStudioOpen((current) => !current); setChatOpen(false); setPeopleOpen(false); }} className={`team-call-top-control ${studioOpen ? "team-call-active" : ""}`} aria-pressed={studioOpen} aria-label="Abrir estúdio da chamada"><LayoutGrid size={19} /><span>Estúdio</span></button>
          <button type="button" onClick={() => togglePanel("chat")} className={`team-call-top-control ${chatOpen ? "team-call-active" : ""}`} aria-label="Abrir chat da reunião"><MessageSquareText size={19} /><span>Chat</span></button>
          <button type="button" onClick={() => togglePanel("people")} className={`team-call-top-control ${peopleOpen ? "team-call-active" : ""}`} aria-label="Ver pessoas na reunião"><Users size={19} /><span>Pessoas</span></button>
          <button type="button" onClick={call.toggleHand} className={`team-call-top-control ${raisedHands[currentUserId] ? "team-call-active" : ""}`} aria-pressed={!!raisedHands[currentUserId]} aria-label={raisedHands[currentUserId] ? "Baixar a mão" : "Levantar a mão"}><Hand size={19} /><span>{raisedHands[currentUserId] ? "Baixar mão" : "Levantar mão"}</span></button>
          <div role="status" className={`team-call-top-control ${connectionColor}`} aria-label={`Qualidade da internet: ${connectionLabel}`} title={connectionLabel}>{call.connectionQuality === "offline" ? <WifiOff size={19} /> : <Wifi size={19} />}<span>{connectionLabel}</span></div>
          <button type="button" onClick={() => { setReactionsOpen((current) => !current); setDevicesOpen(false); setChatOpen(false); setPeopleOpen(false); }} className={`team-call-top-control ${reactionsOpen ? "team-call-active" : ""}`} aria-label="Enviar reação com emoji"><SmilePlus size={19} /><span>Reagir</span></button>
          <button type="button" disabled={call.screenChangePending} onClick={() => void call.toggleScreenShare()} className={`team-call-top-control ${call.sharingScreen ? "team-call-active" : ""}`} aria-label={call.sharingScreen ? "Parar transmissão de tela" : "Transmitir tela"}><MonitorUp size={19} /><span>{call.sharingScreen ? "Parar tela" : "Transmitir tela"}</span></button>
          {call.sharingScreen && <button type="button" disabled={call.screenChangePending} onClick={() => void call.changeScreenShare()} className="team-call-top-control" aria-label="Trocar tela ou janela"><MonitorUp size={19} /><span>{call.screenChangePending ? "Escolhendo..." : "Trocar tela ou janela"}</span></button>}
          <button type="button" onClick={() => { setQualityOpen((current) => !current); setDevicesOpen(false); setChatOpen(false); setPeopleOpen(false); setReactionsOpen(false); }} className={`team-call-top-control ${qualityOpen ? "team-call-active" : ""}`} aria-label="Configurar qualidade da transmissão"><SlidersHorizontal size={19} /><span>Qualidade</span></button>
          <button type="button" onClick={() => void call.toggleCamera()} className={`team-call-top-control ${call.cameraOff ? "team-call-danger" : ""}`} aria-label={call.cameraOff ? "Ativar câmera" : "Desativar câmera"}>{call.cameraOff ? <CameraOff size={19} /> : <Camera size={19} />}<span>Câmera</span></button>
          <button type="button" onClick={call.toggleMute} className={`team-call-top-control ${call.muted ? "team-call-danger" : ""}`} aria-label={call.muted ? "Ativar microfone" : "Silenciar microfone"}>{call.muted ? <MicOff size={19} /> : <Mic size={19} />}<span>Microfone</span></button>
          <button type="button" onClick={() => setOutputMuted((current) => !current)} className={`team-call-top-control ${outputMuted ? "team-call-danger" : ""}`} aria-pressed={outputMuted} aria-label={outputMuted ? "Ativar fones" : "Mutar fones"}>{outputMuted ? <VolumeX size={19} /> : <Headphones size={19} />}<span>Fones</span></button>
          <button type="button" onClick={() => togglePanel("devices")} className={`team-call-top-control ${devicesOpen ? "team-call-active" : ""}`} aria-label="Selecionar câmera e dispositivos de áudio"><Settings2 size={19} /><span>Dispositivos</span></button>
          <button type="button" onClick={() => void finishCall()} className="team-call-top-control team-call-danger ml-2" aria-label={call.isHost ? "Encerrar reunião" : "Sair da reunião"}><PhoneOff size={20} /><span>{call.isHost ? "Encerrar" : "Sair"}</span></button>
        </nav>
        {devicesOpen && <DeviceSelector call={call} mirrorLocalVideo={mirrorLocalVideo} onMirrorLocalVideo={setMirrorLocalVideo} onClose={() => setDevicesOpen(false)} />}
        {qualityOpen && <ScreenShareQualitySelector call={call} onClose={() => setQualityOpen(false)} />}
        {reactionsOpen && <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 flex gap-1 rounded-2xl border p-2 shadow-2xl" aria-label="Reações da reunião">{["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].map((emoji) => <button key={emoji} type="button" onClick={() => { call.sendReaction(emoji); setReactionsOpen(false); }} className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-[#1b2128]" aria-label={`Reagir com ${emoji}`}>{emoji}</button>)}</section>}
      </footer>
    </div></>, document.body,
  );
}

function CallPrejoin({ snapshot, commands, displayName, profilePhoto, mirrorLocalVideo, onMirrorLocalVideo }: { snapshot: CallSessionSnapshot; commands: CallSessionCommands; displayName: string; profilePhoto?: string; mirrorLocalVideo: boolean; onMirrorLocalVideo: (enabled: boolean) => void }) {
  const entry = snapshot.prejoin!;
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); commands.cancelEntry(); return; }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])") || []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const microphoneProblem = snapshot.microphonePermission === "denied"
    ? "Permissão do microfone negada. Libere o microfone nas configurações do navegador ou entre somente para escutar."
    : snapshot.microphonePermission === "unavailable"
      ? "Microfone indisponível. Conecte outro dispositivo ou entre somente para escutar."
      : "";
  const cameraProblem = snapshot.cameraPermission === "denied"
    ? "Permissão da câmera negada. Você ainda pode entrar somente por áudio."
    : snapshot.cameraPermission === "unavailable"
      ? "Câmera indisponível. Você ainda pode entrar somente por áudio."
      : "";

  return <div className="team-call-incoming-backdrop team-call-prejoin-backdrop fixed inset-0 z-[182] grid place-items-center p-4">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Preparar entrada" className="team-call-incoming-card team-call-prejoin w-full rounded-3xl border shadow-2xl">
      <header className="team-call-prejoin-header">
        <span className="team-call-prejoin-brand" aria-hidden="true">N</span>
        <div><p className="team-call-accent-text">Sala de espera Norium</p><h2>{entry.title}</h2><p>Confira câmera e áudio antes de entrar.</p></div>
        <button type="button" onClick={commands.cancelEntry} aria-label="Fechar preparação da chamada"><X size={19} /></button>
      </header>

      <div className="team-call-prejoin-grid">
        <section className="team-call-prejoin-video-column" aria-label="Prévia de vídeo">
          <div className="team-call-prejoin-video">
            {entry.previewEnabled && snapshot.previewStream
              ? <StreamVideo stream={snapshot.previewStream} muted label="Prévia da câmera" mirrored={mirrorLocalVideo} />
              : <div className="team-call-prejoin-placeholder"><span className={profilePhoto ? "has-photo" : ""}>{profilePhoto ? <img src={profilePhoto} alt={`Foto de ${displayName}`} /> : initials(displayName)}</span><strong>{entry.cameraEnabled ? "Abrindo a prévia da câmera" : "Câmera desligada"}</strong><small>{entry.cameraEnabled ? "A prévia aparece automaticamente assim que a câmera responder." : "Sua foto de perfil permanece visível enquanto a câmera estiver desligada."}</small></div>}
          </div>
          <div className="team-call-prejoin-video-controls">
            <label className={`team-call-prejoin-icon-control ${entry.cameraEnabled ? "is-active" : ""}`}>
              <input type="checkbox" checked={entry.cameraEnabled} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => void commands.setEntryCameraEnabled(event.target.checked)} aria-label="Entrar com câmera ligada" />
              {entry.cameraEnabled ? <Camera size={19} /> : <CameraOff size={19} />}<span>{entry.cameraEnabled ? "Câmera ligada" : "Câmera desligada"}</span>
            </label>
            <label className={`team-call-prejoin-icon-control ${snapshot.backgroundBlur ? "is-active" : ""}`} title={snapshot.supportsBackgroundBlur ? "Embaçar somente o fundo da câmera" : "O navegador ou a câmera não oferece desfoque de fundo"}>
              <input type="checkbox" checked={snapshot.backgroundBlur} disabled={!entry.cameraEnabled || !snapshot.supportsBackgroundBlur} onChange={(event) => void commands.setBackgroundBlur(event.target.checked)} aria-label="Embaçar fundo" />
              <SlidersHorizontal size={18} /><span>Embaçar fundo</span>
            </label>
            <label className={`team-call-prejoin-icon-control ${mirrorLocalVideo ? "is-active" : ""}`} title="Desative para visualizar exatamente como os outros participantes veem seu vídeo">
              <input type="checkbox" checked={mirrorLocalVideo} disabled={!entry.cameraEnabled} onChange={(event) => onMirrorLocalVideo(event.target.checked)} aria-label="Espelhar minha prévia" />
              <FlipHorizontal2 size={18} /><span>{mirrorLocalVideo ? "Prévia espelhada" : "Visão dos outros"}</span>
            </label>
            <label className="team-call-prejoin-device compact"><span>Câmera</span><select aria-label="Câmera para a chamada" value={snapshot.selectedCameraId} disabled={!entry.cameraEnabled || entry.microphoneMode === "listen-only"} onChange={(event) => void commands.selectCamera(event.target.value)}><option value="">Padrão do sistema</option>{snapshot.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select></label>
          </div>
          {cameraProblem && <p role="alert" className="team-call-prejoin-alert is-warning">{cameraProblem}</p>}
        </section>

        <section className="team-call-prejoin-options" aria-label="Opções de entrada">
          <label className="team-call-prejoin-name"><span>Você entrará como</span><input aria-label="Nome de exibição" value={displayName} readOnly /></label>
          <fieldset className="team-call-prejoin-audio"><legend>Como deseja ouvir e falar?</legend>
            {(["on", "muted", "listen-only"] as const).map((mode) => <label key={mode} className={entry.microphoneMode === mode ? "is-selected" : ""}><input type="radio" name="call-entry-microphone" checked={entry.microphoneMode === mode} onChange={() => commands.setEntryMicrophoneMode(mode)} aria-label={mode === "on" ? "Entrar com microfone ligado" : mode === "muted" ? "Entrar com microfone desligado" : "Entrar somente para escutar"} /><span className="team-call-prejoin-radio" /><span className="team-call-prejoin-option-icon">{mode === "on" ? <Mic size={18} /> : mode === "muted" ? <MicOff size={18} /> : <VolumeX size={18} />}</span><span><strong>{mode === "on" ? "Áudio do computador" : mode === "muted" ? "Entrar com microfone desligado" : "Não usar microfone"}</strong><small>{mode === "on" ? "Você entra pronto para falar" : mode === "muted" ? "Ouça normalmente e ative quando quiser" : "Somente escuta, sem solicitar o microfone"}</small></span></label>)}
          </fieldset>
          <div className="team-call-prejoin-devices">
            <label className="team-call-prejoin-device"><span><Mic size={15} /> Microfone</span><select aria-label="Microfone para a chamada" value={snapshot.selectedMicrophoneId} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => void commands.selectMicrophone(event.target.value)}><option value="">Padrão do sistema</option>{snapshot.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
            <label className="team-call-prejoin-device"><span><Volume2 size={15} /> Saída de áudio</span><select aria-label="Saída de áudio para a chamada" value={snapshot.selectedSpeakerId || ""} disabled={!snapshot.supportsSpeakerSelection} onChange={(event) => commands.selectSpeaker(event.target.value)}><option value="">Padrão do sistema</option>{snapshot.devices.speakers.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Saída", index)}</option>)}</select>{!snapshot.supportsSpeakerSelection && <small>A saída é controlada pelo sistema neste navegador.</small>}</label>
          </div>
          <div className="team-call-prejoin-audio-settings">
            <label className="team-call-prejoin-switch">
              <span><strong>Supressão de ruído</strong><small>Reduz sons contínuos do ambiente.</small></span>
              <input type="checkbox" checked={snapshot.noiseSuppression} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => void commands.setNoiseSuppression(event.target.checked)} aria-label="Supressão de ruído" />
            </label>
            <label className="team-call-prejoin-sensitivity">
              <span><strong>Sensibilidade do microfone</strong><output>{snapshot.microphoneSensitivity}%</output></span>
              <input type="range" min="50" max="150" step="5" value={snapshot.microphoneSensitivity} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => commands.setMicrophoneSensitivity(Number(event.target.value))} aria-label="Sensibilidade do microfone" />
              <small>Menor reduz ruídos; maior capta vozes mais baixas.</small>
            </label>
          </div>
          {microphoneProblem && <p role="alert" className="team-call-prejoin-alert is-error">{microphoneProblem}</p>}
        </section>
      </div>

      <div className="team-call-prejoin-status" aria-live="polite"><span className={entry.microphoneMode === "on" ? "is-ready" : ""}>{entry.microphoneMode === "on" ? <Mic size={15} /> : <MicOff size={15} />} Microfone {entry.microphoneMode === "on" ? "ligado" : entry.microphoneMode === "muted" ? "desligado" : "não solicitado"}</span><span className={entry.cameraEnabled ? "is-ready" : ""}>{entry.cameraEnabled ? <Camera size={15} /> : <CameraOff size={15} />} Câmera {entry.cameraEnabled ? "ligada" : "desligada"}</span></div>
      {snapshot.iceService && ["degraded", "unavailable"].includes(snapshot.iceService.status) && <p role="alert" className="team-call-prejoin-alert is-warning mx-6 mb-4">{snapshot.iceService.detail}</p>}
      {snapshot.failureNotice && <p role="alert" className="team-call-prejoin-alert is-error mx-6 mb-4">{snapshot.failureNotice}</p>}
      <footer className="team-call-prejoin-footer"><p>As configurações podem ser alteradas durante a reunião.</p><div><button type="button" onClick={commands.cancelEntry} className="team-call-prejoin-cancel">Cancelar</button><button type="button" onClick={() => void commands.enter()} className="team-call-primary-button team-call-prejoin-enter">Entrar agora</button></div></footer>
    </section>
  </div>;
}

function ScreenShareQualitySelector({ call, onClose }: { call: ReturnTypeOfTeamCall; onClose: () => void }) {
  return <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 grid w-[min(92vw,360px)] gap-4 rounded-2xl border p-4 text-left shadow-2xl" aria-label="Qualidade da transmissão de tela">
    <div className="flex items-center justify-between"><div><p className="text-sm font-black">Transmissão de tela</p><p className="text-xs text-[var(--text-secondary)]">Para transmitir som, marque Compartilhar áudio ao escolher a aba ou tela no navegador.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar qualidade"><X size={17} /></button></div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span>Qualidade da transmissão</span><select value={call.screenShareQuality} onChange={(event) => void call.selectScreenShareQuality(event.target.value as typeof call.screenShareQuality)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value="720p">HD · 720p</option><option value="1080p">Full HD · 1080p</option><option value="1440p">Quad HD · 1440p</option></select></label>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span>Taxa de quadros</span><select value={call.screenShareFps} onChange={(event) => void call.selectScreenShareFps(Number(event.target.value) as typeof call.screenShareFps)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value={15}>15 FPS · economiza internet</option><option value={30}>30 FPS · recomendado</option><option value={60}>60 FPS · movimento fluido</option></select></label>
    <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">A mudança é aplicada durante a transmissão. O navegador pode reduzir a resolução se a conexão não suportar.</p>
  </section>;
}

function DeviceSelector({ call, mirrorLocalVideo, onMirrorLocalVideo, onClose }: { call: ReturnTypeOfTeamCall; mirrorLocalVideo: boolean; onMirrorLocalVideo: (enabled: boolean) => void; onClose: () => void }) {
  return <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 grid w-[min(92vw,440px)] gap-3 rounded-2xl border p-4 text-left shadow-2xl" aria-label="Dispositivos da chamada">
    <div className="flex items-center justify-between"><div><p className="text-sm font-black">Dispositivos</p><p className="text-xs text-[var(--text-secondary)]">Troque câmera e áudio durante a chamada.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar dispositivos"><X size={17} /></button></div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Mic size={14} /> Dispositivo de entrada</span><select value={call.selectedMicrophoneId} onChange={(event) => void call.selectMicrophone(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value="">Padrão do sistema</option>{call.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
    <div className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Camera size={14} /> Câmera · {call.cameraPermission === "granted" ? "permitida" : call.cameraPermission === "requesting" ? "solicitando permissão" : call.cameraPermission === "denied" ? "bloqueada" : call.cameraPermission === "unavailable" ? "indisponível" : "permissão pendente"}</span><select value={call.selectedCameraId} disabled={call.cameraPermission !== "granted"} onChange={(event) => void call.selectCamera(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none disabled:cursor-not-allowed disabled:opacity-60"><option value="">Padrão do sistema</option>{call.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select>{call.cameraPermission !== "granted" ? <button type="button" disabled={call.cameraPermission === "requesting"} onClick={() => void call.requestCameraPermission().then((granted) => { if (granted) return call.refreshDevices(); return undefined; })} className="team-call-primary-button mt-1 flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-xs font-black text-white disabled:opacity-60"><Camera size={15} /> {call.cameraPermission === "requesting" ? "Solicitando acesso..." : "Permitir e listar câmeras"}</button> : <div className="mt-1 grid grid-cols-2 gap-2"><button type="button" onClick={() => void call.refreshDevices()} className="h-9 rounded-xl border border-[#2d3743] bg-[#11151a] px-3 text-xs font-black text-[#d8e8ff] hover:bg-[#1b2128]">Atualizar lista</button><button type="button" onClick={() => void call.toggleCamera()} className="team-call-primary-button h-9 rounded-xl px-3 text-xs font-black text-white">{call.cameraOff ? "Ativar câmera" : "Desativar câmera"}</button></div>}{call.cameraPermission === "granted" && call.devices.cameras.length === 0 && <small className="font-medium text-amber-500">Nenhuma câmera respondeu. Conecte uma câmera e atualize a lista.</small>}</div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Volume2 size={14} /> Dispositivo de saída</span><select value={call.selectedSpeakerId} disabled={!call.supportsSpeakerSelection} onChange={(event) => call.selectSpeaker(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none disabled:cursor-not-allowed disabled:opacity-55"><option value="">Padrão do sistema</option>{call.devices.speakers.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Saída", index)}</option>)}</select>{!call.supportsSpeakerSelection && <small className="font-medium text-amber-500">Neste navegador, a saída é escolhida nas configurações do sistema.</small>}</label>
    <div className="team-call-device-processing">
      <label><span><strong>Supressão de ruído</strong><small>Reduz sons contínuos.</small></span><input type="checkbox" checked={call.noiseSuppression} onChange={(event) => void call.setNoiseSuppression(event.target.checked)} aria-label="Supressão de ruído durante a chamada" /></label>
      <label><span><strong>Sensibilidade</strong><output>{call.microphoneSensitivity}%</output></span><input type="range" min="50" max="150" step="5" value={call.microphoneSensitivity} onChange={(event) => call.setMicrophoneSensitivity(Number(event.target.value))} aria-label="Sensibilidade do microfone durante a chamada" /></label>
      <label title={call.supportsBackgroundBlur ? "Embaçar somente o fundo da câmera" : "Indisponível neste navegador ou câmera"}><span><strong>Embaçar fundo</strong><small>{call.supportsBackgroundBlur ? "Processamento da câmera." : "Não compatível."}</small></span><input type="checkbox" checked={call.backgroundBlur} disabled={!call.supportsBackgroundBlur || call.cameraOff} onChange={(event) => void call.setBackgroundBlur(event.target.checked)} aria-label="Embaçar fundo durante a chamada" /></label>
      <label title="A transmissão não é alterada; esta opção muda apenas a sua prévia"><span><strong>Espelhar minha prévia</strong><small>{mirrorLocalVideo ? "Modo espelho para você." : "Exatamente como os outros veem."}</small></span><input type="checkbox" checked={mirrorLocalVideo} disabled={call.cameraOff} onChange={(event) => onMirrorLocalVideo(event.target.checked)} aria-label="Espelhar minha prévia durante a chamada" /></label>
    </div>
  </section>;
}

function WaitingStage({ title }: { title: string }) {
  return <div className="team-call-waiting grid place-items-center rounded-xl border text-center"><div><span className="team-call-primary-button mx-auto grid h-36 w-36 place-items-center rounded-full text-4xl font-black text-white shadow-2xl">{initials(title)}</span><p className="mt-8 text-2xl font-black">Sua sala está pronta</p><p className="mt-2 text-sm text-[#9ca7b5]">Aguardando os participantes. Você ouvirá um aviso quando alguém entrar.</p></div></div>;
}

function useAttachmentPreviewUrl(attachment: MeetingAttachment, token: string) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!attachment.mimeType.startsWith("image/")) return;
    let active = true;
    let objectUrl = "";
    void fetch(attachment.url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((response) => { if (!response.ok) throw new Error("preview"); return response.blob(); })
      .then((blob) => { if (!active) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
      .catch(() => undefined);
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment, token]);
  return url;
}

function MeetingAttachmentCard({ attachment, token, onDownload }: { attachment: MeetingAttachment; token: string; onDownload: () => void }) {
  const previewUrl = useAttachmentPreviewUrl(attachment, token);
  return <button type="button" onClick={onDownload} className="mt-2 block w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] text-left hover:bg-[var(--surface-hover)]">
    {previewUrl && <img src={previewUrl} alt={attachment.name} className="max-h-56 w-full bg-black object-contain" />}
    <span className="flex items-center gap-3 p-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--surface-hover)] text-[#4da3ff]"><Download size={17} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs">{attachment.name}</strong>{attachment.expiresAt && <small className="text-[10px] text-amber-500">Disponível por 24 horas</small>}</span></span>
  </button>;
}

function PendingAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <span className="relative flex max-w-48 shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] p-1.5 pr-8 text-xs">{preview && <img src={preview} alt="" className="h-10 w-10 rounded object-cover" />}<span className="truncate">{file.name}</span><button type="button" onClick={onRemove} className="absolute right-2 top-2" aria-label={`Remover ${file.name}`}><X size={13} /></button></span>;
}

function MeetingChat({ messages, currentUserId, attachmentToken, listRef, messageText, messageFiles, sending, onMessageText, onMessageFiles, onSubmit, onDownloadAttachment }: { messages: MeetingMessage[]; currentUserId: string; attachmentToken: string; listRef: RefObject<HTMLDivElement | null>; messageText: string; messageFiles: File[]; sending: boolean; onMessageText: (value: string) => void; onMessageFiles: (files: File[]) => void; onSubmit: (event: FormEvent) => void; onDownloadAttachment: (attachment: MeetingAttachment) => void }) {
  return <><div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{messages.length ? messages.map((message) => <article key={message.id} className={message.senderId === currentUserId ? "ml-8" : "mr-8"}><div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[#9ca7b5]"><strong className="truncate text-[#f4f6f8]">{message.senderName}</strong><time>{timeLabel(message.createdAt)}</time></div>{message.text && <p className={`team-call-chat-message rounded-xl px-3 py-2 text-sm leading-relaxed ${message.senderId === currentUserId ? "team-call-chat-message-mine" : "team-call-chat-message-other"}`}>{message.text}</p>}{message.attachments.map((attachment) => <MeetingAttachmentCard key={attachment.id} attachment={attachment} token={attachmentToken} onDownload={() => onDownloadAttachment(attachment)} />)}</article>) : <div className="grid h-full place-items-center text-center text-sm text-[#9ca7b5]"><p>Converse com os participantes desta reunião. Este histórico é temporário.</p></div>}</div><form onSubmit={onSubmit} className="border-t border-[var(--border)] p-4">{messageFiles.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{messageFiles.map((file, index) => <PendingAttachment key={`${file.name}-${file.size}-${index}`} file={file} onRemove={() => onMessageFiles(messageFiles.filter((_, itemIndex) => itemIndex !== index))} />)}</div>}<div className="team-call-chat-composer flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-2"><label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg text-[#4da3ff] hover:bg-[var(--surface-hover)]" aria-label="Anexar arquivos no chat da reunião"><Paperclip size={19} /><input type="file" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" className="hidden" onChange={(event) => { onMessageFiles([...messageFiles, ...Array.from(event.target.files || [])]); event.currentTarget.value = ""; }} /></label><textarea value={messageText} onChange={(event) => onMessageText(event.target.value)} rows={2} maxLength={2000} placeholder="Digite uma mensagem" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-[#f4f6f8] outline-none placeholder:text-[#9ca7b5]" /><button type="submit" disabled={(!messageText.trim() && !messageFiles.length) || sending} className="grid h-10 w-10 place-items-center rounded-lg text-[#4da3ff] hover:bg-[var(--surface-hover)] disabled:opacity-35" aria-label="Enviar mensagem"><Send size={19} /></button></div></form></>;
}

function PeoplePanel({ participantIds, currentUserId, memberById, raisedHands }: { participantIds: string[]; currentUserId: string; memberById: Map<string, MeetingMember>; raisedHands: Record<string, string> }) {
  const orderedIds = [...participantIds].sort((a, b) => {
    if (!!raisedHands[a] !== !!raisedHands[b]) return raisedHands[a] ? -1 : 1;
    return (raisedHands[a] || "").localeCompare(raisedHands[b] || "");
  });
  return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">{orderedIds.map((participantId) => { const participant = memberById.get(participantId); const name = participant?.nome || (participantId === currentUserId ? "Você" : `Participante ${participantId}`); return <div key={participantId} className="flex items-center gap-3 rounded-xl bg-[var(--surface-hover)] p-3"><span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-[var(--primary)] font-black text-white">{participant?.fotoUrl ? <img src={participant.fotoUrl} alt="" className="h-full w-full object-cover" /> : initials(name)}</span><span><strong className="block text-sm">{name}</strong><small className={raisedHands[participantId] ? "text-amber-400" : "text-emerald-500"}>{raisedHands[participantId] ? "✋ Mão levantada" : "Na reunião"}</small></span></div>; })}</div>;
}
