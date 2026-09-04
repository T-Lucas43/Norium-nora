import { useCallback, useEffect, useRef, useState } from "react";
import "webrtc-adapter";
import type { AuthSession } from "../../types/auth";
import { apiBaseUrl } from "../../utils/api";
import { createMeetingRecording } from "./meetingRecording";
import { prepareChatAttachments } from "./chatAttachments";

const TEAM_CHAT_API = `${apiBaseUrl()}/api/team-chat`;
const RECORDING_MAX_RETRIES = 3;
const RECORDING_BACKPRESSURE_BYTES = 24 * 1024 * 1024;
const RECORDING_BACKPRESSURE_CHUNKS = 3;

export type RecordingUploadState = "idle" | "uploading" | "retrying" | "finalizing" | "failed";

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

export async function fetchRecordingWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  onRetry?: (attempt: number) => void,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECORDING_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || (response.status !== 408 && response.status < 500)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < RECORDING_MAX_RETRIES) {
      onRetry?.(attempt + 1);
      await wait(200 * (2 ** (attempt - 1)));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Falha ao enviar a gravacao.");
}

export function recordingNeedsBackpressure(pendingBytes: number, pendingChunks: number) {
  return pendingBytes >= RECORDING_BACKPRESSURE_BYTES
    || pendingChunks >= RECORDING_BACKPRESSURE_CHUNKS;
}

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
  calls?: TeamCallSocketEvent[];
  joinedUserIds?: string[];
  clientId?: string | null;
  requestedCallId?: string;
  event?: string;
  cameraEnabled?: boolean;
  screenSharing?: boolean;
  raisedHands?: Record<string, string>;
  handRevision?: number;
  message?: MeetingMessage;
  targetUserId?: string;
  reason?: string;
};

export type MeetingMessage = { id: string; senderId: string; senderName: string; text: string; createdAt: string;
  attachments: Array<{ id: string; name: string; mimeType: string; size: number; url: string }> };

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

function incomingCallFromEvent(event: TeamCallSocketEvent, currentUserId: string): IncomingCall | null {
  if (!event.callId || !event.fromUserId) return null;
  const scope = event.scope || "team";
  const title = scope === "team" ? "Time todo" : event.fromUserName || "Reuniao da equipe";
  return {
    callId: event.callId,
    mode: "audio",
    title,
    fromUserId: event.fromUserId,
    fromUserName: event.fromUserName || "Membro",
    hostUserId: event.fromUserId,
    startedAt: event.startedAt || new Date().toISOString(),
    thread: {
      scope,
      title,
      recipientId: scope === "direct" && event.fromUserId !== currentUserId ? event.fromUserId : event.recipientId || null,
      subteamId: event.subteamId || null,
    },
  };
}

type CallDevices = {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
};

export type CallMicrophoneMode = "on" | "muted" | "listen-only";
export type CallEntryOptions = {
  microphoneMode: CallMicrophoneMode;
  cameraEnabled: boolean;
};

const DEFAULT_ENTRY_OPTIONS: CallEntryOptions = {
  microphoneMode: "on",
  cameraEnabled: false,
};

type CallSound = "connecting" | "joined" | "left" | "ended" | "screen";
type ConnectionQuality = "offline" | "connecting" | "poor" | "fair" | "good";
type CameraPermission = "unknown" | "requesting" | "granted" | "denied" | "unavailable";
type PeerNegotiationState = {
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  revision: number;
};
export type ScreenShareQuality = "720p" | "1080p" | "1440p";
export type ScreenShareFps = 15 | 30 | 60;

const SCREEN_SHARE_PROFILES: Record<ScreenShareQuality, { width: number; height: number; maxBitrate: number }> = {
  "720p": { width: 1280, height: 720, maxBitrate: 2_500_000 },
  "1080p": { width: 1920, height: 1080, maxBitrate: 5_000_000 },
  "1440p": { width: 2560, height: 1440, maxBitrate: 8_000_000 },
};

function screenShareConstraints(quality: ScreenShareQuality, fps: ScreenShareFps): MediaTrackConstraints {
  const profile = SCREEN_SHARE_PROFILES[quality];
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: fps, max: fps },
  };
}

async function applyScreenShareSenderProfile(sender: RTCRtpSender, quality: ScreenShareQuality, fps: ScreenShareFps) {
  if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  const profile = SCREEN_SHARE_PROFILES[quality];
  parameters.encodings = parameters.encodings.map((encoding) => ({
    ...encoding,
    active: true,
    maxBitrate: Math.round(profile.maxBitrate * Math.max(0.65, fps / 30)),
    maxFramerate: fps,
  }));
  await sender.setParameters(parameters);
}

let callAudioContext: AudioContext | null = null;

async function prepareCallAudio() {
  if (typeof window === "undefined" || !window.AudioContext) return false;
  try {
    if (!callAudioContext || callAudioContext.state === "closed") callAudioContext = new AudioContext();
    if (callAudioContext.state !== "running") await callAudioContext.resume();
    return callAudioContext.state === "running";
  } catch {
    return false;
  }
}

function playCallSound(sound: CallSound) {
  const context = callAudioContext;
  if (!context || context.state !== "running") return false;
  const notes: Record<CallSound, Array<[number, number, number]>> = {
    connecting: [[440, 0, 0.12], [540, 0.18, 0.12]],
    joined: [[520, 0, 0.1], [660, 0.12, 0.1], [820, 0.24, 0.16]],
    left: [[520, 0, 0.12], [390, 0.16, 0.18]],
    ended: [[480, 0, 0.12], [360, 0.15, 0.14], [250, 0.32, 0.2]],
    screen: [[660, 0, 0.12], [990, 0.16, 0.22]],
  };
  try {
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
    return true;
  } catch {
    // Sons sao um reforco de UX e nunca devem interromper a chamada.
    return false;
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
  return [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
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

export function useTeamCallRuntime({
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
  const [availableCalls, setAvailableCalls] = useState<TeamCallSocketEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const availableCallsRef = useRef<TeamCallSocketEvent[]>([]);
  const busyRef = useRef(false);
  const mediaEpochRef = useRef(0);
  const confirmedCallIdRef = useRef("");
  const endedCallIdsRef = useRef(new Set<string>());
  const dismissedInviteIdsRef = useRef(new Set<string>());
  const clientIdRef = useRef(crypto.randomUUID());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Array<{ userId: string; stream: MediaStream }>>([]);
  const [muted, setMuted] = useState(false);
  const [listenOnly, setListenOnly] = useState(false);
  const [microphonePermission, setMicrophonePermission] = useState<CameraPermission>("unknown");
  const [cameraOff, setCameraOff] = useState(true);
  const [cameraPermission, setCameraPermission] = useState<CameraPermission>("unknown");
  const [sharingScreen, setSharingScreen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [remoteScreenSharingIds, setRemoteScreenSharingIds] = useState<string[]>([]);
  const [remoteCameraEnabled, setRemoteCameraEnabled] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState("");
  const [audioReady, setAudioReady] = useState(false);
  const [ringtoneAudible, setRingtoneAudible] = useState(false);
  const [callElapsedSeconds, setCallElapsedSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const [recordingUploadState, setRecordingUploadState] = useState<RecordingUploadState>("idle");
  const [recordingUploadedBytes, setRecordingUploadedBytes] = useState(0);
  const [recordingPendingBytes, setRecordingPendingBytes] = useState(0);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(navigator.onLine ? "connecting" : "offline");
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; userName: string }>>([]);
  const [raisedHands, setRaisedHands] = useState<Record<string, string>>({});
  const handRevisionRef = useRef(-1);
  const [meetingMessages, setMeetingMessages] = useState<MeetingMessage[]>([]);
  const announcedScreensRef = useRef(new Set<string>());
  const screenChangePendingRef = useRef(false);
  const [screenChangePending, setScreenChangePending] = useState(false);
  const remoteMediaRef = useRef({ screenIds: remoteScreenSharingIds, cameras: remoteCameraEnabled });
  remoteMediaRef.current = { screenIds: remoteScreenSharingIds, cameras: remoteCameraEnabled };
  const [devices, setDevices] = useState<CallDevices>({ microphones: [], cameras: [], speakers: [] });
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [screenShareQuality, setScreenShareQuality] = useState<ScreenShareQuality>("1080p");
  const [screenShareFps, setScreenShareFps] = useState<ScreenShareFps>(30);
  const activeRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const audioSendersRef = useRef(new Map<string, RTCRtpSender>());
  const screenAudioSendersRef = useRef(new Map<string, RTCRtpSender>());
  const videoSendersRef = useRef(new Map<string, RTCRtpSender>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const peerNegotiationRef = useRef(new Map<string, PeerNegotiationState>());
  const remoteStreamByUserRef = useRef(new Map<string, MediaStream>());
  const screenRecoveryTimersRef = useRef(new Map<string, number>());
  const screenStreamRef = useRef<MediaStream | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewRequestRef = useRef(0);
  const screenShareQualityRef = useRef<ScreenShareQuality>("1080p");
  const screenShareFpsRef = useRef<ScreenShareFps>(30);
  const remoteStreamsRef = useRef<Array<{ userId: string; stream: MediaStream }>>([]);
  const connectingSoundTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartPendingRef = useRef(false);
  const recordingIdRef = useRef("");
  const recordingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingErrorRef = useRef<Error | null>(null);
  const recordingPendingBytesRef = useRef(0);
  const recordingPendingChunksRef = useRef(0);
  const recordingUploadedBytesRef = useRef(0);
  const recordingCleanupRef = useRef<(() => void) | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const callTimerRef = useRef<number | null>(null);
  const recordingStopPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const resolveRecordingStopRef = useRef<(() => void) | null>(null);
  const reactionTimersRef = useRef<number[]>([]);
  const finishCallRef = useRef<(notify: boolean, sound?: CallSound | null) => void>(() => undefined);

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
    setRingtoneAudible(false);
  }, []);

  const prepareAudio = useCallback(async () => {
    const ready = await prepareCallAudio();
    setAudioReady(ready);
    return ready;
  }, []);

  const startConnectingSound = useCallback(() => {
    stopConnectingSound();
    setRingtoneAudible(playCallSound("connecting"));
    connectingSoundTimerRef.current = window.setInterval(() => {
      if (playCallSound("connecting")) setRingtoneAudible(true);
    }, 1500);
  }, [stopConnectingSound]);

  const callPayload = useCallback((call: ActiveCall) => ({
    callId: call.callId,
    clientId: clientIdRef.current,
    mode: call.mode,
    scope: call.thread.scope,
    recipientId: call.thread.recipientId || null,
    subteamId: call.thread.subteamId || null,
  }), []);

  const receiveHands = useCallback((event: TeamCallSocketEvent) => {
    if (event.raisedHands && (event.handRevision ?? 0) >= handRevisionRef.current) {
      handRevisionRef.current = event.handRevision ?? 0;
      setRaisedHands(event.raisedHands);
    }
  }, []);

  const receiveMessages = useCallback((messages: MeetingMessage[]) => {
    setMeetingMessages((current) => Array.from(new Map([...current, ...messages].map((message) => [message.id, message])).values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }, []);

  const syncMeetingChat = useCallback(async () => {
    const call = activeRef.current;
    if (!call) return;
    try {
      const response = await fetch(`${TEAM_CHAT_API}/calls/${call.callId}/messages?clientId=${encodeURIComponent(clientIdRef.current)}`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (activeRef.current?.callId === call.callId) receiveMessages(data.messages || []);
    } catch { /* A próxima sincronização recupera mensagens após reconectar. */ }
  }, [receiveMessages, session.token]);

  const sendMeetingMessage = useCallback(async (text: string, files: File[]) => {
    const call = activeRef.current;
    if (!call) throw new Error("A reunião foi encerrada.");
    const attachments = await prepareChatAttachments(files);
    if (activeRef.current?.callId !== call.callId) throw new Error("A reunião foi encerrada.");
    const response = await fetch(`${TEAM_CHAT_API}/calls/${call.callId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientIdRef.current, text, attachments }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Não foi possível enviar a mensagem.");
    if (activeRef.current?.callId === call.callId && data.message) receiveMessages([data.message]);
  }, [receiveMessages, session.token]);

  const toggleHand = useCallback(() => {
    const call = activeRef.current;
    if (call && !sendSocketEvent({ type: "CALL_HAND_STATE", ...callPayload(call), raised: !raisedHands[session.user.id] })) {
      setStatus("A conexão caiu. Tente levantar a mão novamente ao reconectar.");
    }
  }, [callPayload, raisedHands, sendSocketEvent, session.user.id]);

  const publishMediaState = useCallback(() => {
    const call = activeRef.current;
    if (!call) return;
    sendSocketEvent({ type: "CALL_MEDIA_STATE", ...callPayload(call),
      cameraEnabled: !!localStreamRef.current?.getVideoTracks().some((track) => track.enabled && track.readyState !== "ended"),
      screenSharing: !!screenStreamRef.current,
    });
  }, [callPayload, sendSocketEvent]);

  useEffect(() => { if (active) publishMediaState(); }, [active, cameraOff, sharingScreen, publishMediaState]);

  const closePeer = useCallback((userId: string) => {
    announcedScreensRef.current.delete(userId);
    const recoveryTimer = screenRecoveryTimersRef.current.get(userId);
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer);
    screenRecoveryTimersRef.current.delete(userId);
    const peer = peersRef.current.get(userId);
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onnegotiationneeded = null;
      peer.close();
    }
    peersRef.current.delete(userId);
    audioSendersRef.current.delete(userId);
    screenAudioSendersRef.current.delete(userId);
    setRemoteCameraEnabled((current) => { const next = { ...current }; delete next[userId]; return next; });
    videoSendersRef.current.delete(userId);
    pendingCandidatesRef.current.delete(userId);
    peerNegotiationRef.current.delete(userId);
    remoteStreamByUserRef.current.get(userId)?.getTracks().forEach((track) => {
      track.onended = null;
    });
    remoteStreamByUserRef.current.delete(userId);
    setRemoteStreams((current) => current.filter((item) => item.userId !== userId));
    setRemoteScreenSharingIds((current) => current.filter((item) => item !== userId));
  }, []);

  const stopMedia = useCallback(() => {
    previewRequestRef.current += 1;
    previewStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    previewStreamRef.current = null;
    setPreviewStream(null);
    screenStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screenStreamRef.current = null;
    setScreenStream(null);
    localStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    localStreamRef.current = null;
    setLocalStream(null);
    setSharingScreen(false);
  }, []);

  const finishCall = useCallback((notify: boolean, sound: CallSound | null = null) => {
    const call = activeRef.current;
    mediaEpochRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    confirmedCallIdRef.current = "";
    setMeetingMessages([]);
    setRaisedHands({});
    handRevisionRef.current = -1;
    announcedScreensRef.current.clear();
    if (notify && call) sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    stopConnectingSound();
    peersRef.current.forEach((peer) => {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onnegotiationneeded = null;
      peer.close();
    });
    peersRef.current.clear();
    audioSendersRef.current.clear();
    screenAudioSendersRef.current.clear();
    videoSendersRef.current.clear();
    pendingCandidatesRef.current.clear();
    peerNegotiationRef.current.clear();
    remoteStreamByUserRef.current.forEach((stream) => stream.getTracks().forEach((track) => {
      track.onended = null;
    }));
    remoteStreamByUserRef.current.clear();
    screenRecoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    screenRecoveryTimersRef.current.clear();
    setRemoteStreams([]);
    setRemoteScreenSharingIds([]);
    setRemoteCameraEnabled({});
    stopMedia();
    setIncoming(null);
    incomingRef.current = null;
    setActive(null);
    activeRef.current = null;
    setMuted(false);
    setListenOnly(false);
    setCameraOff(true);
    setCallElapsedSeconds(0);
    if (callTimerRef.current !== null) window.clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    setRecording(false);
    setRecordingElapsedSeconds(0);
    setRecordingUploadState("idle");
    setRecordingUploadedBytes(0);
    setRecordingPendingBytes(0);
    recordingUploadedBytesRef.current = 0;
    recordingPendingBytesRef.current = 0;
    recordingPendingChunksRef.current = 0;
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

  finishCallRef.current = finishCall;

  useEffect(() => {
    const leaveOnClose = () => {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      finishCallRef.current(false);
    };
    window.addEventListener("pagehide", leaveOnClose);
    return () => { window.removeEventListener("pagehide", leaveOnClose); leaveOnClose(); };
  }, []);

  const heartbeat = useCallback(() => {
    const call = activeRef.current;
    return call ? sendSocketEvent({ type: "CALL_HEARTBEAT", ...callPayload(call) }) : false;
  }, [callPayload, sendSocketEvent]);

  useEffect(() => {
    if (!active) return;
    heartbeat();
    const timer = window.setInterval(heartbeat, 10000);
    return () => window.clearInterval(timer);
  }, [active, heartbeat]);

  useEffect(() => {
    if (!incoming) return;
    const timer = window.setTimeout(() => {
      if (incomingRef.current?.callId !== incoming.callId) return;
      dismissedInviteIdsRef.current.add(incoming.callId);
      incomingRef.current = null;
      setIncoming(null);
      stopConnectingSound();
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [incoming, stopConnectingSound]);

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

  const prepareCameraPreview = useCallback(async (enabled: boolean, deviceId = selectedCameraId) => {
    const request = ++previewRequestRef.current;
    previewStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    previewStreamRef.current = null;
    setPreviewStream(null);
    if (!enabled) return true;
    if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
      setCameraPermission("unavailable");
      setStatus("A câmera exige uma conexão HTTPS segura e um navegador compatível.");
      return false;
    }
    setCameraPermission("requesting");
    let requestedStream: MediaStream | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      requestedStream = stream;
      if (request !== previewRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) throw new DOMException("Nenhuma câmera respondeu.", "NotFoundError");
      track.enabled = true;
      track.onended = () => {
        if (previewStreamRef.current !== stream) return;
        previewStreamRef.current = null;
        setPreviewStream(null);
        setCameraPermission("unavailable");
        setStatus("A câmera foi desconectada. Escolha outro dispositivo.");
      };
      previewStreamRef.current = stream;
      setPreviewStream(stream);
      setCameraPermission("granted");
      return true;
    } catch (error) {
      requestedStream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      const name = error instanceof DOMException ? error.name : "";
      setCameraPermission(["NotAllowedError", "SecurityError"].includes(name) ? "denied" : "unavailable");
      setStatus(`${mediaAccessError(error, "camera")} A chamada pode continuar somente por áudio.`);
      return false;
    }
  }, [selectedCameraId]);

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

  const acquireMedia = useCallback(async (
    options: CallEntryOptions = DEFAULT_ENTRY_OPTIONS,
    epoch = mediaEpochRef.current,
  ) => {
    if (options.microphoneMode === "listen-only" && !options.cameraEnabled) {
      await prepareCameraPreview(false);
      localStreamRef.current = null;
      setLocalStream(null);
      setMuted(true);
      setListenOnly(true);
      setCameraOff(true);
      await refreshDevices().catch(() => undefined);
      return null;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador nao permite acesso a dispositivos de mídia.");

    let audioStream: MediaStream | null = null;
    if (options.microphoneMode !== "listen-only") {
      const audioPreferences: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(selectedMicrophoneId ? { deviceId: { exact: selectedMicrophoneId } } : {}),
      };
      setMicrophonePermission("requesting");
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioPreferences, video: false });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (!selectedMicrophoneId || !["NotFoundError", "OverconstrainedError"].includes(name)) {
          setMicrophonePermission(["NotAllowedError", "SecurityError"].includes(name) ? "denied" : "unavailable");
          throw error;
        }
        setSelectedMicrophoneId("");
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
        } catch (fallbackError) {
          const fallbackName = fallbackError instanceof DOMException ? fallbackError.name : "";
          setMicrophonePermission(["NotAllowedError", "SecurityError"].includes(fallbackName) ? "denied" : "unavailable");
          throw fallbackError;
        }
      }
      setMicrophonePermission("granted");
    }

    let cameraStream: MediaStream | null = null;
    if (options.cameraEnabled) {
      cameraStream = previewStreamRef.current;
      if (cameraStream) {
        previewRequestRef.current += 1;
        previewStreamRef.current = null;
        setPreviewStream(null);
      } else {
        setCameraPermission("requesting");
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });
          setCameraPermission("granted");
        } catch (error) {
          const name = error instanceof DOMException ? error.name : "";
          setCameraPermission(["NotAllowedError", "SecurityError"].includes(name) ? "denied" : "unavailable");
          audioStream?.getTracks().forEach((track) => track.stop());
          throw error;
        }
      }
    } else {
      await prepareCameraPreview(false);
    }

    const stream = audioStream && cameraStream
      ? new MediaStream([...audioStream.getAudioTracks(), ...cameraStream.getVideoTracks()])
      : audioStream || cameraStream;
    if (!stream) throw new Error("Nenhum dispositivo de mídia foi selecionado.");
    if (epoch !== mediaEpochRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Entrada cancelada.", "AbortError");
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (options.microphoneMode !== "listen-only" && !audioTrack) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("O microfone nao forneceu audio.", "NotFoundError");
    }
    if (audioTrack) {
      audioTrack.enabled = options.microphoneMode === "on";
      if ("contentHint" in audioTrack) audioTrack.contentHint = "speech";
      audioTrack.onended = () => {
        setMuted(true);
        setStatus("O microfone foi desconectado. Abra Dispositivos e escolha uma entrada de áudio.");
      };
    }
    localStreamRef.current = stream;
    setLocalStream(stream);
    setMuted(options.microphoneMode !== "on");
    setListenOnly(options.microphoneMode === "listen-only");
    setCameraOff(!options.cameraEnabled);
    await refreshDevices().catch(() => undefined);
    return stream;
  }, [prepareCameraPreview, refreshDevices, selectedCameraId, selectedMicrophoneId]);

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
    const epoch = mediaEpochRef.current;
    const currentStream = localStreamRef.current;
    if (!currentStream || !navigator.mediaDevices?.getUserMedia) {
      if (kind === "audio") setSelectedMicrophoneId(deviceId);
      else setSelectedCameraId(deviceId);
      return;
    }
    if (kind === "video" && !currentStream.getVideoTracks().length) {
      setSelectedCameraId(deviceId);
      return;
    }
    setStatus(kind === "audio" ? "Trocando microfone..." : "Trocando camera...");
    try {
      const replacementStream = await navigator.mediaDevices.getUserMedia(kind === "audio"
        ? { audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
        : { audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (epoch !== mediaEpochRef.current) {
        replacementStream.getTracks().forEach((track) => track.stop());
        return;
      }
      const replacementTrack = kind === "audio" ? replacementStream.getAudioTracks()[0] : replacementStream.getVideoTracks()[0];
      if (!replacementTrack) throw new Error("O dispositivo selecionado nao forneceu midia.");
      replacementTrack.enabled = kind === "audio" ? !muted : !cameraOff;
      if (kind === "audio" && "contentHint" in replacementTrack) replacementTrack.contentHint = "speech";

      // Durante a transmissao de tela, a nova camera fica preparada localmente
      // e passa a ser enviada quando o compartilhamento terminar.
      if (kind === "audio" || !screenStreamRef.current) {
        await Promise.all(Array.from(peersRef.current.entries()).map(async ([remoteUserId, peer]) => {
          const sender = kind === "video"
            ? videoSendersRef.current.get(remoteUserId)
            : audioSendersRef.current.get(remoteUserId) || peer.getSenders().find((item) => item.track?.kind === kind);
          if (sender) {
            await sender.replaceTrack(replacementTrack);
            if (kind === "audio") audioSendersRef.current.set(remoteUserId, sender);
          }
        }));
      }

      if (epoch !== mediaEpochRef.current) {
        replacementStream.getTracks().forEach((track) => track.stop());
        return;
      }
      currentStream.getTracks().filter((track) => track.kind === kind).forEach((track) => { track.onended = null; track.stop(); });
      const nextStream = new MediaStream([
        ...currentStream.getTracks().filter((track) => track.kind !== kind),
        replacementTrack,
      ]);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      if (kind === "audio") setSelectedMicrophoneId(deviceId);
      else {
        setSelectedCameraId(deviceId);
        setCameraOff(!replacementTrack.enabled);
      }
      replacementStream.getTracks().filter((track) => track !== replacementTrack).forEach((track) => track.stop());
      setStatus("Na chamada");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Nao foi possivel trocar o dispositivo.");
    }
  }, [cameraOff, muted]);

  const createMeetingRecordingStream = useCallback(() => createMeetingRecording(() => {
    const sources = remoteStreamsRef.current.map((item) => ({
      id: `${item.userId}-${remoteMediaRef.current.screenIds.includes(item.userId) ? "screen" : "camera"}`,
      label: `${remoteMediaRef.current.screenIds.includes(item.userId) ? "Tela de" : "Participante"} ${item.userId}`,
      stream: item.stream, screen: remoteMediaRef.current.screenIds.includes(item.userId),
      visible: remoteMediaRef.current.screenIds.includes(item.userId) || remoteMediaRef.current.cameras[item.userId] === true,
    }));
    if (localStreamRef.current) sources.push({ id: "local", label: session.user.nome || "Você", stream: localStreamRef.current,
      screen: false, visible: localStreamRef.current.getVideoTracks().some((track) => track.enabled && track.readyState !== "ended") });
    if (screenStreamRef.current) sources.push({ id: "local-screen", label: "Sua tela compartilhada", stream: screenStreamRef.current, screen: true, visible: true });
    return sources;
  }), [session.user.nome]);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    await recordingStopPromiseRef.current;
  }, []);

  const startRecording = useCallback(async () => {
    const call = activeRef.current;
    if (!call || recording || mediaRecorderRef.current || recordingStartPendingRef.current || typeof MediaRecorder === "undefined") {
      if (typeof MediaRecorder === "undefined") setStatus("Este navegador nao permite gravar reunioes.");
      return;
    }
    const consented = window.confirm(
      "Iniciar gravação desta reunião? Todos os participantes serão avisados. O áudio, o vídeo e a tela compartilhada poderão ser capturados e a gravação ficará disponível no chat por 24 horas.",
    );
    if (!consented) {
      setStatus("Gravação não iniciada.");
      return;
    }
    const epoch = mediaEpochRef.current;
    recordingStartPendingRef.current = true;
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    const mimeType = candidates.find((candidate) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(candidate)) || "";
    let cleanup: (() => void) | null = null;
    let recordingId = "";
    const startOperationId = crypto.randomUUID();
    const recordingHeaders = {
      Authorization: `Bearer ${session.token}`,
      "X-Call-Client-Id": clientIdRef.current,
    };
    const abortUpload = async (id: string) => {
      await fetchRecordingWithRetry(`${TEAM_CHAT_API}/recordings/${id}`, {
        method: "DELETE",
        headers: {
          ...recordingHeaders,
          "X-Recording-Operation-Id": `abort-${startOperationId}`,
        },
      }).catch(() => undefined);
    };
    try {
      setStatus("Preparando gravacao...");
      const composition = createMeetingRecordingStream();
      cleanup = composition.cleanup;
      const startResponse = await fetchRecordingWithRetry(`${TEAM_CHAT_API}/recordings/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          callId: call.callId,
          clientId: clientIdRef.current,
          operationId: startOperationId,
          scope: call.thread.scope,
          recipientId: call.thread.recipientId || null,
          subteamId: call.thread.subteamId || null,
          mimeType: mimeType || "video/webm",
        }),
      }, () => setRecordingUploadState("retrying"));
      const startData = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(startData?.detail || "Nao foi possivel iniciar a gravacao.");
      recordingId = String(startData.recording?.id || "");
      if (!recordingId) throw new Error("O servidor nao confirmou a gravacao.");
      if (epoch !== mediaEpochRef.current) throw new Error("A reunião foi encerrada antes de iniciar a gravação.");

      const recorder = new MediaRecorder(composition.stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recordingIdRef.current = recordingId;
      recordingCleanupRef.current = cleanup;
      recordingQueueRef.current = Promise.resolve();
      recordingErrorRef.current = null;
      recordingPendingBytesRef.current = 0;
      recordingPendingChunksRef.current = 0;
      recordingUploadedBytesRef.current = 0;
      setRecordingPendingBytes(0);
      setRecordingUploadedBytes(0);
      setRecordingUploadState("uploading");
      recordingStopPromiseRef.current = new Promise<void>((resolve) => { resolveRecordingStopRef.current = resolve; });
      recorder.ondataavailable = (event) => {
        if (!event.data.size || recordingErrorRef.current) return;
        const chunkId = crypto.randomUUID();
        recordingPendingBytesRef.current += event.data.size;
        recordingPendingChunksRef.current += 1;
        setRecordingPendingBytes(recordingPendingBytesRef.current);
        if (recordingNeedsBackpressure(recordingPendingBytesRef.current, recordingPendingChunksRef.current)
          && recorder.state === "recording") recorder.pause();
        recordingQueueRef.current = recordingQueueRef.current.then(async () => {
          setRecordingUploadState("uploading");
          const response = await fetchRecordingWithRetry(`${TEAM_CHAT_API}/recordings/${recordingId}/chunks`, {
            method: "PUT",
            headers: {
              ...recordingHeaders,
              "Content-Type": "application/octet-stream",
              "X-Recording-Chunk-Id": chunkId,
            },
            body: event.data,
          }, () => setRecordingUploadState("retrying"));
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.detail || "Falha ao enviar um trecho da gravacao.");
          }
          recordingUploadedBytesRef.current += event.data.size;
          setRecordingUploadedBytes(recordingUploadedBytesRef.current);
        }).catch((error) => {
          recordingErrorRef.current = error instanceof Error ? error : new Error("Falha ao enviar a gravacao.");
          setRecordingUploadState("failed");
          if (recorder.state !== "inactive") recorder.stop();
        }).finally(() => {
          recordingPendingBytesRef.current = Math.max(0, recordingPendingBytesRef.current - event.data.size);
          recordingPendingChunksRef.current = Math.max(0, recordingPendingChunksRef.current - 1);
          setRecordingPendingBytes(recordingPendingBytesRef.current);
          if (!recordingErrorRef.current && recorder.state === "paused"
            && !recordingNeedsBackpressure(recordingPendingBytesRef.current, recordingPendingChunksRef.current)) {
            recorder.resume();
          }
        });
      };
      recorder.onstop = () => {
        void (async () => {
          await recordingQueueRef.current;
          try {
            if (recordingErrorRef.current) throw recordingErrorRef.current;
            setRecordingUploadState("finalizing");
            const response = await fetchRecordingWithRetry(`${TEAM_CHAT_API}/recordings/${recordingId}/complete`, {
              method: "POST",
              headers: {
                ...recordingHeaders,
                "X-Recording-Operation-Id": `complete-${startOperationId}`,
              },
            }, () => setRecordingUploadState("retrying"));
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.detail || "Nao foi possivel finalizar a gravacao.");
            if (activeRef.current?.callId === call.callId) setStatus("Gravação com tela e áudio salva no chat da equipe por 24 horas.");
          } catch (error) {
            setRecordingUploadState("failed");
            if (activeRef.current?.callId === call.callId) setStatus(error instanceof Error ? error.message : "Falha ao salvar a gravacao.");
            await abortUpload(recordingId);
          } finally {
            recordingCleanupRef.current?.();
            recordingCleanupRef.current = null;
            mediaRecorderRef.current = null;
            recordingIdRef.current = "";
            setRecording(false);
            setRecordingElapsedSeconds(0);
            setRecordingPendingBytes(0);
            recordingPendingBytesRef.current = 0;
            recordingPendingChunksRef.current = 0;
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
      setStatus("Gravando reunião · todos os participantes foram avisados");
    } catch (error) {
      cleanup?.();
      setRecordingUploadState("failed");
      if (recordingId) await abortUpload(recordingId);
      if (epoch === mediaEpochRef.current) setStatus(error instanceof Error ? error.message : "Nao foi possivel iniciar a gravacao.");
    } finally {
      recordingStartPendingRef.current = false;
    }
  }, [createMeetingRecordingStream, recording, session.token]);

  const negotiationStateFor = useCallback((remoteUserId: string) => {
    let state = peerNegotiationRef.current.get(remoteUserId);
    if (!state) {
      state = {
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: session.user.id.localeCompare(remoteUserId) > 0,
        revision: 0,
      };
      peerNegotiationRef.current.set(remoteUserId, state);
    }
    return state;
  }, [session.user.id]);

  const negotiatePeer = useCallback(async (remoteUserId: string, peer: RTCPeerConnection) => {
    const call = activeRef.current;
    const negotiation = negotiationStateFor(remoteUserId);
    if (!call || negotiation.makingOffer || peer.signalingState !== "stable") return;
    const revision = ++negotiation.revision;
    try {
      negotiation.makingOffer = true;
      const offer = await peer.createOffer();
      if (negotiation.revision !== revision
        || peersRef.current.get(remoteUserId) !== peer
        || activeRef.current?.callId !== call.callId) return;
      await peer.setLocalDescription(offer);
      if (negotiation.revision !== revision
        || peersRef.current.get(remoteUserId) !== peer
        || activeRef.current?.callId !== call.callId) return;
      sendSocketEvent({
        type: "CALL_SIGNAL",
        ...callPayload(call),
        targetUserId: remoteUserId,
        signal: peer.localDescription || offer,
      });
    } finally {
      if (negotiation.revision === revision) negotiation.makingOffer = false;
    }
  }, [callPayload, negotiationStateFor, sendSocketEvent]);

  const attachVideoTrack = useCallback(async (track: MediaStreamTrack | null, sourceStream: MediaStream) => {
    await Promise.all(Array.from(peersRef.current.entries()).map(async ([remoteUserId, peer]) => {
      const existingSender = videoSendersRef.current.get(remoteUserId);
      if (existingSender) {
        const transceiver = typeof peer.getTransceivers === "function"
          ? peer.getTransceivers().find((item) => item.sender === existingSender)
          : undefined;
        if (track && transceiver && transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
        await existingSender.replaceTrack(track);
        if (track && screenStreamRef.current?.getVideoTracks().includes(track)) {
          await applyScreenShareSenderProfile(existingSender, screenShareQualityRef.current, screenShareFpsRef.current).catch(() => undefined);
        }
        // replaceTrack(null -> tela) não libera quadros em alguns navegadores
        // sem um novo SDP. O emissor renegocia já com a faixa ativa.
        await negotiatePeer(remoteUserId, peer);
        return;
      }
      if (!track) return;
      const sender = peer.addTrack(track, sourceStream);
      videoSendersRef.current.set(remoteUserId, sender);
      if (screenStreamRef.current?.getVideoTracks().includes(track)) {
        await applyScreenShareSenderProfile(sender, screenShareQualityRef.current, screenShareFpsRef.current).catch(() => undefined);
      }
      await negotiatePeer(remoteUserId, peer);
    }));
  }, [negotiatePeer]);

  const createPeer = useCallback(async (remoteUserId: string, createOffer: boolean) => {
    const call = activeRef.current;
    if (!call || remoteUserId === session.user.id) return null;
    let peer = peersRef.current.get(remoteUserId);
    if (!peer) {
      peer = new RTCPeerConnection({
        iceServers: configuredIceServers(),
        iceCandidatePoolSize: 4,
        bundlePolicy: "max-bundle",
      });
      peersRef.current.set(remoteUserId, peer);
      negotiationStateFor(remoteUserId);
      const localAudioTrack = localStreamRef.current?.getAudioTracks().find((track) => track.readyState !== "ended");
      if (localAudioTrack && localStreamRef.current) {
        const audioSender = peer.addTrack(localAudioTrack, localStreamRef.current);
        audioSendersRef.current.set(remoteUserId, audioSender);
      } else {
        // Mantem um canal de audio negociado mesmo se o dispositivo for
        // conectado alguns instantes depois de entrar na reuniao.
        const transceiver = peer.addTransceiver("audio", { direction: "sendrecv" });
        audioSendersRef.current.set(remoteUserId, transceiver.sender);
      }
      const outgoingVideoTrack = screenStreamRef.current?.getVideoTracks()[0]
        || localStreamRef.current?.getVideoTracks().find((track) => track.enabled);
      const outgoingVideoStream = screenStreamRef.current || localStreamRef.current;
      // Audio da tela tem seu proprio canal; silenciar o microfone nao o corta.
      const screenAudio = screenStreamRef.current?.getAudioTracks()[0];
      const screenAudioSender = screenAudio && screenStreamRef.current
        ? peer.addTrack(screenAudio, screenStreamRef.current)
        : peer.addTransceiver("audio", { direction: "sendrecv" }).sender;
      screenAudioSendersRef.current.set(remoteUserId, screenAudioSender);
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
        if (event.candidate && current && peersRef.current.get(remoteUserId) === peer) {
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
        // Microfone e som da tela coexistem. Video continua em um unico canal.
        const tracks = [
          ...previousTracks.filter((track) => track.readyState !== "ended" &&
            (event.track.kind === "video" ? track.kind !== "video" : track.id !== event.track.id)),
          event.track,
        ];
        const stream = new MediaStream(tracks);
        remoteStreamByUserRef.current.set(remoteUserId, stream);
        if (event.track.kind === "video") {
          const markVideoReceived = () => {
            const recoveryTimer = screenRecoveryTimersRef.current.get(remoteUserId);
            if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer);
            screenRecoveryTimersRef.current.delete(remoteUserId);
            if (recoveryTimer !== undefined) setStatus("Transmissão de tela recebida");
          };
          if (!event.track.muted) markVideoReceived();
          else event.track.addEventListener("unmute", markVideoReceived, { once: true });
        }
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
        const connectionState = peer?.connectionState || "";
        if (connectionState === "connected") {
          publishMediaState();
          const currentAudioTrack = localStreamRef.current?.getAudioTracks().find((track) => track.readyState !== "ended") || null;
          const audioSender = audioSendersRef.current.get(remoteUserId);
          if (audioSender && currentAudioTrack && audioSender.track !== currentAudioTrack) {
            void audioSender.replaceTrack(currentAudioTrack).catch(() => undefined);
          }
          setStatus("Na chamada · áudio conectado");
          return;
        }
        if (connectionState === "failed") {
          // Uma troca de rede pode invalidar o par ICE. Tentar uma nova rota e
          // renegociar evita encerrar a midia dos dois lados prematuramente.
          peer?.restartIce();
          if (peer) void negotiatePeer(remoteUserId, peer).catch(() => closePeer(remoteUserId));
          return;
        }
        if (connectionState === "disconnected") {
          setConnectionQuality("poor");
          setStatus("Reconectando áudio e vídeo...");
          return;
        }
        if (connectionState === "closed") closePeer(remoteUserId);
      };
      const negotiationPeer = peer;
      peer.onnegotiationneeded = () => {
        if (peersRef.current.get(remoteUserId) === negotiationPeer) {
          void negotiatePeer(remoteUserId, negotiationPeer).catch(() => closePeer(remoteUserId));
        }
      };
    }
    if (createOffer) await negotiatePeer(remoteUserId, peer);
    return peer;
  }, [callPayload, closePeer, negotiatePeer, negotiationStateFor, publishMediaState, sendSocketEvent, session.user.id]);

  const requestRemoteScreenRefresh = useCallback(async (remoteUserId: string) => {
    // O emissor renegocia imediatamente com a faixa anexada. O receptor só
    // cria uma oferta de recuperação se nenhum quadro chegar, evitando glare
    // entre duas ofertas simultâneas.
    const peer = await createPeer(remoteUserId, false);
    const previousTimer = screenRecoveryTimersRef.current.get(remoteUserId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const recoveryTimer = window.setTimeout(() => {
      screenRecoveryTimersRef.current.delete(remoteUserId);
      const remoteVideoReady = remoteStreamByUserRef.current
        .get(remoteUserId)
        ?.getVideoTracks()
        .some((track) => track.readyState === "live" && !track.muted);
      if (remoteVideoReady) return;
      const currentPeer = peersRef.current.get(remoteUserId);
      if (!currentPeer) return;
      if (["failed", "disconnected"].includes(currentPeer.connectionState)) currentPeer.restartIce();
      setStatus("Reconectando a transmissão de tela...");
      void negotiatePeer(remoteUserId, currentPeer).catch(() => {
        setStatus("Não foi possível receber a tela. Peça ao participante para interromper e compartilhar novamente.");
      });
    }, 3500);
    screenRecoveryTimersRef.current.set(remoteUserId, recoveryTimer);
    return peer;
  }, [createPeer, negotiatePeer]);

  const applyCurrentScreenShareProfile = useCallback(async (quality: ScreenShareQuality, fps: ScreenShareFps) => {
    screenShareQualityRef.current = quality;
    screenShareFpsRef.current = fps;
    setScreenShareQuality(quality);
    setScreenShareFps(fps);
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
    if (screenTrack?.readyState === "live" && typeof screenTrack.applyConstraints === "function") {
      await screenTrack.applyConstraints(screenShareConstraints(quality, fps)).catch(() => undefined);
    }
    if (screenTrack) {
      await Promise.all(Array.from(videoSendersRef.current.values()).map((sender) => (
        applyScreenShareSenderProfile(sender, quality, fps).catch(() => undefined)
      )));
    }
    if (screenTrack) setStatus(`Transmitindo em ${quality} · ${fps} FPS`);
  }, []);

  const syncActiveCalls = useCallback((calls: TeamCallSocketEvent[]) => {
    const valid = calls.filter((call) => call.callId && !endedCallIdsRef.current.has(call.callId));
    availableCallsRef.current = valid;
    setAvailableCalls(valid);
    const current = activeRef.current || incomingRef.current;
    if (current && !valid.some((call) => call.callId === current.callId)
      && (incomingRef.current || confirmedCallIdRef.current === current.callId)) {
      endedCallIdsRef.current.add(current.callId);
      void stopRecording();
      finishCall(false);
    }
  }, [finishCall, stopRecording]);

  const acceptCall = useCallback(async (
    pendingCall: IncomingCall,
    entryOptions: CallEntryOptions = DEFAULT_ENTRY_OPTIONS,
  ) => {
    if (activeRef.current || busyRef.current || endedCallIdsRef.current.has(pendingCall.callId)) return false;
    busyRef.current = true;
    setBusy(true);
    const epoch = mediaEpochRef.current;
    incomingRef.current = pendingCall;
    setIncoming(pendingCall);
    setStatus("Conectando dispositivos...");
    startConnectingSound();
    try {
      await acquireMedia(entryOptions, epoch);
      if (epoch !== mediaEpochRef.current || incomingRef.current?.callId !== pendingCall.callId) return false;
      const call: ActiveCall = { ...pendingCall };
      activeRef.current = call;
      setActive(call);
      setIncoming(null);
      incomingRef.current = null;
      if (!sendSocketEvent({ type: "CALL_ACCEPT", ...callPayload(call) })) {
        throw new Error("A conexão da reunião foi interrompida. Tente ingressar novamente.");
      }
      dismissedInviteIdsRef.current.add(call.callId);
      stopConnectingSound();
      playCallSound("joined");
      setStatus("Na chamada");
      return true;
    } catch (error) {
      if (epoch !== mediaEpochRef.current) return false;
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
      return false;
    } finally {
      if (epoch === mediaEpochRef.current) { busyRef.current = false; setBusy(false); }
    }
  }, [acquireMedia, callPayload, finishCall, sendSocketEvent, startConnectingSound, stopConnectingSound]);

  const acceptIncoming = useCallback(async (entryOptions: CallEntryOptions = DEFAULT_ENTRY_OPTIONS) => {
    const pendingCall = incomingRef.current;
    return pendingCall ? acceptCall(pendingCall, entryOptions) : false;
  }, [acceptCall]);

  const joinActiveCall = useCallback(async (
    event: TeamCallSocketEvent,
    entryOptions: CallEntryOptions = DEFAULT_ENTRY_OPTIONS,
  ) => {
    const pendingCall = incomingCallFromEvent(event, session.user.id);
    return pendingCall ? acceptCall(pendingCall, entryOptions) : false;
  }, [acceptCall, session.user.id]);

  const startCall = useCallback(async (
    targetThread: TeamCallThread = thread,
    entryOptions: CallEntryOptions = DEFAULT_ENTRY_OPTIONS,
  ) => {
    if (activeRef.current || busyRef.current) return false;
    const threadId = targetThread.scope === "team" ? "team" : targetThread.scope === "subteam"
      ? `subteam:${targetThread.subteamId}` : `direct:${[session.user.id, targetThread.recipientId].sort().join(":")}`;
    const existing = availableCallsRef.current.find((call) => call.threadId === threadId);
    if (existing) return joinActiveCall(existing, entryOptions);
    busyRef.current = true;
    setBusy(true);
    const epoch = mediaEpochRef.current;
    setStatus(entryOptions.microphoneMode === "listen-only"
      ? "Entrando em modo somente escuta..."
      : entryOptions.cameraEnabled
        ? "Solicitando acesso ao microfone e à câmera..."
        : "Solicitando acesso ao microfone...");
    try {
      await acquireMedia(entryOptions, epoch);
      if (epoch !== mediaEpochRef.current) return false;
      const call: ActiveCall = {
        callId: callId(), mode: "audio", title: targetThread.title, thread: targetThread,
        hostUserId: session.user.id, startedAt: new Date().toISOString(),
      };
      activeRef.current = call;
      setActive(call);
      setIncoming(null);
      incomingRef.current = null;
      setStatus(targetThread.scope === "direct" ? "Chamando participante..." : "Chamando a equipe...");
      startConnectingSound();
      if (!sendSocketEvent({ type: "CALL_INVITE", ...callPayload(call) })) {
        throw new Error("A conexão em tempo real ainda não está pronta.");
      }
      return true;
    } catch (error) {
      if (epoch !== mediaEpochRef.current) return false;
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
      return false;
    } finally {
      if (epoch === mediaEpochRef.current) { busyRef.current = false; setBusy(false); }
    }
  }, [acquireMedia, callPayload, finishCall, joinActiveCall, sendSocketEvent, session.user.id, startConnectingSound, thread]);

  const rejectIncoming = useCallback(() => {
    const pendingCall = incomingRef.current;
    if (pendingCall) {
      dismissedInviteIdsRef.current.add(pendingCall.callId);
      sendSocketEvent({ type: "CALL_REJECT", ...callPayload(pendingCall) });
    }
    finishCall(false);
  }, [callPayload, finishCall, sendSocketEvent]);

  const revokeAccess = useCallback((detail = "Seu acesso à chamada foi revogado.") => {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    finishCall(false);
    setStatus(detail);
  }, [finishCall]);

  const handleSocketEvent = useCallback(async (event: TeamCallSocketEvent) => {
    if (event.type === "CALLS_STATE") {
      syncActiveCalls(event.calls || []);
      const current = event.calls?.find((call) => call.callId === activeRef.current?.callId);
      if (current) { receiveHands(current); if (confirmedCallIdRef.current) void syncMeetingChat(); }
      return;
    }
    if (event.type === "CALL_ACK" && event.callId === activeRef.current?.callId) {
      confirmedCallIdRef.current = event.callId || "";
      if (event.event === "CALL_INVITE" || event.event === "CALL_ACCEPT") void syncMeetingChat();
      return;
    }
    if (event.type === "CALL_ERROR") {
      if (event.callId && event.callId === activeRef.current?.callId && !confirmedCallIdRef.current) finishCall(false);
      if (event.detail) setStatus(event.detail);
      return;
    }
    if (event.type === "CALL_SESSION" && event.fromUserId === session.user.id) {
      if (event.callId === activeRef.current?.callId && event.clientId !== clientIdRef.current) {
        void stopRecording();
        finishCall(false);
        setStatus("Esta reunião está aberta em outra aba ou dispositivo.");
      }
      return;
    }
    if (event.type === "CALL_ACTIVE" && event.requestedCallId === activeRef.current?.callId && event.callId !== event.requestedCallId) {
      finishCall(false);
      syncActiveCalls([...availableCallsRef.current.filter((call) => call.threadId !== event.threadId), event]);
      setStatus("Já existe uma reunião nesta conversa. Use Ingressar.");
      return;
    }
    if (event.type === "CALL_END" && event.callId) {
      endedCallIdsRef.current.add(event.callId);
      availableCallsRef.current = availableCallsRef.current.filter((call) => call.callId !== event.callId);
      setAvailableCalls(availableCallsRef.current);
      if (incomingRef.current?.callId === event.callId || activeRef.current?.callId === event.callId) {
        void stopRecording();
        finishCall(false, "ended");
      }
      return;
    }
    if (event.type === "CALL_KICK" && event.callId) {
      if (event.targetUserId && event.targetUserId !== session.user.id) return;
      if (incomingRef.current?.callId === event.callId || activeRef.current?.callId === event.callId) {
        revokeAccess(event.reason === "access_revoked"
          ? "Seu acesso à chamada foi revogado."
          : "Você foi removido desta chamada.");
      }
      return;
    }
    if (event.callId && endedCallIdsRef.current.has(event.callId)) return;
    if (event.type === "CALL_INVITE" || event.type === "CALL_ACTIVE") {
      availableCallsRef.current = [...availableCallsRef.current.filter((call) => call.threadId !== event.threadId && call.callId !== event.callId), event];
      setAvailableCalls(availableCallsRef.current);
    }
    if (event.callId === activeRef.current?.callId) {
      receiveHands(event);
      if (event.type === "CALL_CHAT_MESSAGE" && event.message) { receiveMessages([event.message]); return; }
      if (event.type === "CALL_HAND_STATE") return;
    }
    if (!event.callId || !event.fromUserId || (event.fromUserId === session.user.id && event.type !== "CALL_END")) {
      if (event.type === "CALL_ERROR" && event.detail) setStatus(event.detail);
      return;
    }
    if (event.type === "CALL_INVITE" || event.type === "CALL_ACTIVE") {
      if (event.type === "CALL_ACTIVE" || dismissedInviteIdsRef.current.has(event.callId)) return;
      if (incomingRef.current?.callId === event.callId || activeRef.current?.callId === event.callId) return;
      if (activeRef.current) {
        if (event.type === "CALL_INVITE") {
          sendSocketEvent({
            type: "CALL_REJECT",
            callId: event.callId,
            mode: event.mode || "audio",
            scope: event.scope || "team",
            recipientId: event.recipientId || null,
            subteamId: event.subteamId || null,
          });
        }
        return;
      }
      const nextIncoming = incomingCallFromEvent(event, session.user.id);
      if (!nextIncoming) return;
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
    if (event.type === "CALL_MEDIA_STATE") {
      if (!event.screenSharing) announcedScreensRef.current.delete(event.fromUserId);
      setRemoteCameraEnabled((current) => ({ ...current, [event.fromUserId!]: event.cameraEnabled === true }));
      setRemoteScreenSharingIds((current) => event.screenSharing
        ? Array.from(new Set([...current, event.fromUserId!]))
        : current.filter((id) => id !== event.fromUserId));
      return;
    }
    if (event.type === "CALL_SCREEN_STARTED") {
      if (!announcedScreensRef.current.has(event.fromUserId)) { announcedScreensRef.current.add(event.fromUserId); playCallSound("screen"); }
      setRemoteScreenSharingIds((current) => current.includes(event.fromUserId as string) ? current : [...current, event.fromUserId as string]);
      setStatus(`${event.fromUserName || "Um participante"} está compartilhando a tela.`);
      await requestRemoteScreenRefresh(event.fromUserId);
      return;
    }
    if (event.type === "CALL_SCREEN_STOPPED") {
      announcedScreensRef.current.delete(event.fromUserId);
      const recoveryTimer = screenRecoveryTimersRef.current.get(event.fromUserId);
      if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer);
      screenRecoveryTimersRef.current.delete(event.fromUserId);
      setRemoteScreenSharingIds((current) => current.filter((item) => item !== event.fromUserId));
      setStatus(`${event.fromUserName || "Um participante"} encerrou o compartilhamento.`);
      return;
    }
    if (event.type === "CALL_ACCEPT") {
      publishMediaState();
      stopConnectingSound();
      playCallSound("joined");
      setStatus("Na chamada");
      await createPeer(event.fromUserId, true);
      if (activeRef.current?.callId === call.callId && screenStreamRef.current) {
        sendSocketEvent({ type: "CALL_SCREEN_STARTED", ...callPayload(call) });
      }
      return;
    }
    if (event.type === "CALL_SIGNAL" && event.signal) {
      const peer = await createPeer(event.fromUserId, false);
      if (!peer) return;
      if ("type" in event.signal && event.signal.type) {
        const description = event.signal as RTCSessionDescriptionInit;
        const negotiation = negotiationStateFor(event.fromUserId);
        const readyForOffer = !negotiation.makingOffer
          && (peer.signalingState === "stable" || negotiation.isSettingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;
        negotiation.ignoreOffer = !negotiation.polite && offerCollision;
        if (negotiation.ignoreOffer) return;
        if (offerCollision) {
          negotiation.revision += 1;
          negotiation.makingOffer = false;
        }
        negotiation.isSettingRemoteAnswerPending = description.type === "answer";
        try {
          if (offerCollision && negotiation.polite && peer.signalingState !== "stable") {
            await peer.setLocalDescription({ type: "rollback" });
          }
          await peer.setRemoteDescription(description);
        } finally {
          negotiation.isSettingRemoteAnswerPending = false;
        }
        if (peersRef.current.get(event.fromUserId) !== peer || activeRef.current?.callId !== call.callId) return;
        const pendingCandidates = pendingCandidatesRef.current.get(event.fromUserId) || [];
        for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate);
        pendingCandidatesRef.current.delete(event.fromUserId);
        if (description.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (peersRef.current.get(event.fromUserId) !== peer || activeRef.current?.callId !== call.callId) return;
          sendSocketEvent({
            type: "CALL_SIGNAL",
            ...callPayload(call),
            targetUserId: event.fromUserId,
            signal: peer.localDescription || answer,
          });
        }
      } else if ("candidate" in event.signal) {
        const negotiation = negotiationStateFor(event.fromUserId);
        if (negotiation.ignoreOffer) return;
        if (peer.remoteDescription) {
          try {
            await peer.addIceCandidate(event.signal as RTCIceCandidateInit);
          } catch (error) {
            if (!negotiation.ignoreOffer) throw error;
          }
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
      setRecordingUploadState("idle");
      setRecordingUploadedBytes(0);
      setRecordingPendingBytes(0);
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = window.setInterval(() => setRecordingElapsedSeconds((current) => current + 1), 1000);
      setStatus(`${event.fromUserName || "O organizador"} iniciou a gravacao.`);
      return;
    }
    if (event.type === "CALL_RECORDING_STOPPED") {
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      setRecording(false);
      setRecordingElapsedSeconds(0);
      setRecordingPendingBytes(0);
      if (event.reason === "failed" || event.reason === "expired") {
        setRecordingUploadState("failed");
        setStatus("A gravação foi interrompida pelo servidor.");
      } else {
        setRecordingUploadState("idle");
      }
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
      return;
    }
    if (event.type === "CALL_RECORDING_AVAILABLE") {
      setRecording(false);
      setRecordingElapsedSeconds(0);
      setRecordingUploadState("idle");
      setRecordingPendingBytes(0);
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
      setStatus("Gravacao disponivel no chat por 24 horas.");
      return;
    }
  }, [receiveHands, receiveMessages, syncMeetingChat, callPayload, closePeer, createPeer, finishCall, negotiationStateFor, publishMediaState, requestRemoteScreenRefresh, revokeAccess, sendSocketEvent, session.user.id, showReaction, startConnectingSound, stopConnectingSound, stopRecording, syncActiveCalls]);

  const toggleMute = useCallback(async () => {
    const currentAudio = localStreamRef.current?.getAudioTracks().find((track) => track.readyState !== "ended");
    if (!currentAudio && muted) {
      try {
        const stream = await acquireMedia({ microphoneMode: "on", cameraEnabled: false });
        const track = stream?.getAudioTracks()[0];
        if (!track) return;
        await Promise.all(Array.from(audioSendersRef.current.values()).map((sender) => sender.replaceTrack(track)));
        setListenOnly(false);
        setMuted(false);
        setStatus("Microfone ativado");
      } catch (error) {
        setStatus(mediaAccessError(error, "microfone"));
      }
      return;
    }
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }, [acquireMedia, muted]);

  const toggleCamera = useCallback(async () => {
    const epoch = mediaEpochRef.current;
    const currentStream = localStreamRef.current;
    if (!currentStream || !navigator.mediaDevices?.getUserMedia) {
      setStatus("Este navegador nao permite acessar a camera.");
      return;
    }
    if (cameraPermission !== "granted" && !(await requestCameraPermission())) return;
    if (epoch !== mediaEpochRef.current) return;
    const currentTrack = currentStream.getVideoTracks()[0];
    if (currentTrack && currentTrack.readyState !== "ended") {
      const enabling = !currentTrack.enabled;
      currentTrack.enabled = enabling;
      publishMediaState();
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
      if (epoch !== mediaEpochRef.current) {
        cameraStream.getTracks().forEach((track) => track.stop());
        return;
      }
      const cameraTrack = cameraStream.getVideoTracks()[0];
      if (!cameraTrack) throw new Error("A camera nao forneceu video.");
      cameraTrack.enabled = true;
      const baseStream = localStreamRef.current || currentStream;
      const nextStream = new MediaStream([...baseStream.getAudioTracks(), cameraTrack]);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      if (!screenStreamRef.current) await attachVideoTrack(cameraTrack, nextStream);
      if (epoch !== mediaEpochRef.current) return;
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
  }, [attachVideoTrack, cameraPermission, publishMediaState, refreshDevices, requestCameraPermission, selectedCameraId]);

  const stopScreenShare = useCallback(async () => {
    const activeScreen = screenStreamRef.current;
    if (!activeScreen) return;
    screenStreamRef.current = null;
    setScreenStream(null);
    setSharingScreen(false);
    publishMediaState();
    const call = activeRef.current;
    if (call) sendSocketEvent({ type: "CALL_SCREEN_STOPPED", ...callPayload(call) });
    await Promise.all(Array.from(screenAudioSendersRef.current.values()).map((sender) => sender.replaceTrack(null).catch(() => undefined)));
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
    activeScreen?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    await attachVideoTrack(cameraTrack?.enabled && cameraTrack.readyState !== "ended" ? cameraTrack : null, localStreamRef.current || activeScreen).catch(() => undefined);
    setStatus("Transmissão de tela encerrada");
  }, [attachVideoTrack, callPayload, publishMediaState, sendSocketEvent]);

  const changeScreenShare = useCallback(async () => {
    if (!activeRef.current || screenChangePendingRef.current) return;
    if (!navigator.mediaDevices?.getDisplayMedia) { setStatus("Compartilhamento de tela indisponível neste navegador."); return; }
    const epoch = mediaEpochRef.current;
    const previous = screenStreamRef.current;
    screenChangePendingRef.current = true;
    setScreenChangePending(true);
    let next: MediaStream | null = null;
    try {
      next = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: screenShareConstraints(screenShareQualityRef.current, screenShareFpsRef.current) });
      if (epoch !== mediaEpochRef.current) { next.getTracks().forEach((track) => track.stop()); return; }
      // If sharing stopped while the picker was open, do not resurrect it.
      if (previous && screenStreamRef.current !== previous) { next.getTracks().forEach((track) => track.stop()); return; }
      const screenTrack = next.getVideoTracks()[0];
      if (!screenTrack || screenTrack.readyState === "ended") throw new Error("A tela selecionada não forneceu vídeo.");
      screenTrack.contentHint = "detail";
      screenStreamRef.current = next;
      await Promise.all(Array.from(screenAudioSendersRef.current.values()).map((sender) => sender.replaceTrack(next!.getAudioTracks()[0] || null)));
      await attachVideoTrack(screenTrack, next);
      if (epoch !== mediaEpochRef.current) { next.getTracks().forEach((track) => track.stop()); return; }
      // Reuse the same senders and stop the previous capture only after replacement.
      previous?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      const selected = next;
      screenTrack.onended = () => { if (screenStreamRef.current === selected) void stopScreenShare(); };
      setScreenStream(next);
      setSharingScreen(true);
      publishMediaState();
      const call = activeRef.current;
      if (call && !previous) {
        playCallSound("screen");
        sendSocketEvent({ type: "CALL_SCREEN_STARTED", ...callPayload(call) });
      }
      setStatus(next.getAudioTracks().length ? "Transmitindo tela com som" : "Transmitindo sem som. Para incluir áudio, escolha uma aba e marque Compartilhar áudio no navegador.");
    } catch (error) {
      next?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      if (epoch !== mediaEpochRef.current) return;
      if (next) {
        screenStreamRef.current = previous;
        await Promise.all(Array.from(screenAudioSendersRef.current.values()).map((sender) => sender.replaceTrack(previous?.getAudioTracks()[0] || null).catch(() => undefined)));
        const camera = localStreamRef.current?.getVideoTracks().find((track) => track.enabled && track.readyState !== "ended") || null;
        await attachVideoTrack(previous?.getVideoTracks()[0] || camera, previous || localStreamRef.current || new MediaStream()).catch(() => undefined);
      }
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? (previous ? "Troca cancelada. A transmissão atual continua." : "Compartilhamento cancelado.") : mediaAccessError(error, "tela"));
    } finally { screenChangePendingRef.current = false; setScreenChangePending(false); }
  }, [attachVideoTrack, callPayload, publishMediaState, sendSocketEvent, stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) await stopScreenShare();
    else await changeScreenShare();
  }, [changeScreenShare, stopScreenShare]);

  const endCall = useCallback(async () => {
    const call = activeRef.current;
    if (!call) return;
    busyRef.current = true;
    setBusy(true);
    await stopRecording();
    endedCallIdsRef.current.add(call.callId);
    availableCallsRef.current = availableCallsRef.current.filter((item) => item.callId !== call.callId);
    setAvailableCalls(availableCallsRef.current);
    sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    finishCall(false, "ended");
    let endedByServer = false;
    if (call) {
      try {
        const response = await fetch(`${TEAM_CHAT_API}/calls/${encodeURIComponent(call.callId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.token}` },
          signal: AbortSignal.timeout(8000),
        });
        endedByServer = response.ok;
      } catch {
        // O WebSocket abaixo e o caminho de contingencia se a API estiver indisponivel.
      }
      if (!endedByServer) sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    }
    busyRef.current = false;
    setBusy(false);
    if (!endedByServer) setStatus("O encerramento foi enviado. Aguardando confirmação do servidor.");
  }, [callPayload, finishCall, sendSocketEvent, session.token, stopRecording]);

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
    availableCalls,
    busy,
    syncActiveCalls,
    localStream,
    remoteStreams,
    muted,
    listenOnly,
    microphonePermission,
    cameraOff,
    cameraPermission,
    sharingScreen,
    screenStream,
    previewStream,
    remoteScreenSharingIds,
    remoteCameraEnabled,
    callElapsedSeconds,
    recording,
    recordingElapsedSeconds,
    recordingUploadState,
    recordingUploadedBytes,
    recordingPendingBytes,
    recordingUploadProgress: recordingUploadedBytes + recordingPendingBytes > 0
      ? Math.round((recordingUploadedBytes / (recordingUploadedBytes + recordingPendingBytes)) * 100)
      : 0,
    connectionQuality,
    reactions,
    status,
    audioReady,
    ringtoneAudible,
    startCall,
    acceptIncoming,
    joinActiveCall,
    rejectIncoming,
    endCall,
    leaveCall,
    isHost: active?.hostUserId === session.user.id,
    startRecording,
    stopRecording,
    sendReaction,
    raisedHands,
    toggleHand,
    meetingMessages,
    sendMeetingMessage,
    changeScreenShare,
    screenChangePending,
    toggleMute,
    toggleCamera,
    requestCameraPermission,
    toggleScreenShare,
    handleSocketEvent,
    heartbeat,
    revokeAccess,
    devices,
    selectedMicrophoneId,
    selectedCameraId,
    selectedSpeakerId,
    screenShareQuality,
    screenShareFps,
    supportsSpeakerSelection: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
    selectMicrophone: (deviceId: string) => replaceInputDevice("audio", deviceId),
    selectCamera: (deviceId: string) => replaceInputDevice("video", deviceId),
    selectSpeaker: setSelectedSpeakerId,
    selectScreenShareQuality: (quality: ScreenShareQuality) => applyCurrentScreenShareProfile(quality, screenShareFpsRef.current),
    selectScreenShareFps: (fps: ScreenShareFps) => applyCurrentScreenShareProfile(screenShareQualityRef.current, fps),
    refreshDevices,
    prepareAudio,
    prepareCameraPreview,
  };
}
