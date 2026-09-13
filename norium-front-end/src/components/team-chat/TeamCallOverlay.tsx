import "./teamCall.css";
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, Camera, CameraOff, Circle, Clock3, Download, Hand, Maximize2, Minimize2, MessageSquareText, Mic, MicOff, MonitorUp, Paperclip, PhoneOff, Pin, PinOff, Send, Settings2, SlidersHorizontal, SmilePlus, Users, Video, Volume2, VolumeX, Wifi, WifiOff, X } from "lucide-react";
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
  onDownloadAttachment: (attachment: MeetingAttachment) => void;
};

function StreamVideo({ stream, muted = false, label, sinkId = "", fit = "cover" }: { stream: MediaStream; muted?: boolean; label: string; sinkId?: string; fit?: "cover" | "contain" }) {
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
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={`h-full w-full bg-black ${fit === "contain" ? "object-contain" : "object-cover"}`} />;
}

function RemoteParticipantMedia({ stream, participantName, sharing, videoEnabled }: { stream: MediaStream; participantName: string; sharing: boolean; videoEnabled: boolean }) {
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
    {(!videoEnabled || !videoActive) && <div className="absolute inset-0 grid place-items-center bg-[#050709] p-3 text-center"><div><span className="team-call-primary-button mx-auto grid h-16 w-16 place-items-center rounded-full text-xl font-black text-white">{initials(participantName)}</span><p className="mt-3 text-sm font-black">{sharing ? "Recebendo a transmissão de tela..." : `${participantName} está sem câmera`}</p></div></div>}
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

export default function TeamCallOverlay({ snapshot, commands, members, currentUserId, onDownloadAttachment }: TeamCallOverlayProps) {
  const call = callSessionView(snapshot, commands);
  const beforeStudioEndRef = useRef<(() => Promise<boolean>) | null>(null);
  const endingRef = useRef(false);
  const finishCall = async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    try {
      if (call.isHost && beforeStudioEndRef.current) {
        setMinimized(false);
        if (!(await beforeStudioEndRef.current())) return;
      }
      await (call.isHost ? call.endCall() : call.leaveCall());
    } finally { endingRef.current = false; }
  };
  const messages = snapshot.conversation?.messages || [];
  const raisedHands = call.raisedHands || {};
  const [minimized, setMinimized] = useState(false);
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
  const [audioSettings, setAudioSettings] = useState<Record<string, { volume: number; muted: boolean }>>({});
  const [pinned, setPinned] = useState<{ userId: string; type: "member" | "screen" } | null>(null);
  const incomingDialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setAudioSettings({}); setPinned(null); setMinimized(false); setMessageText(""); setMessageFiles([]); setMessageError("");
    setStudioOpen(false); setChatOpen(false); setPeopleOpen(false); setQualityOpen(false); setDevicesOpen(false); setReactionsOpen(false);
  }, [call.active?.callId]);
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
    return createPortal(<CallPrejoin snapshot={snapshot} commands={commands} />, document.body);
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
  const updateAudio = (userId: string, patch: Partial<{ volume: number; muted: boolean }>) =>
    setAudioSettings((current) => ({ ...current, [userId]: { ...(current[userId] || { volume: 100, muted: false }), ...patch } }));
  const togglePin = (userId: string, type: "member" | "screen") =>
    setPinned((current) => current?.userId === userId && current.type === type ? null : { userId, type });
  const participantIds = Array.from(new Set([
    ...(snapshot.conversation?.participantIds || [currentUserId]),
    ...streams.map((item) => item.userId),
  ]));
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
      <button type="button" onClick={() => setMinimized(false)} className="team-call-top-control" aria-label="Restaurar chamada"><Maximize2 size={18} /><span>Restaurar</span></button>
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
        <main className={`team-call-stage relative grid min-h-0 min-w-0 flex-1 gap-3 overflow-auto p-3 ${pinned && streams.length > 1 ? "team-call-stage-pinned" : streams.length > 1 ? "md:grid-cols-2" : ""}`}>
          {call.recording && <div role="status" aria-live="polite" className="team-call-recording-badge absolute left-5 top-5 z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black text-rose-300"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /><span>REC {durationLabel(call.recordingElapsedSeconds)}</span><span className="font-semibold text-rose-100">Todos foram avisados</span>{call.isHost && call.recordingUploadState !== "idle" && <span className="font-semibold text-rose-100">{call.recordingUploadState === "retrying" ? "Tentando envio novamente" : call.recordingUploadState === "finalizing" ? "Finalizando" : `Upload ${call.recordingUploadProgress}% · ${bytesLabel(call.recordingUploadedBytes)} enviados${call.recordingPendingBytes ? ` · ${bytesLabel(call.recordingPendingBytes)} pendentes` : ""}`}</span>}</div>}
          {streams.length ? streams.map((item) => {
            const sharing = call.remoteScreenSharingIds.includes(item.userId);
            const participantName = memberById.get(item.userId)?.nome || "Participante";
            const settings = audioSettings[item.userId] || { volume: 100, muted: false };
            const isPinned = pinned?.userId === item.userId;
            return <section key={item.userId} data-participant={item.userId} data-pinned={isPinned || undefined} style={isPinned && streams.length > 1 ? { gridRow: `1 / span ${streams.length - 1}` } : undefined} className={`team-call-remote-tile relative flex min-h-56 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] ${sharing ? "team-call-remote-screen" : ""} ${isPinned ? "team-call-pinned-tile" : ""}`}>
              <ParticipantAudio stream={item.stream} name={participantName} volume={settings.volume} muted={settings.muted} sinkId={call.selectedSpeakerId} />
              <div className="relative min-h-36 flex-1 overflow-hidden"><RemoteParticipantMedia stream={item.stream} participantName={participantName} sharing={sharing} videoEnabled={sharing || call.remoteCameraEnabled?.[item.userId] === true} />{sharing && <span className="team-call-screen-label absolute left-3 top-3 rounded-lg px-3 py-1.5 text-xs font-black"><MonitorUp size={14} /> Tela de {participantName}</span>}</div>
              <div className="team-call-participant-controls flex flex-wrap items-center gap-2 border-t p-2">
                <strong className="mr-auto max-w-36 truncate text-xs">{participantName}</strong>
                <button type="button" aria-label={`${settings.muted ? "Ouvir" : "Silenciar"} ${participantName} para mim`} aria-pressed={settings.muted} onClick={() => updateAudio(item.userId, { muted: !settings.muted })} className="rounded-lg p-2 hover:bg-white/10">{settings.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
                <label className="flex items-center gap-2 text-xs"><span className="sr-only">Volume de {participantName}</span><input aria-label={`Volume de ${participantName}`} type="range" min="0" max="200" step="5" value={settings.volume} onChange={(event) => updateAudio(item.userId, { volume: Number(event.target.value) })} className="w-24 accent-blue-500" /><span className="w-9">{settings.volume}%</span></label>
                <button type="button" onClick={() => togglePin(item.userId, "member")} aria-pressed={isPinned && pinned?.type === "member"} aria-label={`${isPinned && pinned?.type === "member" ? "Desafixar" : "Fixar"} ${participantName}`} className="flex items-center gap-1 rounded-lg p-2 text-xs hover:bg-white/10">{isPinned && pinned?.type === "member" ? <PinOff size={15} /> : <Pin size={15} />} Membro</button>
                {sharing && <button type="button" onClick={() => togglePin(item.userId, "screen")} aria-pressed={isPinned && pinned?.type === "screen"} aria-label={`${isPinned && pinned?.type === "screen" ? "Desafixar" : "Fixar"} transmissão de ${participantName}`} className="flex items-center gap-1 rounded-lg p-2 text-xs hover:bg-white/10">{isPinned && pinned?.type === "screen" ? <PinOff size={15} /> : <Pin size={15} />} Transmissão</button>}
              </div>
            </section>;
          }) : <WaitingStage title={call.active.title} />}
          {(call.screenStream || (call.localStream && !call.cameraOff)) && <div className="team-call-local-previews pointer-events-none absolute bottom-28 right-5 z-20 flex flex-col items-end gap-2">
            {call.screenStream && <section className="team-call-local-preview overflow-hidden rounded-xl border shadow-2xl" aria-label="Prévia da sua tela compartilhada"><header className="flex items-center justify-between gap-3 px-3 py-2 text-xs font-black"><span className="flex items-center gap-2"><MonitorUp size={14} /> Você está compartilhando</span><span className="text-emerald-400">AO VIVO</span></header><div className="aspect-video bg-black"><StreamVideo stream={call.screenStream} muted fit="contain" label="Mini visualização da sua tela compartilhada" /></div></section>}
            {call.localStream && !call.cameraOff && <section className="team-call-camera-preview h-24 w-36 overflow-hidden rounded-xl border shadow-2xl md:h-28 md:w-44"><StreamVideo stream={call.localStream} muted label="Sua câmera" /></section>}
          </div>}
          <div className="pointer-events-none absolute bottom-8 left-6 z-20 flex items-end gap-3">{call.reactions.map((reaction) => <div key={reaction.id} className="team-call-reaction rounded-full bg-[#11151a] px-3 py-2 text-center shadow-xl"><span className="block text-3xl">{reaction.emoji}</span><small className="block max-w-24 truncate text-[10px] text-[#9ca7b5]">{reaction.userName}</small></div>)}</div>
        </main>

        {(chatOpen || peopleOpen) && <aside className="team-call-side-panel flex w-[min(92vw,390px)] shrink-0 flex-col border-l">
          <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4"><h3 className="font-black">{chatOpen ? "Chat da reunião" : "Pessoas"}</h3><button type="button" onClick={() => { setChatOpen(false); setPeopleOpen(false); }} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar painel"><X size={18} /></button></div>
          {chatOpen && <p className="border-b border-[var(--border)] px-4 py-2 text-xs text-[#9ca7b5]">Chat temporário: mensagens e anexos serão apagados ao encerrar esta reunião.</p>}
          {chatOpen && messageError && <p role="alert" className="px-4 py-2 text-xs text-rose-300">{messageError}</p>}
          {chatOpen ? <MeetingChat messages={messages} currentUserId={currentUserId} listRef={chatListRef} messageText={messageText} messageFiles={messageFiles} sending={sending} onMessageText={setMessageText} onMessageFiles={setMessageFiles} onSubmit={submitMessage} onDownloadAttachment={onDownloadAttachment} /> : <PeoplePanel participantIds={participantIds} currentUserId={currentUserId} memberById={memberById} raisedHands={raisedHands} />}
        </aside>}
      </div>
      <footer className="team-call-toolbar">
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Controles da reunião">
          <button type="button" onClick={() => setMinimized(true)} className="team-call-top-control" aria-label="Minimizar chamada"><Minimize2 size={19} /><span>Minimizar</span></button>
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
          <button type="button" onClick={() => togglePanel("devices")} className={`team-call-top-control ${devicesOpen ? "team-call-active" : ""}`} aria-label="Selecionar câmera e dispositivos de áudio"><Settings2 size={19} /><span>Dispositivos</span></button>
          <button type="button" onClick={() => void finishCall()} className="team-call-top-control team-call-danger ml-2" aria-label={call.isHost ? "Encerrar reunião" : "Sair da reunião"}><PhoneOff size={20} /><span>{call.isHost ? "Encerrar" : "Sair"}</span></button>
        </nav>
        {devicesOpen && <DeviceSelector call={call} onClose={() => setDevicesOpen(false)} />}
        {qualityOpen && <ScreenShareQualitySelector call={call} onClose={() => setQualityOpen(false)} />}
        {reactionsOpen && <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 flex gap-1 rounded-2xl border p-2 shadow-2xl" aria-label="Reações da reunião">{["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].map((emoji) => <button key={emoji} type="button" onClick={() => { call.sendReaction(emoji); setReactionsOpen(false); }} className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-[#1b2128]" aria-label={`Reagir com ${emoji}`}>{emoji}</button>)}</section>}
      </footer>
    </div></>, document.body,
  );
}

function CallPrejoin({ snapshot, commands }: { snapshot: CallSessionSnapshot; commands: CallSessionCommands }) {
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

  return <div className="team-call-incoming-backdrop fixed inset-0 z-[182] grid place-items-center p-4">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Preparar entrada" className="team-call-incoming-card w-full max-w-2xl rounded-2xl border p-6 shadow-2xl">
      <header><p className="team-call-accent-text text-xs font-bold uppercase tracking-[.18em]">Antes de entrar</p><h2 className="mt-2 text-2xl font-black">{entry.title}</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Escolha como você quer participar. Nenhuma câmera é solicitada enquanto ela permanecer desligada.</p></header>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <fieldset className="space-y-2"><legend className="text-sm font-black">Microfone</legend>
            {(["on", "muted", "listen-only"] as const).map((mode) => <label key={mode} className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--border)] p-3 text-sm"><input type="radio" name="call-entry-microphone" checked={entry.microphoneMode === mode} onChange={() => commands.setEntryMicrophoneMode(mode)} aria-label={mode === "on" ? "Entrar com microfone ligado" : mode === "muted" ? "Entrar com microfone desligado" : "Entrar somente para escutar"} /><span>{mode === "on" ? "Microfone ligado" : mode === "muted" ? "Microfone desligado" : "Somente escuta · sem solicitar microfone"}</span></label>)}
          </fieldset>
          <label className="grid gap-1.5 text-xs font-bold"><span>Microfone</span><select aria-label="Microfone para a chamada" value={snapshot.selectedMicrophoneId} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => void commands.selectMicrophone(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm"><option value="">Padrão do sistema</option>{snapshot.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
          {microphoneProblem && <p role="alert" className="rounded-xl bg-rose-500/15 p-3 text-xs font-bold text-rose-200">{microphoneProblem}</p>}
        </div>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 text-sm font-bold"><span>Entrar com câmera ligada</span><input type="checkbox" checked={entry.cameraEnabled} disabled={entry.microphoneMode === "listen-only"} onChange={(event) => commands.setEntryCameraEnabled(event.target.checked)} /></label>
          <label className="grid gap-1.5 text-xs font-bold"><span>Câmera</span><select aria-label="Câmera para a chamada" value={snapshot.selectedCameraId} disabled={!entry.cameraEnabled || entry.microphoneMode === "listen-only"} onChange={(event) => void commands.selectCamera(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm"><option value="">Padrão do sistema</option>{snapshot.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select></label>
          <button type="button" disabled={!entry.cameraEnabled || entry.microphoneMode === "listen-only"} onClick={() => void commands.setEntryPreviewEnabled(!entry.previewEnabled)} className="team-call-primary-button w-full rounded-xl px-4 py-2 text-sm font-black text-white">{entry.previewEnabled ? "Ocultar prévia" : "Mostrar prévia"}</button>
          {entry.previewEnabled && snapshot.previewStream ? <div className="aspect-video overflow-hidden rounded-xl bg-black"><StreamVideo stream={snapshot.previewStream} muted label="Prévia da câmera" /></div> : <div className="grid aspect-video place-items-center rounded-xl border border-dashed border-[var(--border)] text-center text-xs text-[var(--text-secondary)]">A prévia é opcional e só solicita a câmera quando você escolher mostrá-la.</div>}
          {cameraProblem && <p role="alert" className="rounded-xl bg-amber-500/15 p-3 text-xs font-bold text-amber-100">{cameraProblem}</p>}
        </div>
      </div>
      <div aria-live="polite" className="mt-4 text-sm text-[var(--text-secondary)]">Microfone: {entry.microphoneMode === "on" ? "ligado" : entry.microphoneMode === "muted" ? "desligado ao entrar" : "não solicitado"} · Câmera: {entry.cameraEnabled ? "ligada ao entrar" : "não solicitada"}</div>
      {snapshot.iceService && ["degraded", "unavailable"].includes(snapshot.iceService.status) && <p role="alert" className="mt-4 rounded-xl bg-amber-500/15 p-3 text-sm font-bold text-amber-100">{snapshot.iceService.detail}</p>}
      <footer className="mt-6 flex justify-end gap-3"><button type="button" onClick={commands.cancelEntry} className="rounded-xl px-4 py-2 text-sm font-bold hover:bg-white/10">Cancelar</button><button type="button" onClick={() => void commands.enter()} className="team-call-primary-button rounded-xl px-5 py-2.5 text-sm font-black text-white">Entrar na chamada</button></footer>
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

function DeviceSelector({ call, onClose }: { call: ReturnTypeOfTeamCall; onClose: () => void }) {
  return <section className="team-call-popover absolute right-3 top-[calc(100%+10px)] z-20 grid w-[min(92vw,440px)] gap-3 rounded-2xl border p-4 text-left shadow-2xl" aria-label="Dispositivos da chamada">
    <div className="flex items-center justify-between"><div><p className="text-sm font-black">Dispositivos</p><p className="text-xs text-[var(--text-secondary)]">Troque câmera e áudio durante a chamada.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-[var(--surface-hover)]" aria-label="Fechar dispositivos"><X size={17} /></button></div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Mic size={14} /> Dispositivo de entrada</span><select value={call.selectedMicrophoneId} onChange={(event) => void call.selectMicrophone(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none"><option value="">Padrão do sistema</option>{call.devices.microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Microfone", index)}</option>)}</select></label>
    <div className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Camera size={14} /> Câmera · {call.cameraPermission === "granted" ? "permitida" : call.cameraPermission === "requesting" ? "solicitando permissão" : call.cameraPermission === "denied" ? "bloqueada" : call.cameraPermission === "unavailable" ? "indisponível" : "permissão pendente"}</span><select value={call.selectedCameraId} disabled={call.cameraPermission !== "granted"} onChange={(event) => void call.selectCamera(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none disabled:cursor-not-allowed disabled:opacity-60"><option value="">Padrão do sistema</option>{call.devices.cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Câmera", index)}</option>)}</select>{call.cameraPermission !== "granted" ? <button type="button" disabled={call.cameraPermission === "requesting"} onClick={() => void call.requestCameraPermission().then((granted) => { if (granted) return call.refreshDevices(); return undefined; })} className="team-call-primary-button mt-1 flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-xs font-black text-white disabled:opacity-60"><Camera size={15} /> {call.cameraPermission === "requesting" ? "Solicitando acesso..." : "Permitir e listar câmeras"}</button> : <div className="mt-1 grid grid-cols-2 gap-2"><button type="button" onClick={() => void call.refreshDevices()} className="h-9 rounded-xl border border-[#2d3743] bg-[#11151a] px-3 text-xs font-black text-[#d8e8ff] hover:bg-[#1b2128]">Atualizar lista</button><button type="button" onClick={() => void call.toggleCamera()} className="team-call-primary-button h-9 rounded-xl px-3 text-xs font-black text-white">{call.cameraOff ? "Ativar câmera" : "Desativar câmera"}</button></div>}{call.cameraPermission === "granted" && call.devices.cameras.length === 0 && <small className="font-medium text-amber-500">Nenhuma câmera respondeu. Conecte uma câmera e atualize a lista.</small>}</div>
    <label className="grid gap-1.5 text-xs font-bold text-[var(--text-secondary)]"><span className="flex items-center gap-2"><Volume2 size={14} /> Dispositivo de saída</span><select value={call.selectedSpeakerId} disabled={!call.supportsSpeakerSelection} onChange={(event) => call.selectSpeaker(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--text)] outline-none disabled:cursor-not-allowed disabled:opacity-55"><option value="">Padrão do sistema</option>{call.devices.speakers.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, "Saída", index)}</option>)}</select>{!call.supportsSpeakerSelection && <small className="font-medium text-amber-500">Neste navegador, a saída é escolhida nas configurações do sistema.</small>}</label>
  </section>;
}

function WaitingStage({ title }: { title: string }) {
  return <div className="team-call-waiting grid place-items-center rounded-xl border text-center"><div><span className="team-call-primary-button mx-auto grid h-36 w-36 place-items-center rounded-full text-4xl font-black text-white shadow-2xl">{initials(title)}</span><p className="mt-8 text-2xl font-black">Sua sala está pronta</p><p className="mt-2 text-sm text-[#9ca7b5]">Aguardando os participantes. Você ouvirá um aviso quando alguém entrar.</p></div></div>;
}

function MeetingChat({ messages, currentUserId, listRef, messageText, messageFiles, sending, onMessageText, onMessageFiles, onSubmit, onDownloadAttachment }: { messages: MeetingMessage[]; currentUserId: string; listRef: RefObject<HTMLDivElement | null>; messageText: string; messageFiles: File[]; sending: boolean; onMessageText: (value: string) => void; onMessageFiles: (files: File[]) => void; onSubmit: (event: FormEvent) => void; onDownloadAttachment: (attachment: MeetingAttachment) => void }) {
  return <><div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{messages.length ? messages.map((message) => <article key={message.id} className={message.senderId === currentUserId ? "ml-8" : "mr-8"}><div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[#9ca7b5]"><strong className="truncate text-[#f4f6f8]">{message.senderName}</strong><time>{timeLabel(message.createdAt)}</time></div>{message.text && <p className={`team-call-chat-message rounded-xl px-3 py-2 text-sm leading-relaxed ${message.senderId === currentUserId ? "team-call-chat-message-mine" : "team-call-chat-message-other"}`}>{message.text}</p>}{message.attachments.map((attachment) => <button key={attachment.id} type="button" onClick={() => onDownloadAttachment(attachment)} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-left hover:bg-[var(--surface-hover)]"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--surface-hover)] text-[#4da3ff]"><Download size={17} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs">{attachment.name}</strong>{attachment.expiresAt && <small className="text-[10px] text-amber-500">Disponível por 24 horas</small>}</span></button>)}</article>) : <div className="grid h-full place-items-center text-center text-sm text-[#9ca7b5]"><p>Converse com os participantes desta reunião. Este histórico é temporário.</p></div>}</div><form onSubmit={onSubmit} className="border-t border-[var(--border)] p-4">{messageFiles.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{messageFiles.map((file, index) => <span key={`${file.name}-${file.size}-${index}`} className="flex max-w-48 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs"><span className="truncate">{file.name}</span><button type="button" onClick={() => onMessageFiles(messageFiles.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover ${file.name}`}><X size={13} /></button></span>)}</div>}<div className="team-call-chat-composer flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-2"><label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg text-[#4da3ff] hover:bg-[var(--surface-hover)]" aria-label="Anexar arquivos no chat da reunião"><Paperclip size={19} /><input type="file" multiple className="hidden" onChange={(event) => { onMessageFiles([...messageFiles, ...Array.from(event.target.files || [])]); event.currentTarget.value = ""; }} /></label><textarea value={messageText} onChange={(event) => onMessageText(event.target.value)} rows={2} maxLength={2000} placeholder="Digite uma mensagem" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-[#f4f6f8] outline-none placeholder:text-[#9ca7b5]" /><button type="submit" disabled={(!messageText.trim() && !messageFiles.length) || sending} className="grid h-10 w-10 place-items-center rounded-lg text-[#4da3ff] hover:bg-[var(--surface-hover)] disabled:opacity-35" aria-label="Enviar mensagem"><Send size={19} /></button></div></form></>;
}

function PeoplePanel({ participantIds, currentUserId, memberById, raisedHands }: { participantIds: string[]; currentUserId: string; memberById: Map<string, MeetingMember>; raisedHands: Record<string, string> }) {
  const orderedIds = [...participantIds].sort((a, b) => {
    if (!!raisedHands[a] !== !!raisedHands[b]) return raisedHands[a] ? -1 : 1;
    return (raisedHands[a] || "").localeCompare(raisedHands[b] || "");
  });
  return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">{orderedIds.map((participantId) => { const participant = memberById.get(participantId); const name = participant?.nome || (participantId === currentUserId ? "Você" : `Participante ${participantId}`); return <div key={participantId} className="flex items-center gap-3 rounded-xl bg-[var(--surface-hover)] p-3"><span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-[var(--primary)] font-black text-white">{participant?.fotoUrl ? <img src={participant.fotoUrl} alt="" className="h-full w-full object-cover" /> : initials(name)}</span><span><strong className="block text-sm">{name}</strong><small className={raisedHands[participantId] ? "text-amber-400" : "text-emerald-500"}>{raisedHands[participantId] ? "✋ Mão levantada" : "Na reunião"}</small></span></div>; })}</div>;
}
