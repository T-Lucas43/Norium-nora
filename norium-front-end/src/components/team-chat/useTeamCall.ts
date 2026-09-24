import { useCallback, useEffect, useRef, useState } from "react";
import "webrtc-adapter";
import type { AuthSession } from "../../types/auth";
import { apiBaseUrl } from "../../utils/api";
import { createMeetingRecording } from "./meetingRecording";
import {
  createCanvasBackgroundBlur,
  supportsCanvasBackgroundBlur,
  type BackgroundBlurPipeline,
} from "./backgroundBlur";
import { CallTelemetry } from "./callTelemetry";
import { prepareChatAttachments } from "./chatAttachments";
import {
  resolveMediaTransportFactory,
  type MediaTransport,
  type MediaTransportFailure,
  type MediaTransportFactory,
  type MediaTransportKind,
  type MediaTransportLocalMedia,
  type MediaTransportSnapshot,
} from "./media/MediaTransport";
import { MeshMediaTransportFactory } from "./media/MeshMediaTransport";

const TEAM_CHAT_API = `${apiBaseUrl()}/api/team-chat`;
const RECORDING_MAX_RETRIES = 3;
const RECORDING_BACKPRESSURE_BYTES = 24 * 1024 * 1024;
const RECORDING_BACKPRESSURE_CHUNKS = 3;
const ADMISSION_ACK_TIMEOUT_MS = 8000;

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
  code?: string;
  status?: number;
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
  joinedCount?: number;
  maxParticipants?: number;
  mediaTransport?: "mesh" | "sfu";
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
  mediaTransport: MediaTransportKind;
};

type PendingAdmission = {
  call: ActiveCall;
  event: "CALL_INVITE" | "CALL_ACCEPT";
  epoch: number;
  timeoutId: number | null;
  bufferedEvents: TeamCallSocketEvent[];
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
    mediaTransport: event.mediaTransport || "mesh",
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
const RELOAD_SESSION_KEY = "norium.team-call.reload";
const RELOAD_SESSION_TTL_MS = 5 * 60_000;
type ReloadSession = {
  userId: string;
  callId: string;
  clientId: string;
  savedAt: number;
  microphoneMode: CallMicrophoneMode;
  cameraEnabled: boolean;
  screenSharing?: boolean;
};

function readReloadSession(userId: string): ReloadSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RELOAD_SESSION_KEY) || "null") as ReloadSession | null;
    if (value?.userId === userId && typeof value.callId === "string" && value.callId
      && typeof value.clientId === "string" && value.clientId
      && Number.isFinite(value.savedAt) && Date.now() >= value.savedAt
      && Date.now() - value.savedAt < RELOAD_SESSION_TTL_MS
      && ["on", "muted", "listen-only"].includes(value.microphoneMode)
      && typeof value.cameraEnabled === "boolean") return value;
  } catch { /* A blocked session store must not prevent ordinary calls. */ }
  clearReloadSession();
  return null;
}

function clearReloadSession() {
  try { sessionStorage.removeItem(RELOAD_SESSION_KEY); } catch { /* Storage can be disabled. */ }
}

function writeReloadSession(value: ReloadSession) {
  try { sessionStorage.setItem(RELOAD_SESSION_KEY, JSON.stringify(value)); }
  catch { /* Storage can be disabled without ending the call. */ }
}

export type CallEntryOptions = {
  microphoneMode: CallMicrophoneMode;
  cameraEnabled: boolean;
};

const DEFAULT_ENTRY_OPTIONS: CallEntryOptions = {
  microphoneMode: "on",
  cameraEnabled: false,
};

type CallSound = "joined" | "left" | "screen";
type CameraPermission = "unknown" | "requesting" | "granted" | "denied" | "unavailable";
export type { IceTelemetrySnapshot } from "./media/MediaTransport";
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

type NoriumDisplayAudioConstraints = MediaTrackConstraints & {
  restrictOwnAudio?: boolean;
  suppressLocalAudioPlayback?: boolean;
};

type NoriumDisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  windowAudio?: "system" | "window" | "exclude";
};

const screenShareAudioConstraints: NoriumDisplayAudioConstraints = {
  // Remove do compartilhamento o áudio produzido pelo próprio Norium. Isso
  // impede que a voz recebida dos participantes volte para a reunião.
  restrictOwnAudio: true,
  suppressLocalAudioPlayback: false,
};

function screenShareCaptureOptions(quality: ScreenShareQuality, fps: ScreenShareFps): NoriumDisplayMediaOptions {
  return {
    audio: screenShareAudioConstraints,
    video: screenShareConstraints(quality, fps),
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
    windowAudio: "window",
  };
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
    joined: [[520, 0, 0.1], [660, 0.12, 0.1], [820, 0.24, 0.16]],
    left: [[520, 0, 0.12], [390, 0.16, 0.18]],
    screen: [[660, 0, 0.12], [990, 0.16, 0.22]],
  };
  const peakGain: Record<CallSound, number> = { joined: 0.2, left: 0.2, screen: 0.24 };
  const wave: Record<CallSound, OscillatorType> = { joined: "sine", left: "triangle", screen: "square" };
  try {
    const baseTime = context.currentTime + 0.01;
    for (const [frequency, offset, duration] of notes[sound]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = wave[sound];
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, baseTime + offset);
      gain.gain.exponentialRampToValueAtTime(peakGain[sound], baseTime + offset + 0.015);
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

export const SAFE_STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const EMPTY_MEDIA_TRANSPORT_SNAPSHOT: MediaTransportSnapshot = {
  state: "idle",
  failure: null,
  remoteStreams: [],
  connectionQuality: typeof navigator === "undefined" || navigator.onLine ? "good" : "offline",
  iceTelemetry: {
    lastState: "unknown",
    stateCounts: {},
    pathTypeCounts: {},
    lastSelectedPath: null,
    relayObserved: false,
  },
};

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
  iceServers = SAFE_STUN_SERVERS,
  iceTransportPolicy = "all",
  mediaTransports,
}: {
  session: AuthSession;
  thread: TeamCallThread;
  sendSocketEvent: (payload: Record<string, unknown>) => boolean;
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  mediaTransports?: readonly MediaTransportFactory[];
}) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [availableCalls, setAvailableCalls] = useState<TeamCallSocketEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const availableCallsRef = useRef<TeamCallSocketEvent[]>([]);
  const busyRef = useRef(false);
  const mediaEpochRef = useRef(0);
  const entryStartedRef = useRef(0);
  const telemetryRef = useRef<CallTelemetry | null>(null);
  const confirmedCallIdRef = useRef("");
  const endedCallIdsRef = useRef(new Set<string>());
  const dismissedInviteIdsRef = useRef(new Set<string>());
  const [reloadSession] = useState(() => readReloadSession(session.user.id));
  const reloadSessionRef = useRef(reloadSession);
  const clientIdRef = useRef(reloadSession?.clientId || crypto.randomUUID());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaTransportSnapshot, setMediaTransportSnapshot] = useState<MediaTransportSnapshot>(EMPTY_MEDIA_TRANSPORT_SNAPSHOT);
  const [mediaTransportKind, setMediaTransportKind] = useState<MediaTransportKind>("mesh");
  const [muted, setMuted] = useState(false);
  const [listenOnly, setListenOnly] = useState(false);
  const [microphonePermission, setMicrophonePermission] = useState<CameraPermission>("unknown");
  const [cameraOff, setCameraOff] = useState(true);
  const [cameraPermission, setCameraPermission] = useState<CameraPermission>("unknown");
  const reloadOptionsRef = useRef<CallEntryOptions>({ microphoneMode: "muted", cameraEnabled: false });
  reloadOptionsRef.current = {
    microphoneMode: listenOnly ? "listen-only" : muted ? "muted" : "on",
    cameraEnabled: !cameraOff,
  };
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
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; userName: string }>>([]);
  const [raisedHands, setRaisedHands] = useState<Record<string, string>>({});
  const handRevisionRef = useRef(-1);
  const [meetingMessages, setMeetingMessages] = useState<MeetingMessage[]>([]);
  const announcedScreensRef = useRef(new Set<string>());
  const announcedParticipantSessionsRef = useRef(new Set<string>());
  const screenChangePendingRef = useRef(false);
  const [screenChangePending, setScreenChangePending] = useState(false);
  const remoteMediaRef = useRef({ screenIds: remoteScreenSharingIds, cameras: remoteCameraEnabled });
  remoteMediaRef.current = { screenIds: remoteScreenSharingIds, cameras: remoteCameraEnabled };
  const [devices, setDevices] = useState<CallDevices>({ microphones: [], cameras: [], speakers: [] });
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [noiseSuppression, setNoiseSuppressionState] = useState(true);
  const [microphoneSensitivity, setMicrophoneSensitivityState] = useState(100);
  const [backgroundBlur, setBackgroundBlurState] = useState(false);
  const [screenShareQuality, setScreenShareQuality] = useState<ScreenShareQuality>("1080p");
  const [screenShareFps, setScreenShareFps] = useState<ScreenShareFps>(30);
  const activeRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const pendingAdmissionRef = useRef<PendingAdmission | null>(null);
  const handleSocketEventRef = useRef<(event: TeamCallSocketEvent) => Promise<void>>(async () => undefined);
  const localStreamRef = useRef<MediaStream | null>(null);
  const microphoneSourceStreamRef = useRef<MediaStream | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneGainRef = useRef<GainNode | null>(null);
  const noiseSuppressionRef = useRef(true);
  const microphoneSensitivityRef = useRef(100);
  const backgroundBlurRef = useRef(false);
  const backgroundBlurPipelinesRef = useRef(new Map<MediaStream, BackgroundBlurPipeline>());
  const mediaTransportRef = useRef<MediaTransport | null>(null);
  const mediaTransportCallIdRef = useRef("");
  const mediaTransportOpenRef = useRef<Promise<MediaTransport> | null>(null);
  const unsubscribeMediaTransportRef = useRef<(() => void) | null>(null);
  const iceConfigurationRef = useRef<RTCConfiguration>({});
  iceConfigurationRef.current = {
    iceServers,
    iceTransportPolicy,
    iceCandidatePoolSize: 4,
    bundlePolicy: "max-bundle",
  };
  const meshTransportFactoryRef = useRef<MediaTransportFactory | null>(null);
  if (!meshTransportFactoryRef.current) {
    meshTransportFactoryRef.current = new MeshMediaTransportFactory(() => iceConfigurationRef.current);
  }
  const mediaTransportFactoriesRef = useRef<readonly MediaTransportFactory[]>([]);
  const customMeshTransport = mediaTransports?.find((factory) => factory.kind === "mesh");
  mediaTransportFactoriesRef.current = [
    customMeshTransport || meshTransportFactoryRef.current,
    ...(mediaTransports || []).filter((factory) => factory.kind !== "mesh"),
  ];
  const screenStreamRef = useRef<MediaStream | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewRequestRef = useRef(0);
  const screenShareQualityRef = useRef<ScreenShareQuality>("1080p");
  const screenShareFpsRef = useRef<ScreenShareFps>(30);
  const remoteStreamsRef = useRef<Array<{ userId: string; stream: MediaStream }>>([]);
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
  const finishCallRef = useRef<(notify: boolean, sound?: CallSound | null, preserveReload?: boolean) => void>(() => undefined);

  const stopMicrophoneProcessing = useCallback(() => {
    microphoneSourceStreamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    microphoneSourceStreamRef.current = null;
    microphoneGainRef.current?.disconnect();
    microphoneGainRef.current = null;
    const context = microphoneAudioContextRef.current;
    microphoneAudioContextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  const processMicrophoneStream = useCallback((stream: MediaStream) => {
    const AudioContextClass = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass || !stream.getAudioTracks().length) return stream;
    stopMicrophoneProcessing();
    try {
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = microphoneSensitivityRef.current / 100;
      source.connect(gain).connect(destination);
      microphoneSourceStreamRef.current = stream;
      microphoneAudioContextRef.current = context;
      microphoneGainRef.current = gain;
      return destination.stream;
    } catch {
      stopMicrophoneProcessing();
      return stream;
    }
  }, [stopMicrophoneProcessing]);

  const releaseBackgroundBlur = useCallback((stream: MediaStream | null, restoreSource: boolean, stopSource = false) => {
    if (!stream) return false;
    const pipeline = backgroundBlurPipelinesRef.current.get(stream);
    if (!pipeline) return false;
    const wasEnabled = pipeline.outputTrack.enabled;
    backgroundBlurPipelinesRef.current.delete(stream);
    if (stream.getVideoTracks().includes(pipeline.outputTrack)) stream.removeTrack(pipeline.outputTrack);
    pipeline.stop(stopSource);
    if (restoreSource && pipeline.sourceTrack.readyState !== "ended") {
      pipeline.sourceTrack.enabled = wasEnabled;
      stream.addTrack(pipeline.sourceTrack);
    }
    return true;
  }, []);

  const rebindBackgroundBlur = useCallback((from: MediaStream, to: MediaStream) => {
    const pipeline = backgroundBlurPipelinesRef.current.get(from);
    if (!pipeline) return;
    backgroundBlurPipelinesRef.current.delete(from);
    backgroundBlurPipelinesRef.current.set(to, pipeline);
  }, []);

  const applyBackgroundBlur = useCallback(async (enabled: boolean, streams: Array<MediaStream | null>) => {
    const uniqueStreams = [...new Set(streams.filter((stream): stream is MediaStream => Boolean(stream)))];
    const nativeSupport = navigator.mediaDevices?.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { backgroundBlur?: boolean }) | undefined;
    const constraints = { advanced: [{ backgroundBlur: enabled }] } as unknown as MediaTrackConstraints;

    if (!enabled) {
      const restored = uniqueStreams.reduce((changed, stream) => releaseBackgroundBlur(stream, true) || changed, false);
      const tracks = uniqueStreams.flatMap((stream) => stream.getVideoTracks());
      if (nativeSupport?.backgroundBlur && tracks.length) {
        await Promise.all(tracks.map((track) => track.applyConstraints(constraints)));
        return true;
      }
      return restored;
    }

    const tracks = uniqueStreams.flatMap((stream) => stream.getVideoTracks());
    if (!tracks.length) return false;
    if (nativeSupport?.backgroundBlur) {
      try {
        await Promise.all(tracks.map((track) => track.applyConstraints(constraints)));
        return true;
      } catch {
        // Algumas câmeras anunciam a restrição, mas recusam sua aplicação.
      }
    }
    if (!supportsCanvasBackgroundBlur()) return false;

    const created: Array<{ stream: MediaStream; pipeline: BackgroundBlurPipeline }> = [];
    try {
      for (const stream of uniqueStreams) {
        if (backgroundBlurPipelinesRef.current.has(stream)) continue;
        const sourceTrack = stream.getVideoTracks()[0];
        if (!sourceTrack) continue;
        const pipeline = await createCanvasBackgroundBlur(sourceTrack);
        pipeline.outputTrack.enabled = sourceTrack.enabled;
        stream.removeTrack(sourceTrack);
        stream.addTrack(pipeline.outputTrack);
        backgroundBlurPipelinesRef.current.set(stream, pipeline);
        created.push({ stream, pipeline });
      }
      return created.length > 0 || uniqueStreams.every((stream) => backgroundBlurPipelinesRef.current.has(stream));
    } catch (error) {
      created.forEach(({ stream, pipeline }) => {
        if (stream.getVideoTracks().includes(pipeline.outputTrack)) stream.removeTrack(pipeline.outputTrack);
        pipeline.stop();
        if (pipeline.sourceTrack.readyState !== "ended") stream.addTrack(pipeline.sourceTrack);
        backgroundBlurPipelinesRef.current.delete(stream);
      });
      throw error;
    }
  }, [releaseBackgroundBlur]);

  useEffect(() => {
    mediaTransportRef.current?.updateIce(iceConfigurationRef.current);
  }, [iceServers, iceTransportPolicy]);

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
    remoteStreamsRef.current = mediaTransportSnapshot.remoteStreams;
  }, [mediaTransportSnapshot.remoteStreams]);

  const showReaction = useCallback((emoji: string, userName: string) => {
    const id = crypto.randomUUID();
    setReactions((current) => [...current.slice(-7), { id, emoji, userName }]);
    reactionTimersRef.current.push(window.setTimeout(() => {
      setReactions((current) => current.filter((reaction) => reaction.id !== id));
    }, 4200));
  }, []);

  const stopConnectingSound = useCallback(() => {
    setRingtoneAudible(false);
  }, []);

  const prepareAudio = useCallback(async () => {
    const ready = await prepareCallAudio();
    setAudioReady(ready);
    return ready;
  }, []);

  const startConnectingSound = useCallback(() => {
    // Chamadas não reproduzem toque contínuo. Alertas sonoros são reservados
    // a eventos curtos: entrada, saída e início de compartilhamento de tela.
    stopConnectingSound();
  }, [stopConnectingSound]);

  const callPayload = useCallback((call: ActiveCall) => ({
    callId: call.callId,
    clientId: clientIdRef.current,
    mode: call.mode,
    scope: call.thread.scope,
    recipientId: call.thread.recipientId || null,
    subteamId: call.thread.subteamId || null,
  }), []);

  const clearPendingAdmission = useCallback((expected?: PendingAdmission) => {
    const pending = pendingAdmissionRef.current;
    if (!pending || (expected && pending !== expected)) return;
    if (pending.timeoutId !== null) window.clearTimeout(pending.timeoutId);
    pendingAdmissionRef.current = null;
  }, []);

  const compensateServerAdmission = useCallback((call: ActiveCall) => {
    sendSocketEvent({
      type: call.hostUserId === session.user.id ? "CALL_END" : "CALL_LEAVE",
      ...callPayload(call),
    });
  }, [callPayload, sendSocketEvent, session.user.id]);

  const abandonAdmission = useCallback((
    pending: PendingAdmission,
    detail: string,
    compensate: boolean,
  ) => {
    if (pendingAdmissionRef.current !== pending) return;
    clearPendingAdmission(pending);
    if (compensate) compensateServerAdmission(pending.call);
    finishCallRef.current(false);
    setStatus(detail);
  }, [clearPendingAdmission, compensateServerAdmission]);

  const beginAdmission = useCallback((
    call: ActiveCall,
    event: PendingAdmission["event"],
    epoch: number,
  ) => {
    clearPendingAdmission();
    const pending: PendingAdmission = {
      call,
      event,
      epoch,
      timeoutId: null,
      bufferedEvents: [],
    };
    pendingAdmissionRef.current = pending;
    pending.timeoutId = window.setTimeout(() => {
      abandonAdmission(
        pending,
        "Não foi possível confirmar sua entrada na chamada. Tente novamente.",
        true,
      );
    }, ADMISSION_ACK_TIMEOUT_MS);
    if (!sendSocketEvent({ type: event, ...callPayload(call) })) {
      clearPendingAdmission(pending);
      throw new Error(event === "CALL_INVITE"
        ? "A conexão em tempo real ainda não está pronta."
        : "A conexão da reunião foi interrompida. Tente ingressar novamente.");
    }
  }, [abandonAdmission, callPayload, clearPendingAdmission, sendSocketEvent]);

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
    if (!call || confirmedCallIdRef.current !== call.callId) return;
    sendSocketEvent({ type: "CALL_MEDIA_STATE", ...callPayload(call),
      cameraEnabled: !!localStreamRef.current?.getVideoTracks().some((track) => track.enabled && track.readyState !== "ended"),
      screenSharing: !!screenStreamRef.current,
    });
  }, [callPayload, sendSocketEvent]);

  useEffect(() => { if (active) publishMediaState(); }, [active, cameraOff, sharingScreen, publishMediaState]);

  const transportMedia = useCallback((
    outgoingVideoTrack?: MediaStreamTrack | null,
    outgoingVideoStream?: MediaStream | null,
  ): MediaTransportLocalMedia => ({
    localStream: localStreamRef.current,
    screenStream: screenStreamRef.current,
    ...(outgoingVideoTrack !== undefined ? { outgoingVideoTrack } : {}),
    ...(outgoingVideoStream !== undefined ? { outgoingVideoStream } : {}),
    screenShareQuality: screenShareQualityRef.current,
    screenShareFps: screenShareFpsRef.current,
  }), []);

  const closeMediaTransport = useCallback(() => {
    const transport = mediaTransportRef.current;
    const unsubscribe = unsubscribeMediaTransportRef.current;
    mediaTransportRef.current = null;
    mediaTransportCallIdRef.current = "";
    mediaTransportOpenRef.current = null;
    unsubscribeMediaTransportRef.current = null;
    try {
      const closing = transport?.close();
      if (closing) void closing.catch(() => undefined);
    } catch {
      // A falha de um adapter não pode impedir a limpeza da captura local.
    }
    try {
      unsubscribe?.();
    } catch {
      // Listeners externos também não podem bloquear a limpeza da sessão.
    }
    remoteStreamsRef.current = [];
    setMediaTransportSnapshot(EMPTY_MEDIA_TRANSPORT_SNAPSHOT);
    setMediaTransportKind("mesh");
  }, []);

  const ensureMediaTransport = useCallback(async (call: ActiveCall) => {
    if (mediaTransportRef.current && mediaTransportCallIdRef.current === call.callId) {
      return mediaTransportOpenRef.current
        ? await mediaTransportOpenRef.current
        : mediaTransportRef.current;
    }
    closeMediaTransport();
    const factory = resolveMediaTransportFactory(call.mediaTransport, mediaTransportFactoriesRef.current);
    const telemetry = new CallTelemetry((sample) => {
      if (activeRef.current?.callId !== call.callId) return true;
      return sendSocketEvent({ type: "CALL_TELEMETRY", callId: call.callId,
        clientId: clientIdRef.current, ...sample });
    }, entryStartedRef.current);
    telemetryRef.current = telemetry;
    const transport = factory.create({
      emitSignal: (callId, targetUserId, signal) => {
        const current = activeRef.current;
        if (!current || current.callId !== callId) return false;
        return sendSocketEvent({
          type: "CALL_SIGNAL",
          ...callPayload(current),
          targetUserId,
          signal,
        });
      },
      onConnected: () => { telemetry.connected(); publishMediaState(); },
      onStatus: setStatus,
      onTerminated: (failure: MediaTransportFailure) => {
        const current = activeRef.current;
        if (!current || current.callId !== call.callId) return;
        telemetry.failure(factory.kind);
        compensateServerAdmission(current);
        finishCallRef.current(false);
        setStatus(failure.detail);
      },
    });
    mediaTransportRef.current = transport;
    mediaTransportCallIdRef.current = call.callId;
    setMediaTransportKind(factory.kind);
    unsubscribeMediaTransportRef.current = transport.subscribe((snapshot) => {
      telemetry.observe(snapshot, factory.kind);
      remoteStreamsRef.current = snapshot.remoteStreams;
      setMediaTransportSnapshot(snapshot);
    });
    transport.updateIce(iceConfigurationRef.current);
    const opening = (async () => {
      await transport.open({
        callId: call.callId,
        selfUserId: session.user.id,
        clientId: clientIdRef.current,
      }, transportMedia());
      if (mediaTransportRef.current !== transport
        || mediaTransportCallIdRef.current !== call.callId
        || activeRef.current?.callId !== call.callId) {
        await transport.close().catch(() => undefined);
        throw new Error("A chamada foi encerrada durante a conexão da mídia.");
      }
      return transport;
    })();
    mediaTransportOpenRef.current = opening;
    try {
      return await opening;
    } catch (error) {
      telemetry.failure(factory.kind);
      if (mediaTransportRef.current === transport) closeMediaTransport();
      throw error;
    } finally {
      if (mediaTransportOpenRef.current === opening) mediaTransportOpenRef.current = null;
    }
  }, [callPayload, closeMediaTransport, compensateServerAdmission, publishMediaState, sendSocketEvent, session.user.id, transportMedia]);

  const stopMedia = useCallback(() => {
    previewRequestRef.current += 1;
    releaseBackgroundBlur(previewStreamRef.current, false, true);
    previewStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    previewStreamRef.current = null;
    setPreviewStream(null);
    screenStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screenStreamRef.current = null;
    setScreenStream(null);
    releaseBackgroundBlur(localStreamRef.current, false, true);
    localStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    localStreamRef.current = null;
    setLocalStream(null);
    stopMicrophoneProcessing();
    setSharingScreen(false);
  }, [releaseBackgroundBlur, stopMicrophoneProcessing]);

  const finishCall = useCallback((notify: boolean, sound: CallSound | null = null, preserveReload = false) => {
    if (!preserveReload) {
      reloadSessionRef.current = null;
      clearReloadSession();
    }
    const call = activeRef.current;
    telemetryRef.current = null;
    clearPendingAdmission();
    mediaEpochRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    confirmedCallIdRef.current = "";
    setMeetingMessages([]);
    setRaisedHands({});
    handRevisionRef.current = -1;
    announcedScreensRef.current.clear();
    announcedParticipantSessionsRef.current.clear();
    if (notify && call) sendSocketEvent({ type: "CALL_END", ...callPayload(call) });
    stopConnectingSound();
    closeMediaTransport();
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
    if (sound) playCallSound(sound);
    setStatus("");
  }, [callPayload, clearPendingAdmission, closeMediaTransport, sendSocketEvent, stopConnectingSound, stopMedia]);

  finishCallRef.current = finishCall;

  const completeAdmission = useCallback(async (event: TeamCallSocketEvent) => {
    const pending = pendingAdmissionRef.current;
    if (
      !pending
      || event.callId !== pending.call.callId
      || event.event !== pending.event
    ) {
      return false;
    }
    if (event.mediaTransport !== "mesh" && event.mediaTransport !== "sfu") {
      abandonAdmission(
        pending,
        "O servidor não confirmou o transporte de mídia da chamada.",
        true,
      );
      return true;
    }

    clearPendingAdmission(pending);
    const current = activeRef.current;
    if (
      !current
      || current.callId !== pending.call.callId
      || pending.epoch !== mediaEpochRef.current
    ) {
      return true;
    }
    const admittedCall: ActiveCall = {
      ...current,
      mediaTransport: event.mediaTransport,
    };
    activeRef.current = admittedCall;
    setActive(admittedCall);
    confirmedCallIdRef.current = admittedCall.callId;
    writeReloadSession({
      userId: session.user.id,
      callId: admittedCall.callId,
      clientId: clientIdRef.current,
      savedAt: Date.now(),
      ...reloadOptionsRef.current,
      screenSharing: !!screenStreamRef.current,
    });

    try {
      await ensureMediaTransport(admittedCall);
      if (
        activeRef.current?.callId !== admittedCall.callId
        || pending.epoch !== mediaEpochRef.current
      ) {
        return true;
      }
      if (pending.event === "CALL_ACCEPT") {
        dismissedInviteIdsRef.current.add(admittedCall.callId);
        stopConnectingSound();
        playCallSound("joined");
        setStatus("Na chamada");
      }
      for (const bufferedEvent of pending.bufferedEvents) {
        await handleSocketEventRef.current(bufferedEvent);
      }
    } catch (error) {
      if (activeRef.current?.callId === admittedCall.callId) {
        compensateServerAdmission(admittedCall);
        finishCall(false);
        setStatus(error instanceof Error
          ? error.message
          : "Não foi possível conectar a mídia da chamada.");
      }
    }
    return true;
  }, [
    abandonAdmission,
    clearPendingAdmission,
    compensateServerAdmission,
    ensureMediaTransport,
    finishCall,
    stopConnectingSound,
    session.user.id,
  ]);

  useEffect(() => {
    if (!active || confirmedCallIdRef.current !== active.callId) return;
    writeReloadSession({
      userId: session.user.id,
      callId: active.callId,
      clientId: clientIdRef.current,
      savedAt: Date.now(),
      ...reloadOptionsRef.current,
      screenSharing: sharingScreen,
    });
  }, [active, cameraOff, listenOnly, muted, sharingScreen, session.user.id]);

  useEffect(() => {
    if (!active || !sharingScreen) return undefined;
    const protectActiveScreenShare = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectActiveScreenShare);
    return () => window.removeEventListener("beforeunload", protectActiveScreenShare);
  }, [active, sharingScreen]);

  useEffect(() => {
    const preserveOnReload = () => {
      const call = activeRef.current;
      if (call && confirmedCallIdRef.current === call.callId) {
        writeReloadSession({
          userId: session.user.id, callId: call.callId, clientId: clientIdRef.current,
          savedAt: Date.now(), ...reloadOptionsRef.current, screenSharing: !!screenStreamRef.current,
        });
      }
      leaveOnClose();
    };
    const leaveOnClose = () => {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      finishCallRef.current(false, null, true);
    };
    window.addEventListener("pagehide", preserveOnReload);
    return () => { window.removeEventListener("pagehide", preserveOnReload); leaveOnClose(); };
  }, [session.user.id]);

  const heartbeat = useCallback(() => {
    const call = activeRef.current;
    const sent = call && confirmedCallIdRef.current === call.callId
      ? sendSocketEvent({ type: "CALL_HEARTBEAT", ...callPayload(call) })
      : false;
    if (sent) telemetryRef.current?.flush();
    return sent;
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
    releaseBackgroundBlur(previewStreamRef.current, false, true);
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
      if (backgroundBlurRef.current) await applyBackgroundBlur(true, [stream]).catch(() => false);
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
  }, [applyBackgroundBlur, releaseBackgroundBlur, selectedCameraId]);

  const configureNoiseSuppression = useCallback(async (enabled: boolean) => {
    noiseSuppressionRef.current = enabled;
    setNoiseSuppressionState(enabled);
    const track = microphoneSourceStreamRef.current?.getAudioTracks()[0]
      || localStreamRef.current?.getAudioTracks()[0];
    if (!track?.applyConstraints) return true;
    try {
      await track.applyConstraints({ echoCancellation: true, noiseSuppression: enabled, autoGainControl: true });
      setStatus(enabled ? "Supressão de ruído ativada" : "Supressão de ruído desativada");
      return true;
    } catch {
      setStatus("O navegador não conseguiu alterar a supressão de ruído deste microfone.");
      return false;
    }
  }, []);

  const configureMicrophoneSensitivity = useCallback((value: number) => {
    const next = Math.max(50, Math.min(150, Math.round(value)));
    microphoneSensitivityRef.current = next;
    setMicrophoneSensitivityState(next);
    const context = microphoneAudioContextRef.current;
    const gain = microphoneGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(next / 100, context.currentTime, 0.03);
  }, []);

  const configureBackgroundBlur = useCallback(async (enabled: boolean) => {
    const applied = await applyBackgroundBlur(enabled, [previewStreamRef.current, localStreamRef.current]).catch(() => false);
    if (!applied) {
      setStatus("O desfoque de fundo não está disponível neste navegador ou câmera.");
      return false;
    }
    backgroundBlurRef.current = enabled;
    setBackgroundBlurState(enabled);
    if (previewStreamRef.current) setPreviewStream(new MediaStream(previewStreamRef.current.getTracks()));
    if (localStreamRef.current) {
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      await mediaTransportRef.current?.updateLocalMedia(transportMedia()).catch(() => undefined);
    }
    setStatus(enabled ? "Desfoque de fundo ativado" : "Desfoque de fundo desativado");
    return true;
  }, [applyBackgroundBlur, transportMedia]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return undefined;
    const handleDeviceChange = () => { void refreshDevices(); };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshDevices]);

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
        noiseSuppression: noiseSuppressionRef.current,
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
            audio: { echoCancellation: true, noiseSuppression: noiseSuppressionRef.current, autoGainControl: true },
            video: false,
          });
        } catch (fallbackError) {
          const fallbackName = fallbackError instanceof DOMException ? fallbackError.name : "";
          setMicrophonePermission(["NotAllowedError", "SecurityError"].includes(fallbackName) ? "denied" : "unavailable");
          throw fallbackError;
        }
      }
      setMicrophonePermission("granted");
      audioStream = processMicrophoneStream(audioStream);
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
          if (backgroundBlurRef.current) await applyBackgroundBlur(true, [cameraStream]).catch(() => false);
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
    if (cameraStream && stream !== cameraStream) rebindBackgroundBlur(cameraStream, stream);
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
  }, [applyBackgroundBlur, prepareCameraPreview, processMicrophoneStream, rebindBackgroundBlur, refreshDevices, selectedCameraId, selectedMicrophoneId]);

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
      let replacementStream = await navigator.mediaDevices.getUserMedia(kind === "audio"
        ? { audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: noiseSuppressionRef.current, autoGainControl: true }, video: false }
        : { audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (epoch !== mediaEpochRef.current) {
        replacementStream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (kind === "audio") replacementStream = processMicrophoneStream(replacementStream);
      else if (backgroundBlurRef.current) await applyBackgroundBlur(true, [replacementStream]).catch(() => false);
      const replacementTrack = kind === "audio" ? replacementStream.getAudioTracks()[0] : replacementStream.getVideoTracks()[0];
      if (!replacementTrack) throw new Error("O dispositivo selecionado nao forneceu midia.");
      replacementTrack.enabled = kind === "audio" ? !muted : !cameraOff;
      if (kind === "audio" && "contentHint" in replacementTrack) replacementTrack.contentHint = "speech";

      if (epoch !== mediaEpochRef.current) {
        replacementStream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (kind === "video") releaseBackgroundBlur(currentStream, false, true);
      currentStream.getTracks().filter((track) => track.kind === kind).forEach((track) => { track.onended = null; track.stop(); });
      const nextStream = new MediaStream([
        ...currentStream.getTracks().filter((track) => track.kind !== kind),
        replacementTrack,
      ]);
      if (kind === "video") rebindBackgroundBlur(replacementStream, nextStream);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      await mediaTransportRef.current?.updateLocalMedia(transportMedia());
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
  }, [applyBackgroundBlur, cameraOff, muted, processMicrophoneStream, rebindBackgroundBlur, releaseBackgroundBlur, transportMedia]);

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

  const attachVideoTrack = useCallback(async (track: MediaStreamTrack | null, sourceStream: MediaStream) => {
    await mediaTransportRef.current?.updateLocalMedia(transportMedia(track, sourceStream));
  }, [transportMedia]);

  const applyCurrentScreenShareProfile = useCallback(async (quality: ScreenShareQuality, fps: ScreenShareFps) => {
    screenShareQualityRef.current = quality;
    screenShareFpsRef.current = fps;
    setScreenShareQuality(quality);
    setScreenShareFps(fps);
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
    if (screenTrack?.readyState === "live" && typeof screenTrack.applyConstraints === "function") {
      await screenTrack.applyConstraints(screenShareConstraints(quality, fps)).catch(() => undefined);
    }
    if (screenTrack) await mediaTransportRef.current?.updateScreenProfile(quality, fps);
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
    entryStartedRef.current = performance.now();
    try {
      resolveMediaTransportFactory(pendingCall.mediaTransport, mediaTransportFactoriesRef.current);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "O transporte de mídia desta chamada não está disponível.");
      return false;
    }
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
      setStatus("Aguardando autorização para entrar...");
      beginAdmission(call, "CALL_ACCEPT", epoch);
      return true;
    } catch (error) {
      if (epoch !== mediaEpochRef.current) return false;
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
      return false;
    } finally {
      if (epoch === mediaEpochRef.current) { busyRef.current = false; setBusy(false); }
    }
  }, [acquireMedia, beginAdmission, finishCall, startConnectingSound]);

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
    entryStartedRef.current = performance.now();
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
        mediaTransport: "mesh",
      };
      activeRef.current = call;
      setActive(call);
      setIncoming(null);
      incomingRef.current = null;
      setStatus(targetThread.scope === "direct" ? "Chamando participante..." : "Chamando a equipe...");
      startConnectingSound();
      beginAdmission(call, "CALL_INVITE", epoch);
      return true;
    } catch (error) {
      if (epoch !== mediaEpochRef.current) return false;
      finishCall(false);
      setStatus(mediaAccessError(error, "microfone"));
      return false;
    } finally {
      if (epoch === mediaEpochRef.current) { busyRef.current = false; setBusy(false); }
    }
  }, [acquireMedia, beginAdmission, finishCall, joinActiveCall, session.user.id, startConnectingSound, thread]);

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
      const saved = reloadSessionRef.current;
      if (saved) {
        reloadSessionRef.current = null;
        clearReloadSession();
        const resumable = event.calls?.find((call) => call.callId === saved.callId);
        if (resumable && saved.userId === session.user.id && Date.now() - saved.savedAt < RELOAD_SESSION_TTL_MS) {
          await joinActiveCall(resumable, { microphoneMode: saved.microphoneMode, cameraEnabled: saved.cameraEnabled });
          if (saved.screenSharing) setStatus("Ligação retomada. Por segurança do navegador, escolha novamente a tela para continuar a transmissão.");
        }
      }
      const current = event.calls?.find((call) => call.callId === activeRef.current?.callId);
      if (current) { receiveHands(current); if (confirmedCallIdRef.current) void syncMeetingChat(); }
      return;
    }
    if (event.type === "CALL_ACK") {
      const admitted = await completeAdmission(event);
      if (admitted && (event.event === "CALL_INVITE" || event.event === "CALL_ACCEPT")) {
        void syncMeetingChat();
      }
      return;
    }
    if (event.type === "CALL_ERROR") {
      const pending = pendingAdmissionRef.current;
      if (pending && event.callId === pending.call.callId) {
        abandonAdmission(
          pending,
          event.detail || "Não foi possível entrar na chamada.",
          false,
        );
        return;
      }
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
        finishCall(false);
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
    const pending = pendingAdmissionRef.current;
    if (
      pending?.call.callId === call.callId
      && [
        "CALL_ACCEPT",
        "CALL_SIGNAL",
        "CALL_MEDIA_STATE",
        "CALL_SCREEN_STARTED",
        "CALL_SCREEN_STOPPED",
        "CALL_LEAVE",
      ].includes(event.type)
    ) {
      pending.bufferedEvents.push(event);
      return;
    }
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
      await (await ensureMediaTransport(call)).receive({
        type: "screen-started", callId: call.callId, userId: event.fromUserId, clientId: event.clientId,
      });
      return;
    }
    if (event.type === "CALL_SCREEN_STOPPED") {
      announcedScreensRef.current.delete(event.fromUserId);
      setRemoteScreenSharingIds((current) => current.filter((item) => item !== event.fromUserId));
      setStatus(`${event.fromUserName || "Um participante"} encerrou o compartilhamento.`);
      await (await ensureMediaTransport(call)).receive({
        type: "screen-stopped", callId: call.callId, userId: event.fromUserId, clientId: event.clientId,
      });
      return;
    }
    if (event.type === "CALL_ACCEPT") {
      publishMediaState();
      stopConnectingSound();
      const participantSession = `${event.fromUserId || "participante"}:${event.clientId || "principal"}`;
      if (!announcedParticipantSessionsRef.current.has(participantSession)) {
        announcedParticipantSessionsRef.current.add(participantSession);
        playCallSound("joined");
      }
      setStatus("Na chamada");
      await (await ensureMediaTransport(call)).receive({
        type: "participant-joined", callId: call.callId, userId: event.fromUserId, clientId: event.clientId,
      });
      if (activeRef.current?.callId === call.callId && screenStreamRef.current) {
        sendSocketEvent({ type: "CALL_SCREEN_STARTED", ...callPayload(call) });
      }
      return;
    }
    if (event.type === "CALL_SIGNAL" && event.signal) {
      await (await ensureMediaTransport(call)).receive({
        type: "signal", callId: call.callId, userId: event.fromUserId, clientId: event.clientId, signal: event.signal,
      });
      return;
    }
    if (event.type === "CALL_REJECT") {
      if (call.thread.scope === "direct") stopConnectingSound();
      setStatus(`${event.fromUserName || "Um participante"} recusou a chamada.`);
      return;
    }
    if (event.type === "CALL_LEAVE") {
      await (await ensureMediaTransport(call)).receive({
        type: "participant-left", callId: call.callId, userId: event.fromUserId, clientId: event.clientId,
      });
      setRemoteCameraEnabled((current) => { const next = { ...current }; delete next[event.fromUserId!]; return next; });
      setRemoteScreenSharingIds((current) => current.filter((item) => item !== event.fromUserId));
      const participantPrefix = `${event.fromUserId || "participante"}:`;
      const participantSessions = [...announcedParticipantSessionsRef.current].filter((item) => item.startsWith(participantPrefix));
      participantSessions.forEach((item) => announcedParticipantSessionsRef.current.delete(item));
      if (participantSessions.length) playCallSound("left");
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
  }, [abandonAdmission, completeAdmission, receiveHands, receiveMessages, syncMeetingChat, callPayload, ensureMediaTransport, finishCall, joinActiveCall, publishMediaState, revokeAccess, sendSocketEvent, session.user.id, showReaction, startConnectingSound, stopConnectingSound, stopRecording, syncActiveCalls]);

  handleSocketEventRef.current = handleSocketEvent;

  const toggleMute = useCallback(async () => {
    const currentAudio = localStreamRef.current?.getAudioTracks().find((track) => track.readyState !== "ended");
    if (!currentAudio && muted) {
      try {
        const stream = await acquireMedia({ microphoneMode: "on", cameraEnabled: false });
        const track = stream?.getAudioTracks()[0];
        if (!track) return;
        await mediaTransportRef.current?.updateLocalMedia(transportMedia());
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
  }, [acquireMedia, muted, transportMedia]);

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
      releaseBackgroundBlur(currentStream, false, true);
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
      if (backgroundBlurRef.current) await applyBackgroundBlur(true, [cameraStream]);
      const cameraTrack = cameraStream.getVideoTracks()[0];
      if (!cameraTrack) throw new Error("A camera nao forneceu video.");
      cameraTrack.enabled = true;
      const baseStream = localStreamRef.current || currentStream;
      const nextStream = new MediaStream([...baseStream.getAudioTracks(), cameraTrack]);
      rebindBackgroundBlur(cameraStream, nextStream);
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
  }, [applyBackgroundBlur, attachVideoTrack, cameraPermission, publishMediaState, rebindBackgroundBlur, refreshDevices, releaseBackgroundBlur, requestCameraPermission, selectedCameraId]);

  const stopScreenShare = useCallback(async () => {
    const activeScreen = screenStreamRef.current;
    if (!activeScreen) return;
    screenStreamRef.current = null;
    setScreenStream(null);
    setSharingScreen(false);
    publishMediaState();
    const call = activeRef.current;
    if (call) sendSocketEvent({ type: "CALL_SCREEN_STOPPED", ...callPayload(call) });
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
      next = await navigator.mediaDevices.getDisplayMedia(screenShareCaptureOptions(screenShareQualityRef.current, screenShareFpsRef.current));
      if (epoch !== mediaEpochRef.current) { next.getTracks().forEach((track) => track.stop()); return; }
      // If sharing stopped while the picker was open, do not resurrect it.
      if (previous && screenStreamRef.current !== previous) { next.getTracks().forEach((track) => track.stop()); return; }
      const screenTrack = next.getVideoTracks()[0];
      if (!screenTrack || screenTrack.readyState === "ended") throw new Error("A tela selecionada não forneceu vídeo.");
      screenTrack.contentHint = "detail";
      const screenAudioTrack = next.getAudioTracks()[0];
      if (screenAudioTrack) {
        screenAudioTrack.contentHint = "music";
        if (typeof screenAudioTrack.applyConstraints === "function") {
          await screenAudioTrack.applyConstraints(screenShareAudioConstraints).catch(() => undefined);
        }
      }
      screenStreamRef.current = next;
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
    finishCall(false);
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
    finishCall(false);
  }, [callPayload, finishCall, sendSocketEvent, stopRecording]);

  const sendReaction = useCallback((emoji: string) => {
    const call = activeRef.current;
    if (!call || !["👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"].includes(emoji)) return;
    showReaction(emoji, session.user.nome || "Voce");
    sendSocketEvent({ type: "CALL_REACTION", ...callPayload(call), emoji });
  }, [callPayload, sendSocketEvent, session.user.nome, showReaction]);

  return {
    clientId: clientIdRef.current,
    incoming,
    active,
    availableCalls,
    busy,
    syncActiveCalls,
    localStream,
    remoteStreams: mediaTransportSnapshot.remoteStreams,
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
    connectionQuality: mediaTransportSnapshot.connectionQuality,
    iceTelemetry: mediaTransportSnapshot.iceTelemetry,
    mediaTransport: mediaTransportKind,
    mediaTransportState: mediaTransportSnapshot.state,
    mediaTransportFailure: mediaTransportSnapshot.failure,
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
    telemetrySocketLost: () => telemetryRef.current?.reconnecting("socket"),
    telemetrySocketRestored: () => telemetryRef.current?.recovered("socket"),
    revokeAccess,
    devices,
    selectedMicrophoneId,
    selectedCameraId,
    selectedSpeakerId,
    noiseSuppression,
    microphoneSensitivity,
    backgroundBlur,
    supportsBackgroundBlur: Boolean((navigator.mediaDevices?.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { backgroundBlur?: boolean }) | undefined)?.backgroundBlur)
      || supportsCanvasBackgroundBlur(),
    screenShareQuality,
    screenShareFps,
    supportsSpeakerSelection: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
    selectMicrophone: (deviceId: string) => replaceInputDevice("audio", deviceId),
    selectCamera: (deviceId: string) => replaceInputDevice("video", deviceId),
    selectSpeaker: setSelectedSpeakerId,
    setNoiseSuppression: configureNoiseSuppression,
    setMicrophoneSensitivity: configureMicrophoneSensitivity,
    setBackgroundBlur: configureBackgroundBlur,
    selectScreenShareQuality: (quality: ScreenShareQuality) => applyCurrentScreenShareProfile(quality, screenShareFpsRef.current),
    selectScreenShareFps: (fps: ScreenShareFps) => applyCurrentScreenShareProfile(screenShareQualityRef.current, fps),
    refreshDevices,
    prepareAudio,
    prepareCameraPreview,
  };
}
