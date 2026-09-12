/* oxlint-disable react/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AuthSession } from "../../types/auth";
import { apiRequest } from "../../core/api/client";
import { authenticatedWebSocketUrl, wsBaseUrl } from "../../utils/api";
import {
  SAFE_STUN_SERVERS,
  useTeamCallRuntime,
  type CallMicrophoneMode,
  type TeamCallSocketEvent,
  type TeamCallThread,
} from "./useTeamCall";
import {
  type MediaTransportFactory,
  type MediaTransportKind,
} from "./media/MediaTransport";
import {
  HttpLiveKitAccessProvider,
  LiveKitMediaTransportFactory,
} from "./media/LiveKitMediaTransport";

const TEAM_SOCKET_URL = `${wsBaseUrl()}/api/team-chat/ws`;
const RECONNECT_DELAY_MS = 1800;
const ICE_REQUEST_TIMEOUT_MS = 8000;
const ICE_RETRY_DELAY_MS = 30_000;
const ICE_MIN_RENEWAL_DELAY_MS = 1000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_THREAD: TeamCallThread = { scope: "team", title: "Time todo" };

type TemporaryIceConfiguration = {
  iceServers: RTCIceServer[];
  expiresAt: string;
  refreshAfter: string;
};

export type IceServiceSnapshot = {
  status: "loading" | "ready" | "degraded" | "unavailable";
  expiresAt: string;
  detail: string;
};

const INITIAL_ICE_SERVICE: IceServiceSnapshot = {
  status: "loading",
  expiresAt: "",
  detail: "Preparando conectividade da chamada.",
};

function validTemporaryIceConfiguration(value: TemporaryIceConfiguration) {
  const expiresAt = Date.parse(value.expiresAt);
  const refreshAfter = Date.parse(value.refreshAfter);
  return Array.isArray(value.iceServers)
    && value.iceServers.length > 0
    && value.iceServers.every((server) => Boolean(server?.urls))
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && Number.isFinite(refreshAfter)
    && refreshAfter < expiresAt;
}

export type CallSessionPhase =
  | "idle"
  | "ringing"
  | "joining"
  | "connected"
  | "reconnecting"
  | "ending"
  | "failed";

export type CallSessionTransition =
  | { type: "INVITE_RECEIVED" }
  | { type: "JOIN_REQUESTED" }
  | { type: "CONNECTED" }
  | { type: "SOCKET_LOST" }
  | { type: "END_REQUESTED" }
  | { type: "FAILED" }
  | { type: "RESET" };

export function transitionCallSession(
  phase: CallSessionPhase,
  transition: CallSessionTransition,
): CallSessionPhase {
  switch (transition.type) {
    case "INVITE_RECEIVED":
      return phase === "idle" || phase === "failed" ? "ringing" : phase;
    case "JOIN_REQUESTED":
      return phase === "idle" || phase === "ringing" || phase === "failed" ? "joining" : phase;
    case "CONNECTED":
      return phase === "joining" || phase === "reconnecting" ? "connected" : phase;
    case "SOCKET_LOST":
      return phase === "joining" || phase === "connected" ? "reconnecting" : phase;
    case "END_REQUESTED":
      return phase === "idle" ? phase : "ending";
    case "FAILED":
      return phase === "ending" ? phase : "failed";
    case "RESET":
      return "idle";
  }
}

export type TeamSocketEvent = TeamCallSocketEvent & {
  onlineUserIds?: string[];
  messageId?: string;
  readBy?: Record<string, unknown>;
  message?: {
    id?: string;
    threadId?: string;
    senderId?: string;
    senderName?: string;
    text?: string;
    attachments?: unknown[];
    metadata?: Record<string, unknown>;
    createdAt?: string;
  };
};

type Runtime = ReturnType<typeof useTeamCallRuntime>;

export type CallPrejoin = {
  kind: "start" | "incoming" | "active";
  thread: TeamCallThread;
  title: string;
  microphoneMode: CallMicrophoneMode;
  cameraEnabled: boolean;
  previewEnabled: boolean;
};

export type CallSessionSnapshot = Pick<Runtime,
  | "incoming"
  | "active"
  | "availableCalls"
  | "busy"
  | "localStream"
  | "remoteStreams"
  | "muted"
  | "listenOnly"
  | "microphonePermission"
  | "cameraOff"
  | "cameraPermission"
  | "sharingScreen"
  | "screenStream"
  | "previewStream"
  | "remoteScreenSharingIds"
  | "remoteCameraEnabled"
  | "callElapsedSeconds"
  | "recording"
  | "recordingElapsedSeconds"
  | "recordingUploadState"
  | "recordingUploadedBytes"
  | "recordingPendingBytes"
  | "recordingUploadProgress"
  | "connectionQuality"
  | "iceTelemetry"
  | "mediaTransportState"
  | "mediaTransportFailure"
  | "reactions"
  | "raisedHands"
  | "meetingMessages"
  | "screenChangePending"
  | "status"
  | "audioReady"
  | "ringtoneAudible"
  | "isHost"
  | "devices"
  | "selectedMicrophoneId"
  | "selectedCameraId"
  | "selectedSpeakerId"
  | "screenShareQuality"
  | "screenShareFps"
  | "supportsSpeakerSelection"
> & {
  clientId?: string;
  phase: CallSessionPhase;
  socketState: "connecting" | "open" | "reconnecting" | "closed";
  participantIds: string[];
  prejoin: CallPrejoin | null;
  reconnectionNotice: string;
  failureNotice: string;
  mediaTransport: MediaTransportKind;
  iceService: IceServiceSnapshot;
  conversation: {
    callId: string;
    thread: TeamCallThread;
    participantIds: string[];
    messages: Runtime["meetingMessages"];
  } | null;
};

export type CallSessionCommands = {
  start: (thread: TeamCallThread) => Promise<void>;
  accept: () => Promise<void>;
  join: (call: TeamCallSocketEvent) => Promise<void>;
  enter: () => Promise<void>;
  cancelEntry: () => void;
  setEntryMicrophoneMode: (mode: CallMicrophoneMode) => void;
  setEntryCameraEnabled: (enabled: boolean) => void;
  setEntryPreviewEnabled: (enabled: boolean) => Promise<void>;
  reject: () => void;
  end: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: Runtime["toggleMute"];
  toggleCamera: Runtime["toggleCamera"];
  requestCameraPermission: Runtime["requestCameraPermission"];
  toggleScreenShare: Runtime["toggleScreenShare"];
  changeScreenShare: Runtime["changeScreenShare"];
  startRecording: Runtime["startRecording"];
  stopRecording: Runtime["stopRecording"];
  sendReaction: Runtime["sendReaction"];
  toggleHand: Runtime["toggleHand"];
  sendMeetingMessage: Runtime["sendMeetingMessage"];
  selectMicrophone: Runtime["selectMicrophone"];
  selectCamera: Runtime["selectCamera"];
  selectSpeaker: Runtime["selectSpeaker"];
  selectScreenShareQuality: Runtime["selectScreenShareQuality"];
  selectScreenShareFps: Runtime["selectScreenShareFps"];
  refreshDevices: Runtime["refreshDevices"];
  dismissFailure: () => void;
};

export type CallSession = {
  snapshot: CallSessionSnapshot;
  commands: CallSessionCommands;
};

type CallSessionContextValue = CallSession & {
  request: typeof apiRequest;
  subscribe: (listener: (event: TeamSocketEvent) => void) => () => void;
};

const CallSessionContext = createContext<CallSessionContextValue | null>(null);

type CallSessionProviderProps = {
  session: AuthSession;
  children: ReactNode;
  resolveSocketUrl?: (session: AuthSession) => Promise<string>;
  onIncomingCall?: (event: TeamSocketEvent) => void;
  onCallDismissed?: (callId: string) => void;
  onTeamEvent?: (event: TeamSocketEvent) => void;
  iceTransportPolicy?: RTCIceTransportPolicy;
  mediaTransports?: readonly MediaTransportFactory[];
};

export function CallSessionProvider(props: CallSessionProviderProps) {
  const parent = useContext(CallSessionContext);
  if (parent) throw new Error("CallSessionProvider must be mounted only once.");
  return <ActiveCallSessionProvider {...props} />;
}

function ActiveCallSessionProvider({
  session,
  children,
  onIncomingCall,
  onCallDismissed,
  onTeamEvent,
  resolveSocketUrl,
  iceTransportPolicy = "all",
  mediaTransports,
}: CallSessionProviderProps) {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(event: TeamSocketEvent) => void>());
  const replayableEventsRef = useRef(new Map<string, TeamSocketEvent>());
  const seenIncomingCallIdsRef = useRef(new Set<string>());
  const runtimeRef = useRef<Runtime | null>(null);
  const callbacksRef = useRef({ onIncomingCall, onCallDismissed, onTeamEvent });
  callbacksRef.current = { onIncomingCall, onCallDismissed, onTeamEvent };
  const [phase, dispatch] = useReducer(transitionCallSession, "idle");
  const [socketState, setSocketState] = useState<CallSessionSnapshot["socketState"]>("connecting");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [prejoin, setPrejoin] = useState<CallPrejoin | null>(null);
  const [reconnectionNotice, setReconnectionNotice] = useState("");
  const [failureNotice, setFailureNotice] = useState("");
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(SAFE_STUN_SERVERS);
  const [iceService, setIceService] = useState<IceServiceSnapshot>(INITIAL_ICE_SERVICE);
  const reconnectingCallIdRef = useRef("");
  const entryTargetRef = useRef<{
    kind: CallPrejoin["kind"];
    thread: TeamCallThread;
    call?: TeamCallSocketEvent;
    callId?: string;
  } | null>(null);
  const configuredMediaTransports = useMemo<readonly MediaTransportFactory[]>(() => {
    if (mediaTransports?.some((factory) => factory.kind === "sfu")) return mediaTransports;
    return [
      ...(mediaTransports || []),
      new LiveKitMediaTransportFactory(new HttpLiveKitAccessProvider(session.token)),
    ];
  }, [mediaTransports, session.token]);

  const sendSocketEvent = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const runtime = useTeamCallRuntime({
    session,
    thread: DEFAULT_THREAD,
    sendSocketEvent,
    iceServers,
    iceTransportPolicy,
    mediaTransports: configuredMediaTransports,
  });
  runtimeRef.current = runtime;

  useEffect(() => {
    let cancelled = false;
    let renewalTimer: number | null = null;
    let currentExpiry = 0;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (renewalTimer !== null) window.clearTimeout(renewalTimer);
      renewalTimer = window.setTimeout(
        () => void refresh(),
        Math.min(MAX_BROWSER_TIMEOUT_MS, Math.max(ICE_MIN_RENEWAL_DELAY_MS, delayMs)),
      );
    };

    const refresh = async () => {
      try {
        const configuration = await apiRequest<TemporaryIceConfiguration>("/api/team-chat/calls/ice-servers", {
          token: session.token,
          timeoutMs: ICE_REQUEST_TIMEOUT_MS,
        });
        if (cancelled) return;
        if (!validTemporaryIceConfiguration(configuration)) throw new Error("Configuracao ICE temporaria invalida.");
        currentExpiry = Date.parse(configuration.expiresAt);
        setIceServers(configuration.iceServers);
        setIceService({
          status: "ready",
          expiresAt: configuration.expiresAt,
          detail: "Conectividade para redes restritivas disponível.",
        });
        schedule(Date.parse(configuration.refreshAfter) - Date.now());
      } catch {
        if (cancelled) return;
        const credentialsStillValid = currentExpiry > Date.now();
        if (credentialsStillValid) {
          setIceService((current) => ({
            ...current,
            status: "degraded",
            detail: "A renovação da conectividade está atrasada; tentando novamente.",
          }));
          schedule(Math.min(ICE_RETRY_DELAY_MS, Math.max(ICE_MIN_RENEWAL_DELAY_MS, currentExpiry - Date.now())));
          return;
        }
        currentExpiry = 0;
        setIceServers(SAFE_STUN_SERVERS);
        setIceService({
          status: "unavailable",
          expiresAt: "",
          detail: "TURN indisponível. Chamadas podem falhar em redes restritivas.",
        });
        schedule(ICE_RETRY_DELAY_MS);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (renewalTimer !== null) window.clearTimeout(renewalTimer);
    };
  }, [session.token]);

  useEffect(() => {
    const prepare = () => {
      void runtimeRef.current?.prepareAudio();
      window.removeEventListener("pointerdown", prepare, true);
      window.removeEventListener("keydown", prepare, true);
    };
    window.addEventListener("pointerdown", prepare, true);
    window.addEventListener("keydown", prepare, true);
    return () => {
      window.removeEventListener("pointerdown", prepare, true);
      window.removeEventListener("keydown", prepare, true);
    };
  }, []);

  const publish = useCallback((event: TeamSocketEvent) => {
    if (event.type === "CONNECTED" || event.type === "PRESENCE") {
      replayableEventsRef.current.set(event.type, event);
    }
    callbacksRef.current.onTeamEvent?.(event);
    listenersRef.current.forEach((listener) => listener(event));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;
    const listeners = listenersRef.current;
    const replayableEvents = replayableEventsRef.current;
    const seenIncomingCallIds = seenIncomingCallIdsRef.current;

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      reconnectingCallIdRef.current = runtimeRef.current?.active?.callId
        || runtimeRef.current?.incoming?.callId
        || reconnectingCallIdRef.current;
      setSocketState("reconnecting");
      runtimeRef.current?.telemetrySocketLost?.();
      if (runtimeRef.current?.active) dispatch({ type: "SOCKET_LOST" });
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = async () => {
      if (cancelled) return;
      setSocketState((current) => current === "reconnecting" ? current : "connecting");
      try {
        const socketUrl = resolveSocketUrl
          ? await resolveSocketUrl(session)
          : await authenticatedWebSocketUrl(TEAM_SOCKET_URL, session.token);
        if (cancelled) return;
        const socket = new WebSocket(socketUrl);
        socketRef.current = socket;
        socket.onopen = () => {
          if (cancelled || socketRef.current !== socket) return;
          setSocketState("open");
          runtimeRef.current?.heartbeat();
          runtimeRef.current?.telemetrySocketRestored?.();
          if (runtimeRef.current?.active) dispatch({ type: "CONNECTED" });
        };
        socket.onmessage = (message) => {
          let event: TeamSocketEvent;
          try {
            event = JSON.parse(String(message.data || "{}")) as TeamSocketEvent;
          } catch {
            return;
          }
          if (!event.type) return;
          if (event.type === "CALLS_STATE" && reconnectingCallIdRef.current) {
            const callId = reconnectingCallIdRef.current;
            const stillActive = event.calls?.some((call) => call.callId === callId) === true;
            setReconnectionNotice(stillActive
              ? "Chamada ainda ativa · conexão restabelecida."
              : "Chamada perdida · ela foi encerrada enquanto você estava desconectado.");
            reconnectingCallIdRef.current = "";
          }
          publish(event);
          if (!event.type.startsWith("CALL")) return;
          if (event.type === "CALL_INVITE") {
            dispatch({ type: "INVITE_RECEIVED" });
            if (event.callId && event.fromUserId !== session.user.id && !seenIncomingCallIdsRef.current.has(event.callId)) {
              seenIncomingCallIdsRef.current.add(event.callId);
              if (seenIncomingCallIdsRef.current.size > 100) {
                const oldest = seenIncomingCallIdsRef.current.values().next().value;
                if (oldest) seenIncomingCallIdsRef.current.delete(oldest);
              }
              callbacksRef.current.onIncomingCall?.(event);
            }
          }
          const activeCallId = runtimeRef.current?.active?.callId;
          if (event.callId && event.callId === activeCallId) {
            if (event.joinedUserIds?.length) {
              setParticipantIds(Array.from(new Set([session.user.id, ...event.joinedUserIds])));
            } else if (event.type === "CALL_ACCEPT" && event.fromUserId) {
              setParticipantIds((current) => Array.from(new Set([...current, session.user.id, event.fromUserId!])));
            } else if (event.type === "CALL_LEAVE" && event.fromUserId) {
              setParticipantIds((current) => current.filter((userId) => userId !== event.fromUserId));
            } else if (event.type === "CALL_END") {
              setParticipantIds([]);
            }
          }
          if (event.type === "CALL_ERROR" && event.code === "call_capacity_reached") {
            setFailureNotice(event.detail || "Não foi possível concluir a ação na chamada.");
          }
          if (event.type === "CALL_ERROR") {
            dispatch({ type: "FAILED" });
          }
          void runtimeRef.current?.handleSocketEvent(event).catch(() => dispatch({ type: "FAILED" }));
        };
        socket.onclose = (event) => {
          if (socketRef.current === socket) socketRef.current = null;
          if (event.code === 4401 || event.code === 4403) {
            setSocketState("closed");
            setParticipantIds([]);
            runtimeRef.current?.revokeAccess("Seu acesso à chamada foi revogado.");
            dispatch({ type: "FAILED" });
            return;
          }
          scheduleReconnect();
        };
        socket.onerror = () => socket.close();
      } catch {
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      listeners.clear();
      replayableEvents.clear();
      seenIncomingCallIds.clear();
    };
  }, [publish, resolveSocketUrl, session, session.token, session.user.id]);

  useEffect(() => {
    if (runtime.incoming && !runtime.active) {
      dispatch({ type: "INVITE_RECEIVED" });
      return;
    }
    if (runtime.active) {
      const reconnecting = socketState !== "open"
        || runtime.connectionQuality === "offline"
        || runtime.connectionQuality === "connecting";
      dispatch({ type: phase === "idle" || phase === "ringing" ? "JOIN_REQUESTED" : reconnecting ? "SOCKET_LOST" : "CONNECTED" });
      setParticipantIds((current) => Array.from(new Set([
        ...current,
        session.user.id,
        runtime.active!.hostUserId,
        ...runtime.remoteStreams.map((item) => item.userId),
      ])));
      return;
    }
    if (participantIds.length) setParticipantIds([]);
    if (!runtime.busy && phase !== "failed" && phase !== "idle") dispatch({ type: "RESET" });
  }, [participantIds.length, phase, runtime.active, runtime.busy, runtime.connectionQuality, runtime.incoming, runtime.remoteStreams, session.user.id, socketState]);

  const commands = useMemo<CallSessionCommands>(() => ({
    start: async (thread) => {
      setReconnectionNotice("");
      setFailureNotice("");
      entryTargetRef.current = { kind: "start", thread };
      setPrejoin({ kind: "start", thread, title: thread.title, microphoneMode: "muted", cameraEnabled: false, previewEnabled: false });
      void runtime.prepareAudio();
      await runtime.refreshDevices();
    },
    accept: async () => {
      setReconnectionNotice("");
      setFailureNotice("");
      const call = runtime.incoming;
      if (!call) return;
      entryTargetRef.current = { kind: "incoming", thread: call.thread, callId: call.callId };
      setPrejoin({ kind: "incoming", thread: call.thread, title: call.title, microphoneMode: "muted", cameraEnabled: false, previewEnabled: false });
      void runtime.prepareAudio();
      await runtime.refreshDevices();
    },
    join: async (call) => {
      setReconnectionNotice("");
      setFailureNotice("");
      const thread: TeamCallThread = {
        scope: call.scope || "team",
        title: call.scope === "direct" ? call.fromUserName || "Chamada individual" : call.scope === "subteam" ? "Reunião da subequipe" : "Time todo",
        recipientId: call.scope === "direct"
          ? (call.fromUserId && call.fromUserId !== session.user.id ? call.fromUserId : call.recipientId)
          : null,
        subteamId: call.subteamId || null,
      };
      entryTargetRef.current = { kind: "active", thread, call };
      setPrejoin({ kind: "active", thread, title: thread.title, microphoneMode: "muted", cameraEnabled: false, previewEnabled: false });
      void runtime.prepareAudio();
      await runtime.refreshDevices();
    },
    enter: async () => {
      const target = entryTargetRef.current;
      const entry = prejoin;
      if (!target || !entry) return;
      dispatch({ type: "JOIN_REQUESTED" });
      const options = { microphoneMode: entry.microphoneMode, cameraEnabled: entry.cameraEnabled };
      let entered = false;
      if (target.kind === "start") entered = (await runtime.startCall(target.thread, options)) !== false;
      else if (target.kind === "incoming") entered = (await runtime.acceptIncoming(options)) !== false;
      else if (target.call) entered = (await runtime.joinActiveCall(target.call, options)) !== false;
      if (!entered) {
        dispatch({ type: "FAILED" });
        return;
      }
      const callId = target.callId || target.call?.callId;
      if (callId) callbacksRef.current.onCallDismissed?.(callId);
      entryTargetRef.current = null;
      setPrejoin(null);
    },
    cancelEntry: () => {
      void runtime.prepareCameraPreview(false);
      entryTargetRef.current = null;
      setPrejoin(null);
    },
    setEntryMicrophoneMode: (mode) => {
      setPrejoin((current) => current ? {
        ...current,
        microphoneMode: mode,
        ...(mode === "listen-only" ? { cameraEnabled: false, previewEnabled: false } : {}),
      } : current);
      if (mode === "listen-only") void runtime.prepareCameraPreview(false);
    },
    setEntryCameraEnabled: (enabled) => {
      setPrejoin((current) => current ? {
        ...current,
        cameraEnabled: current.microphoneMode === "listen-only" ? false : enabled,
        previewEnabled: enabled ? current.previewEnabled : false,
      } : current);
      if (!enabled) void runtime.prepareCameraPreview(false);
    },
    setEntryPreviewEnabled: async (enabled) => {
      const current = prejoin;
      if (!current || current.microphoneMode === "listen-only" || !current.cameraEnabled) return;
      const available = await runtime.prepareCameraPreview(enabled);
      setPrejoin((entry) => entry ? { ...entry, previewEnabled: enabled && available } : entry);
    },
    reject: () => {
      const callId = runtime.incoming?.callId;
      dispatch({ type: "END_REQUESTED" });
      runtime.rejectIncoming();
      setReconnectionNotice("");
      entryTargetRef.current = null;
      setPrejoin(null);
      if (callId) callbacksRef.current.onCallDismissed?.(callId);
      dispatch({ type: "RESET" });
    },
    end: async () => {
      const callId = runtime.active?.callId;
      dispatch({ type: "END_REQUESTED" });
      if (callId) publish({ type: "CALL_END", callId, fromUserId: session.user.id });
      await runtime.endCall();
      dispatch({ type: "RESET" });
    },
    leave: async () => {
      dispatch({ type: "END_REQUESTED" });
      await runtime.leaveCall();
      dispatch({ type: "RESET" });
    },
    toggleMute: runtime.toggleMute,
    toggleCamera: runtime.toggleCamera,
    requestCameraPermission: runtime.requestCameraPermission,
    toggleScreenShare: runtime.toggleScreenShare,
    changeScreenShare: runtime.changeScreenShare,
    startRecording: runtime.startRecording,
    stopRecording: runtime.stopRecording,
    sendReaction: runtime.sendReaction,
    toggleHand: runtime.toggleHand,
    sendMeetingMessage: runtime.sendMeetingMessage,
    selectMicrophone: runtime.selectMicrophone,
    selectCamera: async (deviceId) => {
      await runtime.selectCamera(deviceId);
      if (prejoin?.previewEnabled) await runtime.prepareCameraPreview(true, deviceId);
    },
    selectSpeaker: runtime.selectSpeaker,
    selectScreenShareQuality: runtime.selectScreenShareQuality,
    selectScreenShareFps: runtime.selectScreenShareFps,
    refreshDevices: runtime.refreshDevices,
    dismissFailure: () => setFailureNotice(""),
  }), [prejoin, publish, runtime, session.user.id]);

  const conversation = useMemo<CallSessionSnapshot["conversation"]>(() => {
    const call = runtime.active;
    if (!call) return null;
    const directParticipant = call.thread.scope === "direct" ? call.thread.recipientId : null;
    return {
      callId: call.callId,
      thread: call.thread,
      participantIds: Array.from(new Set([
        session.user.id,
        ...(directParticipant ? [directParticipant] : []),
        ...participantIds,
      ])),
      messages: runtime.meetingMessages,
    };
  }, [participantIds, runtime.active, runtime.meetingMessages, session.user.id]);

  const snapshot = useMemo<CallSessionSnapshot>(() => ({
    phase,
    socketState,
    clientId: runtime.clientId,
    incoming: runtime.incoming,
    active: runtime.active,
    availableCalls: runtime.availableCalls,
    busy: runtime.busy,
    localStream: runtime.localStream,
    remoteStreams: runtime.remoteStreams,
    muted: runtime.muted,
    listenOnly: runtime.listenOnly,
    microphonePermission: runtime.microphonePermission,
    cameraOff: runtime.cameraOff,
    cameraPermission: runtime.cameraPermission,
    sharingScreen: runtime.sharingScreen,
    screenStream: runtime.screenStream,
    previewStream: runtime.previewStream,
    remoteScreenSharingIds: runtime.remoteScreenSharingIds,
    remoteCameraEnabled: runtime.remoteCameraEnabled,
    callElapsedSeconds: runtime.callElapsedSeconds,
    recording: runtime.recording,
    recordingElapsedSeconds: runtime.recordingElapsedSeconds,
    recordingUploadState: runtime.recordingUploadState,
    recordingUploadedBytes: runtime.recordingUploadedBytes,
    recordingPendingBytes: runtime.recordingPendingBytes,
    recordingUploadProgress: runtime.recordingUploadProgress,
    connectionQuality: runtime.connectionQuality,
    iceTelemetry: runtime.iceTelemetry,
    mediaTransportState: runtime.mediaTransportState,
    mediaTransportFailure: runtime.mediaTransportFailure,
    reactions: runtime.reactions,
    raisedHands: runtime.raisedHands,
    meetingMessages: runtime.meetingMessages,
    screenChangePending: runtime.screenChangePending,
    status: runtime.status,
    audioReady: runtime.audioReady,
    ringtoneAudible: runtime.ringtoneAudible,
    isHost: runtime.isHost,
    devices: runtime.devices,
    selectedMicrophoneId: runtime.selectedMicrophoneId,
    selectedCameraId: runtime.selectedCameraId,
    selectedSpeakerId: runtime.selectedSpeakerId,
    screenShareQuality: runtime.screenShareQuality,
    screenShareFps: runtime.screenShareFps,
    supportsSpeakerSelection: runtime.supportsSpeakerSelection,
    participantIds,
    prejoin,
    reconnectionNotice,
    failureNotice,
    mediaTransport: runtime.mediaTransport,
    iceService,
    conversation,
  }), [conversation, failureNotice, iceService, participantIds, phase, prejoin, reconnectionNotice, runtime, socketState]);

  const subscribe = useCallback((listener: (event: TeamSocketEvent) => void) => {
    listenersRef.current.add(listener);
    replayableEventsRef.current.forEach((event) => listener(event));
    return () => listenersRef.current.delete(listener);
  }, []);

  const request = useCallback<typeof apiRequest>((path, options) => apiRequest(path, { ...options, token: session.token }), [session.token]);
  const value = useMemo<CallSessionContextValue>(
    () => ({ snapshot, commands, subscribe, request }),
    [commands, snapshot, subscribe, request],
  );

  return <CallSessionContext.Provider value={value}>{children}</CallSessionContext.Provider>;
}

export function useCallSession(): CallSession {
  const session = useContext(CallSessionContext);
  if (!session) throw new Error("useCallSession must be used inside CallSessionProvider.");
  return { snapshot: session.snapshot, commands: session.commands };
}

export function useTeamSocketEvents(listener: (event: TeamSocketEvent) => void) {
  const session = useContext(CallSessionContext);
  const subscribe = session?.subscribe;
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => subscribe?.((event) => listenerRef.current(event)), [subscribe]);
}

export function useTeamApiRequest() {
  return useContext(CallSessionContext)?.request || apiRequest;
}

export type { TeamCallSocketEvent, TeamCallThread, TeamThreadScope } from "./useTeamCall";
