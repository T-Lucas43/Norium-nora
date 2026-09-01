import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../types/auth";
import { apiBaseUrl } from "../../utils/api";

const TEAM_CHAT_API = `${apiBaseUrl()}/api/team-chat`;

export type TeamThreadScope = "team" | "direct" | "subteam";

export type TeamCallThread = {
  scope: TeamThreadScope;
  title: string;
  recipientId?: string | null;
  subteamId?: string | null;
};

export type TeamCallSocketEvent = {
  type: string;
  callId?: string;
  scope?: TeamThreadScope;
  threadId?: string;
  recipientId?: string | null;
  subteamId?: string | null;
  fromUserId?: string;
  fromUserName?: string;
  mode?: "audio" | "video";
  signal?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  detail?: string;
  recordingId?: string;
  expiresAt?: string;
  emoji?: string;
  startedAt?: string;
};

type ActiveCall = {
  callId: string;
  mode: "audio" | "video";
  title: string;
  thread: TeamCallThread;
  hostUserId: string;
  startedAt: string;
};

type IncomingCall = ActiveCall & {
  fromUserId: string;
  fromUserName: string;
};

type CallDevices = {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
};

type CallSound = "connecting" | "joined" | "left" | "ended";
type ConnectionQuality = "offline" | "connecting" | "poor" | "fair" | "good";
type CameraPermission = "unknown" | "requesting" | "granted" | "denied" | "unavailable";

function playCallSound(sound: CallSound) {
  if (typeof window === "undefined" || !window.AudioContext) return;
  const notes: Record<CallSound, Array<[number, number, number]>> = {
    connecting: [[440, 0, 0.12], [540, 0.18, 0.12]],
    joined: [[520, 0, 0.1], [660, 0.12, 0.1], [820, 0.24, 0.16]],
    left: [[520, 0, 0.12], [390, 0.16, 0.18]],
    ended: [[480, 0, 0.12], [360, 0.15, 0.14], [250, 0.32, 0.2]],
  };
  try {
    const context = new AudioContext();
    const baseTime = context.currentTime + 0.01;
    for (const [frequency, offset, duration] of notes[sound]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, baseTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.075, baseTime + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, baseTime + offset + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(baseTime + offset);
      oscillator.stop(baseTime + offset + duration + 0.02);
    }
    window.setTimeout(() => { void context.close(); }, 900);
  } catch {
    // Sons sao um reforco de UX e nunca devem interromper a chamada.
  }
}

function configuredIceServers(): RTCIceServer[] {
  const raw = (import.meta.env.VITE_TEAM_CALL_ICE_SERVERS as string | undefined)?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as RTCIceServer[];
    } catch {
      // Uma configuracao invalida nao deve impedir chamadas na mesma rede.
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function callId() {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

function mediaAccessError(error: unknown, device: "camera" | "microfone" | "tela") {
  const name = error instanceof DOMException ? error.name : "";
  const target = device === "camera" ? "a camera" : device === "tela" ? "a tela" : "o microfone";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `Permita o acesso ${target} nas configurações do navegador.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return `Nenhum dispositivo de ${device} disponível foi encontrado.`;
  }
  if (name === "NotReadableError") {
    return `O dispositivo de ${device} esta sendo usado por outro aplicativo.`;
  }
  return error instanceof Error ? error.message : `Nao foi possivel acessar ${target}.`;
}

export function useTeamCall({
  session,
  thread,
  sendSocketEvent,
}: {
  session: AuthSession;
  thread: TeamCallThread;
  sendSocketEvent: (payload: Record<string, unknown>) => boolean;
}) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Array<{ userId: string; stream: MediaStream }>>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(true);
  const [cameraPermission, setCameraPermission] = useState<CameraPermission>("unknown");
  const [sharingScreen, setSharingScreen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remoteScreenSharingIds, setRemoteScreenSharingIds] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [callElapsedSeconds, setCallElapsedSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(navigator.onLine ? "connecting" : "offline");
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; userName: string }>>([]);
  const [devices, setDevices] = useState<CallDevices>({ microphones: [], cameras: [], speakers: [] });
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const activeRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const videoSendersRef = useRef(new Map<string, RTCRtpSender>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const remoteStreamByUserRef = useRef(new Map<string, MediaStream>());
  const screenStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Array<{ userId: string; stream: MediaStream }>>([]);
  const connectingSoundTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIdRef = useRef("");
  const recordingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingErrorRef = useRef<Error | null>(null);
  const recordingCleanupRef = useRef<(() => void) | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const callTimerRef = useRef<number | null>(null);
  const recordingStopPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const resolveRecordingStopRef = useRef<(() => void) | null>(null);
  const reactionTimersRef = useRef<number[]>([]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  useEffect(() => {
    if (callTimerRef.current !== null) window.clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    if (!active) {
      setCallElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.parse(active.startedAt);
    const updateElapsed = () => setCallElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    callTimerRef.current = window.setInterval(updateElapsed, 1000);
    return () => {
      if (callTimerRef.current !== null) window.clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    remoteStreamsRef.current = remoteStreams;
  }, [remoteStreams]);

  const showReaction = useCallback((emoji: string, userName: string) => {
    const id = crypto.randomUUID();
    setReactions((current) => [...current.slice(-7), { id, emoji, userName }]);
    reactionTimersRef.current.push(window.setTimeout(() => {
      setReactions((current) => current.filter((reaction) => reaction.id !== id));
    }, 4200));
  }, []);

  const stopConnectingSound = useCallback(() => {
    if (connectingSoundTimerRef.current !== null) window.clearInterval(connectingSoundTimerRef.current);
    connectingSoundTimerRef.current = null;
  }, []);

  const startConnectingSound = useCallback(() => {
    stopConnectingSound();
    playCallSound("connecting");
    connectingSoundTimerRef.current = window.setInterval(() => playCallSound("connecting"), 1500);
  }, [stopConnectingSound]);

  const callPayload = useCallback((call: ActiveCall) => ({
    callId: call.callId,
    mode: call.mode,
    scope: call.thread.scope,
    recipientId: call.thread.recipientId || null,
    subteamId: call.thread.subteamId || null,
  }), []);

  const closePeer = useCallback((userId: string) => {
    peersRef.current.get(userId)?.close();
    peersRef.current.delete(userId);
    videoSendersRef.current.delete(userId);
    pendingCandidatesRef.current.delete(userId);
    remoteStreamByUserRef.current.get(userId)?.getTracks().forEach((track) => {
      track.onended = null;
    });
    remoteStreamByUserRef.current.delete(userId);
    setRemoteStreams((current) => current.filter((item) => item.userId !== userId));
    setRemoteScreenSharingIds((current) => current.filter((item) => item !== userId));
  }, []);

  const stopMedia = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setSharingScreen(false);
  }, []);

  const finishCall = useCallback((notify: boolean, sound: CallSound | null = null) => {
    const call = activeRef.current;
    if (notify && call) sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    stopConnectingSound();
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    videoSendersRef.current.clear();
    pendingCandidatesRef.current.clear();
    remoteStreamByUserRef.current.forEach((stream) => stream.getTracks().forEach((track) => {
      track.onended = null;
    }));
    remoteStreamByUserRef.current.clear();
    setRemoteStreams([]);
    setRemoteScreenSharingIds([]);
    stopMedia();
    setIncoming(null);
    incomingRef.current = null;
    setActive(null);
    activeRef.current = null;
    setMuted(false);
    setCameraOff(true);
    setCallElapsedSeconds(0);
    if (callTimerRef.current !== null) window.clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    setRecording(false);
    setRecordingElapsedSeconds(0);
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    recordingCleanupRef.current?.();
    recordingCleanupRef.current = null;
    reactionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    reactionTimersRef.current = [];
    setReactions([]);
    setConnectionQuality(navigator.onLine ? "good" : "offline");
    if (sound) playCallSound(sound);
    setStatus("");
  }, [callPayload, sendSocketEvent, stopConnectingSound, stopMedia]);

  useEffect(() => () => finishCall(false), [finishCall]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const available = await navigator.mediaDevices.enumerateDevices();
    const nextDevices = {
      microphones: available.filter((device) => device.kind === "audioinput"),
      cameras: available.filter((device) => device.kind === "videoinput"),
      speakers: available.filter((device) => device.kind === "audiooutput"),
    };
    setDevices(nextDevices);
    // Uma selecao vazia deixa o navegador usar o dispositivo padrao real do
    // sistema. Forcar o primeiro ID enumerado pode escolher camera virtual,
    // desconectada ou indisponivel e impedir a ativacao do video.
    setSelectedMicrophoneId((current) => current && nextDevices.microphones.some((device) => device.deviceId === current) ? current : "");
    setSelectedCameraId((current) => current && nextDevices.cameras.some((device) => device.deviceId === current) ? current : "");
    setSelectedSpeakerId((current) => current && nextDevices.speakers.some((device) => device.deviceId === current) ? current : "");
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return undefined;
    const handleDeviceChange = () => { void refreshDevices(); };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshDevices]);

  useEffect(() => {
    const updateNetwork = () => setConnectionQuality(navigator.onLine ? (activeRef.current ? "connecting" : "good") : "offline");
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const measure = async () => {
      if (!navigator.onLine) {
        if (!cancelled) setConnectionQuality("offline");
        return;
      }
      const peers = Array.from(peersRef.current.values());
      if (!peers.length) {
        if (!cancelled) setConnectionQuality("connecting");
        return;
      }
      if (peers.some((peer) => ["failed", "disconnected", "closed"].includes(peer.connectionState))) {
        if (!cancelled) setConnectionQuality("poor");
        return;
      }
      let highestRoundTrip = 0;
      let lostPackets = 0;
      let receivedPackets = 0;
      await Promise.all(peers.map(async (peer) => {
        const report = await peer.getStats();
        report.forEach((entry) => {
          if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.currentRoundTripTime) {
            highestRoundTrip = Math.max(highestRoundTrip, Number(entry.currentRoundTripTime));
          }
          if (entry.type === "inbound-rtp") {
            lostPackets += Number(entry.packetsLost || 0);
            receivedPackets += Number(entry.packetsReceived || 0);
          }
        });
      })).catch(() => undefined);
      const lossPercentage = lostPackets + receivedPackets > 0 ? (lostPackets / (lostPackets + receivedPackets)) * 100 : 0;
      const nextQuality: ConnectionQuality = highestRoundTrip > 0.65 || lossPercentage > 8
        ? "poor"
        : highestRoundTrip > 0.3 || lossPercentage > 3
          ? "fair"
          : "good";
      if (!cancelled) setConnectionQuality(nextQuality);
    };
    void measure();
    const timer = window.setInterval(() => { void measure(); }, 3500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);

  const acquireMedia = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador nao permite acesso ao microfone.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: selectedMicrophoneId ? { deviceId: { exact: selectedMicrophoneId } } : true,
      video: false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    setCameraOff(true);
    await refreshDevices().catch(() => undefined);
    return stream;
  }, [refreshDevices, selectedMicrophoneId]);

  const requestCameraPermission = useCallback(async () => {
    if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
      setCameraPermission("unavailable");
      setStatus("A câmera exige uma conexão HTTPS segura e um navegador compatível.");
      return false;
    }
    setCameraPermission("requesting");
    setStatus("Solicitando permissão para usar a câmera...");
    try {
      const defaultVideoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
      let permissionStream: MediaStream;
      try {
        permissionStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
            ...defaultVideoConstraints,
          },
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (!selectedCameraId || (name !== "NotFoundError" && name !== "OverconstrainedError")) throw error;
        setSelectedCameraId("");
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: defaultVideoConstraints });
      }
      const cameraTrack = permissionStream.getVideoTracks()[0];
      if (!cameraTrack) throw new DOMException("Nenhuma câmera respondeu.", "NotFoundError");
      permissionStream.getTracks().forEach((track) => track.stop());
      setCameraPermission("granted");
      setCameraOff(true);
      setStatus("Permissão da câmera concedida. Ela permanece desligada até você ativá-la.");
      await refreshDevices().catch(() => undefined);
      return true;
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setCameraPermission(name === "NotFoundError" || name === "OverconstrainedError" ? "unavailable" : "denied");
      setStatus(`${mediaAccessError(error, "camera")} Clique no cadeado ao lado do endereço do site, escolha Câmera > Permitir e tente novamente.`);
      return false;
    }
  }, [refreshDevices, selectedCameraId]);

  const replaceInputDevice = useCallback(async (kind: "audio" | "video", deviceId: string) => {
    const currentStream = localStreamRef.current;
    if (!currentStream || !navigator.mediaDevices?.getUserMedia) return;
    if (kind === "video" && !currentStream.getVideoTracks().length) {
      setSelectedCameraId(deviceId);
      return;
    }
    setStatus(kind === "audio" ? "Trocando microfone..." : "Trocando camera...");
    try {
      const replacementStream = await navigator.mediaDevices.getUserMedia(kind === "audio"
        ? { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false }
        : { audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
      const replacementTrack = kind === "audio" ? replacementStream.getAudioTracks()[0] : replacementStream.getVideoTracks()[0];
      if (!replacementTrack) throw new Error("O dispositivo selecionado nao forneceu midia.");
      replacementTrack.enabled = kind === "audio" ? !muted : !cameraOff;

      // Durante a transmissao de tela, a nova camera fica preparada localmente
      // e passa a ser enviada quando o compartilhamento terminar.
      if (kind === "audio" || !screenStreamRef.current) {
        await Promise.all(Array.from(peersRef.current.entries()).map(async ([remoteUserId, peer]) => {
          const sender = kind === "video"
            ? videoSendersRef.current.get(remoteUserId)
            : peer.getSenders().find((item) => item.track?.kind === kind);
          if (sender) await sender.replaceTrack(replacementTrack);
        }));
      }

      currentStream.getTracks().filter((track) => track.kind === kind).forEach((track) => track.stop());
      const nextStream = new MediaStream([
        ...currentStream.getTracks().filter((track) => track.kind !== kind),
        replacementTrack,
      ]);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      if (kind === "audio") setSelectedMicrophoneId(deviceId);
      else {
        setSelectedCameraId(deviceId);
        setCameraOff(false);
      }
      replacementStream.getTracks().filter((track) => track !== replacementTrack).forEach((track) => track.stop());
      setStatus("Na chamada");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Nao foi possivel trocar o dispositivo.");
    }
  }, [cameraOff, muted]);

  const createMeetingRecordingStream = useCallback((mode: "audio" | "video") => {
    if (!window.AudioContext) throw new Error("O navegador nao oferece mixagem de audio para gravacao.");
    const output = new MediaStream();
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    const audioDestination = audioContext.createMediaStreamDestination();
    const connectedAudioTracks = new Set<string>();
    const audioSources: MediaStreamAudioSourceNode[] = [];
    const videos = new Map<string, HTMLVideoElement>();
    let animationFrame = 0;
    let audioSyncTimer = 0;
    let canvasStream: MediaStream | null = null;

    const currentSources = () => {
      const result: Array<{ id: string; label: string; stream: MediaStream }> = [];
      if (screenStreamRef.current?.getVideoTracks().length) {
        result.push({ id: "screen", label: "Tela compartilhada", stream: screenStreamRef.current });
      } else {
        for (const item of remoteStreamsRef.current) result.push({ id: item.userId, label: `Participante ${item.userId}`, stream: item.stream });
        if (localStreamRef.current) result.push({ id: "local", label: session.user.nome || "Voce", stream: localStreamRef.current });
      }
      return result;
    };

    const connectAvailableAudio = () => {
      const allStreams = [localStreamRef.current, ...remoteStreamsRef.current.map((item) => item.stream)].filter(Boolean) as MediaStream[];
      for (const stream of allStreams) {
        for (const track of stream.getAudioTracks()) {
          if (connectedAudioTracks.has(track.id)) continue;
          const source = audioContext.createMediaStreamSource(new MediaStream([track]));
          source.connect(audioDestination);
          audioSources.push(source);
          connectedAudioTracks.add(track.id);
        }
      }
    };
    connectAvailableAudio();
    audioDestination.stream.getAudioTracks().forEach((track) => output.addTrack(track));

    if (mode === "video") {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (!context || typeof canvas.captureStream !== "function") {
        void audioContext.close();
        throw new Error("Este navegador nao permite compor a gravacao de video.");
      }
      canvasStream = canvas.captureStream(24);
      canvasStream.getVideoTracks().forEach((track) => output.addTrack(track));

      const draw = () => {
        connectAvailableAudio();
        const sources = currentSources();
        context.fillStyle = "#090b0e";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, sources.length))));
        const rows = Math.max(1, Math.ceil(Math.max(1, sources.length) / columns));
        const cellWidth = canvas.width / columns;
        const cellHeight = canvas.height / rows;
        sources.forEach((source, index) => {
          let video = videos.get(source.id);
          if (!video || video.srcObject !== source.stream) {
            video?.pause();
            video = document.createElement("video");
            video.srcObject = source.stream;
            video.muted = true;
            video.playsInline = true;
            void video.play().catch(() => undefined);
            videos.set(source.id, video);
          }
          const x = (index % columns) * cellWidth;
          const y = Math.floor(index / columns) * cellHeight;
          if (video.readyState >= 2) context.drawImage(video, x, y, cellWidth, cellHeight);
          context.fillStyle = "rgba(0,0,0,.58)";
          context.fillRect(x + 18, y + cellHeight - 54, Math.min(cellWidth - 36, 320), 34);
          context.fillStyle = "#fff";
          context.font = "600 18px Arial";
          context.fillText(source.label, x + 30, y + cellHeight - 31);
        });
        if (!sources.length) {
          context.fillStyle = "#fff";
          context.font = "700 30px Arial";
          context.textAlign = "center";
          context.fillText("Aguardando participantes...", canvas.width / 2, canvas.height / 2);
          context.textAlign = "start";
        }
        animationFrame = window.requestAnimationFrame(draw);
      };
      draw();
    } else {
      audioSyncTimer = window.setInterval(connectAvailableAudio, 1000);
    }

    return {
      stream: output,
      cleanup: () => {
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        if (audioSyncTimer) window.clearInterval(audioSyncTimer);
        videos.forEach((video) => { video.pause(); video.srcObject = null; });
        canvasStream?.getTracks().forEach((track) => track.stop());
        audioDestination.stream.getTracks().forEach((track) => track.stop());
        audioSources.forEach((source) => source.disconnect());
        void audioContext.close();
      },
    };
  }, [session.user.nome]);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    await recordingStopPromiseRef.current;
  }, []);

  const startRecording = useCallback(async () => {
    const call = activeRef.current;
    if (!call || recording || typeof MediaRecorder === "undefined") {
      if (typeof MediaRecorder === "undefined") setStatus("Este navegador nao permite gravar reunioes.");
      return;
    }
    const recordingMode: "audio" | "video" = screenStreamRef.current?.getVideoTracks().length
      || localStreamRef.current?.getVideoTracks().length
      || remoteStreamsRef.current.some((item) => item.stream.getVideoTracks().length)
      ? "video"
      : "audio";
    const candidates = recordingMode === "video"
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = candidates.find((candidate) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(candidate)) || "";
    let cleanup: (() => void) | null = null;
    let recordingId = "";
    try {
      setStatus("Preparando gravacao...");
      const composition = createMeetingRecordingStream(recordingMode);
      cleanup = composition.cleanup;
      const startResponse = await fetch(`${TEAM_CHAT_API}/recordings/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          callId: call.callId,
          scope: call.thread.scope,
          recipientId: call.thread.recipientId || null,
          subteamId: call.thread.subteamId || null,
          mimeType: mimeType || (recordingMode === "video" ? "video/webm" : "audio/webm"),
        }),
      });
      const startData = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(startData?.detail || "Nao foi possivel iniciar a gravacao.");
      recordingId = String(startData.recording?.id || "");
      if (!recordingId) throw new Error("O servidor nao confirmou a gravacao.");

      const recorder = new MediaRecorder(composition.stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recordingIdRef.current = recordingId;
      recordingCleanupRef.current = cleanup;
      recordingQueueRef.current = Promise.resolve();
      recordingErrorRef.current = null;
      recordingStopPromiseRef.current = new Promise<void>((resolve) => { resolveRecordingStopRef.current = resolve; });
      recorder.ondataavailable = (event) => {
        if (!event.data.size || recordingErrorRef.current) return;
        recordingQueueRef.current = recordingQueueRef.current.then(async () => {
          const response = await fetch(`${TEAM_CHAT_API}/recordings/${recordingId}/chunks`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/octet-stream" },
            body: event.data,
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.detail || "Falha ao enviar um trecho da gravacao.");
          }
        }).catch((error) => { recordingErrorRef.current = error instanceof Error ? error : new Error("Falha ao enviar a gravacao."); });
      };
      recorder.onstop = () => {
        void (async () => {
          await recordingQueueRef.current;
          try {
            if (recordingErrorRef.current) throw recordingErrorRef.current;
            const response = await fetch(`${TEAM_CHAT_API}/recordings/${recordingId}/complete`, {
              method: "POST",
              headers: { Authorization: `Bearer ${session.token}` },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.detail || "Nao foi possivel finalizar a gravacao.");
            setStatus("Gravacao salva no chat por 24 horas.");
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Falha ao salvar a gravacao.");
            await fetch(`${TEAM_CHAT_API}/recordings/${recordingId}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
          } finally {
            recordingCleanupRef.current?.();
            recordingCleanupRef.current = null;
            mediaRecorderRef.current = null;
            recordingIdRef.current = "";
            setRecording(false);
            setRecordingElapsedSeconds(0);
            if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
            resolveRecordingStopRef.current?.();
            resolveRecordingStopRef.current = null;
          }
        })();
      };
      recorder.start(5000);
      setRecording(true);
      setRecordingElapsedSeconds(0);
      recordingTimerRef.current = window.setInterval(() => setRecordingElapsedSeconds((current) => current + 1), 1000);
      setStatus("Gravando reuniao");
    } catch (error) {
      cleanup?.();
      if (recordingId) await fetch(`${TEAM_CHAT_API}/recordings/${recordingId}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
      setStatus(error instanceof Error ? error.message : "Nao foi possivel iniciar a gravacao.");
    }
  }, [createMeetingRecordingStream, recording, session.token]);

  const negotiatePeer = useCallback(async (remoteUserId: string, peer: RTCPeerConnection) => {
    const call = activeRef.current;
    if (!call || peer.signalingState !== "stable") return;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendSocketEvent({
      type: "CALL_SIGNAL",
      ...callPayload(call),
      targetUserId: remoteUserId,
      signal: offer,
    });
  }, [callPayload, sendSocketEvent]);

  const attachVideoTrack = useCallback(async (track: MediaStreamTrack | null, sourceStream: MediaStream) => {
    await Promise.all(Array.from(peersRef.current.entries()).map(async ([remoteUserId, peer]) => {
      const existingSender = videoSendersRef.current.get(remoteUserId);
      if (existingSender) {
        await existingSender.replaceTrack(track);
        return;
      }
      if (!track) return;
      const sender = peer.addTrack(track, sourceStream);
      videoSendersRef.current.set(remoteUserId, sender);
      await negotiatePeer(remoteUserId, peer);
    }));
  }, [negotiatePeer]);

  const createPeer = useCallback(async (remoteUserId: string, createOffer: boolean) => {
    const call = activeRef.current;
    if (!call || remoteUserId === session.user.id) return null;
    let peer = peersRef.current.get(remoteUserId);
    if (!peer) {
      peer = new RTCPeerConnection({ iceServers: configuredIceServers() });
      peersRef.current.set(remoteUserId, peer);
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        peer?.addTrack(track, localStreamRef.current as MediaStream);
      });
      const outgoingVideoTrack = screenStreamRef.current?.getVideoTracks()[0]
        || localStreamRef.current?.getVideoTracks().find((track) => track.enabled);
      const outgoingVideoStream = screenStreamRef.current || localStreamRef.current;
      if (outgoingVideoTrack && outgoingVideoStream) {
        const sender = peer.addTrack(outgoingVideoTrack, outgoingVideoStream);
        videoSendersRef.current.set(remoteUserId, sender);
      } else {
        // Reserva o canal de video durante a negociacao inicial. Assim camera
        // e tela podem ser ativadas depois com replaceTrack, sem depender de
        // uma segunda negociacao WebRTC que pode colidir ou ser ignorada.
        const transceiver = peer.addTransceiver("video", { direction: "sendrecv" });
        videoSendersRef.current.set(remoteUserId, transceiver.sender);
      }
      peer.onicecandidate = (event) => {
        const current = activeRef.current;
        if (event.candidate && current) {
          sendSocketEvent({
            type: "CALL_SIGNAL",
            ...callPayload(current),
            targetUserId: remoteUserId,
            signal: event.candidate.toJSON(),
          });
        }
      };
      peer.ontrack = (event) => {
        const previous = remoteStreamByUserRef.current.get(remoteUserId);
        const previousTracks = previous?.getTracks() || [];
        const incomingTracks = [event.track, ...event.streams.flatMap((stream) => stream.getTracks())];
        const tracks = [...previousTracks];
        for (const track of incomingTracks) {
          if (!tracks.some((current) => current === track || (track.id && current.id === track.id))) tracks.push(track);
        }
        const stream = new MediaStream(tracks);
        remoteStreamByUserRef.current.set(remoteUserId, stream);
        event.track.onended = () => {
          const current = remoteStreamByUserRef.current.get(remoteUserId);
          if (!current) return;
          const remainingTracks = current.getTracks().filter((track) => track !== event.track && (!event.track.id || track.id !== event.track.id));
          if (!remainingTracks.length) {
            remoteStreamByUserRef.current.delete(remoteUserId);
            setRemoteStreams((items) => items.filter((item) => item.userId !== remoteUserId));
            return;
          }
          const nextStream = new MediaStream(remainingTracks);
          remoteStreamByUserRef.current.set(remoteUserId, nextStream);
          setRemoteStreams((items) => [
            ...items.filter((item) => item.userId !== remoteUserId),
            { userId: remoteUserId, stream: nextStream },
          ]);
        };
        setRemoteStreams((current) => [
          ...current.filter((item) => item.userId !== remoteUserId),
          { userId: remoteUserId, stream },
        ]);
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer?.connectionState || "")) closePeer(remoteUserId);
      };
    }
    if (createOffer) await negotiatePeer(remoteUserId, peer);
    return peer;
  }, [callPayload, closePeer, negotiatePeer, sendSocketEvent, session.user.id]);

  const startCall = useCallback(async (targetThread: TeamCallThread = thread) => {
    if (activeRef.current) return;
    setStatus("Solicitando permissões da câmera e do microfone...");
    try {
      await requestCameraPermission();
      await acquireMedia();
      const call: ActiveCall = {
        callId: callId(),
        mode: "audio",
        title: targetThread.title,
        thread: targetThread,
        hostUserId: session.user.id,
        startedAt: new Date().toISOString(),
      };
      activeRef.current = call;
      setActive(call);
      setStatus(targetThread.scope === "direct" ? "Chamando participante..." : "Chamando a equipe...");
      startConnectingSound();
      if (!sendSocketEvent({ type: "CALL_INVITE", ...callPayload(call) })) {
        throw new Error("A conexao em tempo real ainda nao esta pronta.");
      }
    } catch (error) {
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
    }
  }, [acquireMedia, callPayload, finishCall, requestCameraPermission, sendSocketEvent, session.user.id, startConnectingSound, thread]);

  const acceptIncoming = useCallback(async () => {
    if (!incoming) return;
    setStatus("Conectando dispositivos...");
    startConnectingSound();
    try {
      await requestCameraPermission();
      await acquireMedia();
      const call: ActiveCall = { ...incoming };
      activeRef.current = call;
      setActive(call);
      setIncoming(null);
      incomingRef.current = null;
      sendSocketEvent({ type: "CALL_ACCEPT", ...callPayload(call) });
      stopConnectingSound();
      playCallSound("joined");
      setStatus("Na chamada");
    } catch (error) {
      sendSocketEvent({ type: "CALL_REJECT", ...callPayload(incoming) });
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
    }
  }, [acquireMedia, callPayload, finishCall, incoming, requestCameraPermission, sendSocketEvent, startConnectingSound, stopConnectingSound]);

  const rejectIncoming = useCallback(() => {
    if (incoming) sendSocketEvent({ type: "CALL_REJECT", ...callPayload(incoming) });
    setIncoming(null);
    incomingRef.current = null;
    stopConnectingSound();
  }, [callPayload, incoming, sendSocketEvent, stopConnectingSound]);

  const handleSocketEvent = useCallback(async (event: TeamCallSocketEvent) => {
    if (!event.callId || !event.fromUserId || event.fromUserId === session.user.id) {
      if (event.type === "CALL_ERROR" && event.detail) setStatus(event.detail);
      return;
    }
    if (event.type === "CALL_INVITE") {
      if (incomingRef.current?.callId === event.callId || activeRef.current?.callId === event.callId) return;
      if (activeRef.current) {
        sendSocketEvent({
          type: "CALL_REJECT",
          callId: event.callId,
          mode: event.mode || "audio",
          scope: event.scope || "team",
          recipientId: event.recipientId || null,
          subteamId: event.subteamId || null,
        });
        return;
      }
      const nextIncoming: IncomingCall = {
        callId: event.callId,
        mode: "audio",
        title: event.scope === "team" ? "Time todo" : event.fromUserName || "Reuniao da equipe",
        fromUserId: event.fromUserId,
        fromUserName: event.fromUserName || "Membro",
        hostUserId: event.fromUserId,
        startedAt: event.startedAt || new Date().toISOString(),
        thread: {
          scope: event.scope || "team",
          title: event.scope === "team" ? "Time todo" : event.fromUserName || "Reuniao da equipe",
          recipientId: event.scope === "direct" ? event.fromUserId : event.recipientId || null,
          subteamId: event.subteamId || null,
        },
      };
      incomingRef.current = nextIncoming;
      setIncoming(nextIncoming);
      startConnectingSound();
      return;
    }
    const call = activeRef.current;
    if (!call || call.callId !== event.callId) return;
    if (event.type === "CALL_REACTION" && event.emoji) {
      showReaction(event.emoji, event.fromUserName || "Participante");
      return;
    }
    if (event.type === "CALL_SCREEN_STARTED") {
      setRemoteScreenSharingIds((current) => current.includes(event.fromUserId as string) ? current : [...current, event.fromUserId as string]);
      setStatus(`${event.fromUserName || "Um participante"} está compartilhando a tela.`);
      return;
    }
    if (event.type === "CALL_SCREEN_STOPPED") {
      setRemoteScreenSharingIds((current) => current.filter((item) => item !== event.fromUserId));
      setStatus(`${event.fromUserName || "Um participante"} encerrou o compartilhamento.`);
      return;
    }
    if (event.type === "CALL_ACCEPT") {
      stopConnectingSound();
      playCallSound("joined");
      setStatus("Na chamada");
      await createPeer(event.fromUserId, true);
      return;
    }
    if (event.type === "CALL_SIGNAL" && event.signal) {
      const peer = await createPeer(event.fromUserId, false);
      if (!peer) return;
      if ("type" in event.signal && event.signal.type) {
        await peer.setRemoteDescription(event.signal as RTCSessionDescriptionInit);
        const pendingCandidates = pendingCandidatesRef.current.get(event.fromUserId) || [];
        for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate);
        pendingCandidatesRef.current.delete(event.fromUserId);
        if (event.signal.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSocketEvent({
            type: "CALL_SIGNAL",
            ...callPayload(call),
            targetUserId: event.fromUserId,
            signal: answer,
          });
        }
      } else if ("candidate" in event.signal) {
        if (peer.remoteDescription) {
          await peer.addIceCandidate(event.signal as RTCIceCandidateInit);
        } else {
          pendingCandidatesRef.current.set(event.fromUserId, [
            ...(pendingCandidatesRef.current.get(event.fromUserId) || []),
            event.signal as RTCIceCandidateInit,
          ]);
        }
      }
      return;
    }
    if (event.type === "CALL_REJECT") {
      if (call.thread.scope === "direct") stopConnectingSound();
      setStatus(`${event.fromUserName || "Um participante"} recusou a chamada.`);
      return;
    }
    if (event.type === "CALL_LEAVE") {
      closePeer(event.fromUserId);
      playCallSound("left");
      setStatus(`${event.fromUserName || "Um participante"} saiu da reuniao.`);
      return;
    }
    if (event.type === "CALL_RECORDING_STARTED") {
      setRecording(true);
      setRecordingElapsedSeconds(0);
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = window.setInterval(() => setRecordingElapsedSeconds((current) => current + 1), 1000);
      setStatus(`${event.fromUserName || "O organizador"} iniciou a gravacao.`);
      return;
    }
    if (event.type === "CALL_RECORDING_AVAILABLE") {
      setRecording(false);
      setRecordingElapsedSeconds(0);
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
      setStatus("Gravacao disponivel no chat por 24 horas.");
      return;
    }
    if (event.type === "CALL_END") {
      await stopRecording();
      finishCall(false, "ended");
    }
  }, [callPayload, closePeer, createPeer, finishCall, sendSocketEvent, session.user.id, showReaction, startConnectingSound, stopConnectingSound, stopRecording]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    const currentStream = localStreamRef.current;
    if (!currentStream || !navigator.mediaDevices?.getUserMedia) {
      setStatus("Este navegador nao permite acessar a camera.");
      return;
    }
    if (cameraPermission !== "granted" && !(await requestCameraPermission())) return;
    const currentTrack = currentStream.getVideoTracks()[0];
    if (currentTrack && currentTrack.readyState !== "ended") {
      const enabling = !currentTrack.enabled;
      currentTrack.enabled = enabling;
      if (!screenStreamRef.current) await attachVideoTrack(enabling ? currentTrack : null, currentStream);
      setCameraOff(!enabling);
      setStatus(enabling ? "Câmera ativada e sendo transmitida" : "Câmera desativada");
      return;
    }
    if (currentTrack) {
      currentTrack.stop();
      const withoutEndedTrack = new MediaStream(currentStream.getTracks().filter((track) => track !== currentTrack));
      localStreamRef.current = withoutEndedTrack;
      setLocalStream(withoutEndedTrack);
    }

    setStatus("Ativando camera...");
    try {
      const videoConstraints: MediaTrackConstraints = {
        ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
      let cameraStream: MediaStream;
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      } catch (error) {
        if (!selectedCameraId || !(error instanceof DOMException) || ["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
        setSelectedCameraId("");
        cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      }
      const cameraTrack = cameraStream.getVideoTracks()[0];
      if (!cameraTrack) throw new Error("A camera nao forneceu video.");
      cameraTrack.enabled = true;
      const baseStream = localStreamRef.current || currentStream;
      const nextStream = new MediaStream([...baseStream.getAudioTracks(), cameraTrack]);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      if (!screenStreamRef.current) await attachVideoTrack(cameraTrack, nextStream);
      setCameraOff(false);
      setCameraPermission("granted");
      setStatus("Câmera ativada e sendo transmitida");
      cameraTrack.onended = () => {
        if (localStreamRef.current?.getVideoTracks()[0] !== cameraTrack) return;
        setCameraOff(true);
        setStatus("A câmera foi desconectada. Escolha outro dispositivo e tente novamente.");
        if (!screenStreamRef.current) void attachVideoTrack(null, localStreamRef.current || nextStream);
      };
      await refreshDevices().catch(() => undefined);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setCameraPermission(["NotAllowedError", "SecurityError"].includes(name) ? "denied" : "unavailable");
      setCameraOff(true);
      setStatus(`${mediaAccessError(error, "camera")} Abra Dispositivos para escolher outra câmera.`);
    }
  }, [attachVideoTrack, cameraPermission, refreshDevices, requestCameraPermission, selectedCameraId]);

  const stopScreenShare = useCallback(async () => {
    const activeScreen = screenStreamRef.current;
    screenStreamRef.current = null;
    setScreenStream(null);
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
    await attachVideoTrack(cameraTrack?.enabled ? cameraTrack : null, localStreamRef.current || activeScreen || new MediaStream());
    activeScreen?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    setSharingScreen(false);
    const call = activeRef.current;
    if (call) sendSocketEvent({ type: "CALL_SCREEN_STOPPED", ...callPayload(call) });
    setStatus("Transmissão de tela encerrada");
  }, [attachVideoTrack, callPayload, sendSocketEvent]);

  const toggleScreenShare = useCallback(async () => {
    if (sharingScreen) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("Compartilhamento de tela indisponivel neste navegador.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) throw new Error("A tela selecionada nao forneceu video.");
      screenTrack.contentHint = "detail";
      screenStreamRef.current = stream;
      setScreenStream(stream);
      await attachVideoTrack(screenTrack, stream);
      screenTrack.onended = () => { void stopScreenShare(); };
      setSharingScreen(true);
      const call = activeRef.current;
      if (call) sendSocketEvent({ type: "CALL_SCREEN_STARTED", ...callPayload(call) });
      setStatus("Sua tela está visível para os participantes");
    } catch (error) {
      setStatus(mediaAccessError(error, "tela"));
    }
  }, [attachVideoTrack, callPayload, sendSocketEvent, sharingScreen, stopScreenShare]);

  const endCall = useCallback(async () => {
    await stopRecording();
    finishCall(true, "ended");
  }, [finishCall, stopRecording]);

  const leaveCall = useCallback(async () => {
    const call = activeRef.current;
    await stopRecording();
    if (call) sendSocketEvent({ type: "CALL_LEAVE", ...callPayload(call) });
    finishCall(false, "left");
  }, [callPayload, finishCall, sendSocketEvent, stopRecording]);

  const sendReaction = useCallback((emoji: string) => {
    const call = activeRef.current;
    if (!call || !["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].includes(emoji)) return;
    showReaction(emoji, session.user.nome || "Voce");
    sendSocketEvent({ type: "CALL_REACTION", ...callPayload(call), emoji });
  }, [callPayload, sendSocketEvent, session.user.nome, showReaction]);

  return {
    incoming,
    active,
    localStream,
    remoteStreams,
    muted,
    cameraOff,
    cameraPermission,
    sharingScreen,
    screenStream,
    remoteScreenSharingIds,
    callElapsedSeconds,
    recording,
    recordingElapsedSeconds,
    connectionQuality,
    reactions,
    status,
    startCall,
    acceptIncoming,
    rejectIncoming,
    endCall,
    leaveCall,
    isHost: active?.hostUserId === session.user.id,
    startRecording,
    stopRecording,
    sendReaction,
    toggleMute,
    toggleCamera,
    requestCameraPermission,
    toggleScreenShare,
    handleSocketEvent,
    devices,
    selectedMicrophoneId,
    selectedCameraId,
    selectedSpeakerId,
    supportsSpeakerSelection: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
    selectMicrophone: (deviceId: string) => replaceInputDevice("audio", deviceId),
    selectCamera: (deviceId: string) => replaceInputDevice("video", deviceId),
    selectSpeaker: setSelectedSpeakerId,
    refreshDevices,
  };
}
