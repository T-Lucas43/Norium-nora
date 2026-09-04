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
import { authenticatedWebSocketUrl, wsBaseUrl } from "../../utils/api";
import {
  useTeamCallRuntime,
  type TeamCallSocketEvent,
  type TeamCallThread,
} from "./useTeamCall";

const TEAM_SOCKET_URL = `${wsBaseUrl()}/api/team-chat/ws`;
const RECONNECT_DELAY_MS = 1800;
const DEFAULT_THREAD: TeamCallThread = { scope: "team", title: "Time todo" };

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

export type CallSessionSnapshot = Pick<Runtime,
  | "incoming"
  | "active"
  | "availableCalls"
  | "busy"
  | "localStream"
  | "remoteStreams"
  | "muted"
  | "cameraOff"
  | "cameraPermission"
  | "sharingScreen"
  | "screenStream"
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
  | "reactions"
  | "raisedHands"
  | "meetingMessages"
  | "screenChangePending"
  | "status"
  | "isHost"
  | "devices"
  | "selectedMicrophoneId"
  | "selectedCameraId"
  | "selectedSpeakerId"
  | "screenShareQuality"
  | "screenShareFps"
  | "supportsSpeakerSelection"
> & {
  phase: CallSessionPhase;
  socketState: "connecting" | "open" | "reconnecting" | "closed";
  participantIds: string[];
};

export type CallSessionCommands = {
  start: (thread: TeamCallThread) => Promise<void>;
  accept: () => Promise<void>;
  join: (call: TeamCallSocketEvent) => Promise<void>;
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
};

export type CallSession = {
  snapshot: CallSessionSnapshot;
  commands: CallSessionCommands;
};

type CallSessionContextValue = CallSession & {
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

  const sendSocketEvent = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const runtime = useTeamCallRuntime({ session, thread: DEFAULT_THREAD, sendSocketEvent });
  runtimeRef.current = runtime;

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
      setSocketState("reconnecting");
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
          if (event.type === "CALL_ERROR") dispatch({ type: "FAILED" });
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
      dispatch({ type: reconnecting ? "SOCKET_LOST" : "CONNECTED" });
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
      dispatch({ type: "JOIN_REQUESTED" });
      await runtime.startCall(thread);
    },
    accept: async () => {
      const callId = runtime.incoming?.callId;
      dispatch({ type: "JOIN_REQUESTED" });
      await runtime.acceptIncoming();
      if (callId) callbacksRef.current.onCallDismissed?.(callId);
    },
    join: async (call) => {
      dispatch({ type: "JOIN_REQUESTED" });
      await runtime.joinActiveCall(call);
      if (call.callId) callbacksRef.current.onCallDismissed?.(call.callId);
    },
    reject: () => {
      const callId = runtime.incoming?.callId;
      dispatch({ type: "END_REQUESTED" });
      runtime.rejectIncoming();
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
    selectCamera: runtime.selectCamera,
    selectSpeaker: runtime.selectSpeaker,
    selectScreenShareQuality: runtime.selectScreenShareQuality,
    selectScreenShareFps: runtime.selectScreenShareFps,
    refreshDevices: runtime.refreshDevices,
  }), [publish, runtime, session.user.id]);

  const snapshot = useMemo<CallSessionSnapshot>(() => ({
    phase,
    socketState,
    incoming: runtime.incoming,
    active: runtime.active,
    availableCalls: runtime.availableCalls,
    busy: runtime.busy,
    localStream: runtime.localStream,
    remoteStreams: runtime.remoteStreams,
    muted: runtime.muted,
    cameraOff: runtime.cameraOff,
    cameraPermission: runtime.cameraPermission,
    sharingScreen: runtime.sharingScreen,
    screenStream: runtime.screenStream,
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
    reactions: runtime.reactions,
    raisedHands: runtime.raisedHands,
    meetingMessages: runtime.meetingMessages,
    screenChangePending: runtime.screenChangePending,
    status: runtime.status,
    isHost: runtime.isHost,
    devices: runtime.devices,
    selectedMicrophoneId: runtime.selectedMicrophoneId,
    selectedCameraId: runtime.selectedCameraId,
    selectedSpeakerId: runtime.selectedSpeakerId,
    screenShareQuality: runtime.screenShareQuality,
    screenShareFps: runtime.screenShareFps,
    supportsSpeakerSelection: runtime.supportsSpeakerSelection,
    participantIds,
  }), [participantIds, phase, runtime, socketState]);

  const subscribe = useCallback((listener: (event: TeamSocketEvent) => void) => {
    listenersRef.current.add(listener);
    replayableEventsRef.current.forEach((event) => listener(event));
    return () => listenersRef.current.delete(listener);
  }, []);

  const value = useMemo<CallSessionContextValue>(
    () => ({ snapshot, commands, subscribe }),
    [commands, snapshot, subscribe],
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

export type { TeamCallSocketEvent, TeamCallThread, TeamThreadScope } from "./useTeamCall";
