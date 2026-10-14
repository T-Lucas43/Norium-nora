/**
 * Browser fixture for the team-call end-to-end suite.
 *
 * CallSession owns signalling, RTCPeerConnection instances and call state.
 * Chromium owns getUserMedia and supplies deterministic fake camera/microphone
 * tracks from command-line files. Only getDisplayMedia is replaced because a
 * headless browser cannot choose a desktop source; it still returns real
 * canvas/audio MediaStreamTracks and never touches the call protocol.
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CallSessionProvider,
  useCallSession,
  useTeamSocketEvents,
  type TeamSocketEvent,
} from "../../src/components/team-chat/CallSession";
import TeamActiveCallCard from "../../src/components/team-chat/TeamActiveCallCard";
import TeamCallOverlay from "../../src/components/team-chat/TeamCallOverlay";
import TeamChatDrawer from "../../src/components/team-chat/TeamChatDrawer";
import "../../src/index.css";

declare global {
  interface Window {
    __callFixture?: {
      mediaRequests: Array<{ audio: unknown; video: unknown; at: number }>;
      userMediaStreams: MediaStream[];
      displayRequests: number;
      displayStreams: MediaStream[];
      socketEvents: TeamSocketEvent[];
      stateHistory: Array<{ phase: string; socketState: string; callId: string; at: number }>;
      cancelNextDisplay: boolean;
    };
  }
}

const parameters = new URLSearchParams(location.search);
const requestedUser = parameters.get("user");
const userId = requestedUser === "member" || requestedUser === "other" ? requestedUser : "owner";
const relayOnly = parameters.get("relay") === "1";
const renderDrawer = parameters.get("drawer") === "1";
const members = [
  { id: "owner", nome: "Owner", status: "ativo" },
  { id: "member", nome: "Member", status: "ativo" },
  { id: "other", nome: "Other", status: "ativo" },
] as any[];

const fixture = window.__callFixture = {
  mediaRequests: [],
  userMediaStreams: [],
  displayRequests: 0,
  displayStreams: [],
  socketEvents: [],
  stateHistory: [],
  cancelNextDisplay: false,
};

// Keep Chromium's native fake-device implementation and permission model. This
// wrapper records only the requested constraint shape for observable assertions.
const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
  configurable: true,
  value: async (constraints: MediaStreamConstraints) => {
    fixture.mediaRequests.push({
      audio: constraints.audio ?? false,
      video: constraints.video ?? false,
      at: performance.now(),
    });
    const stream = await nativeGetUserMedia(constraints);
    fixture.userMediaStreams.push(stream);
    return stream;
  },
});

let displayNumber = 0;
function syntheticDisplayVideo(label: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d")!;
  const draw = () => {
    context.fillStyle = displayNumber % 2 ? "#12539c" : "#8536b5";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "white";
    context.font = "30px sans-serif";
    context.fillText(`${label} - ${userId}`, 30, 90);
    context.fillText(String(Math.floor(performance.now())), 30, 170);
  };
  draw();
  const timer = window.setInterval(draw, 100);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  const nativeStop = track.stop.bind(track);
  track.stop = () => {
    window.clearInterval(timer);
    nativeStop();
  };
  return stream;
}

function syntheticDisplayAudio() {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.value = 880;
  gain.gain.value = 0.04;
  tone.connect(gain).connect(destination);
  tone.start();
  void context.resume();
  const track = destination.stream.getAudioTracks()[0];
  const nativeStop = track.stop.bind(track);
  track.stop = () => {
    tone.stop();
    void context.close();
    nativeStop();
  };
  return destination.stream;
}

Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
  configurable: true,
  value: async () => {
    fixture.displayRequests += 1;
    if (fixture.cancelNextDisplay) {
      fixture.cancelNextDisplay = false;
      throw new DOMException("Screen selection cancelled by the fixture.", "NotAllowedError");
    }
    const screen = syntheticDisplayVideo(`Screen ${++displayNumber}`);
    const sound = syntheticDisplayAudio();
    const stream = new MediaStream([...screen.getTracks(), ...sound.getTracks()]);
    fixture.displayStreams.push(stream);
    return stream;
  },
});

const session = {
  token: userId,
  user: {
    id: userId,
    nome: userId[0].toUpperCase() + userId.slice(1),
    permissions: { chat: true },
    role: userId === "owner" ? "owner" : "member",
    teamOwnerId: "owner",
    status: "ativo",
  },
} as any;

function socketUrl() {
  const configured = window.__NORIUM_CONFIG__?.WS_URL?.replace(/\/+$/, "") || "ws://127.0.0.1:8000";
  return `${configured}/api/team-chat/ws?ticket=${encodeURIComponent(userId)}`;
}

export function Fixture() {
  return (
    <CallSessionProvider
      session={session}
      resolveSocketUrl={async () => socketUrl()}
      iceTransportPolicy={relayOnly ? "relay" : "all"}
    >
      <FixtureContent />
    </CallSessionProvider>
  );
}

function FixtureContent() {
  const { snapshot, commands } = useCallSession();
  const [, updateEventCount] = useState(0);
  useTeamSocketEvents((event) => {
    fixture.socketEvents.push(event);
    if (fixture.socketEvents.length > 250) fixture.socketEvents.splice(0, fixture.socketEvents.length - 250);
    updateEventCount((count) => count + 1);
  });

  useEffect(() => {
    fixture.stateHistory.push({
      phase: snapshot.phase,
      socketState: snapshot.socketState,
      callId: snapshot.active?.callId || snapshot.incoming?.callId || "",
      at: performance.now(),
    });
  }, [snapshot.active?.callId, snapshot.incoming?.callId, snapshot.phase, snapshot.socketState]);

  const diagnostics = useMemo(() => ({
    phase: snapshot.phase,
    socketState: snapshot.socketState,
    callId: snapshot.active?.callId || snapshot.incoming?.callId || "",
    scope: snapshot.active?.thread.scope || snapshot.incoming?.thread.scope || snapshot.prejoin?.thread.scope || "",
    recipientId: snapshot.active?.thread.recipientId || snapshot.incoming?.thread.recipientId || snapshot.prejoin?.thread.recipientId || "",
    participantIds: snapshot.participantIds,
    remoteUserIds: snapshot.remoteStreams.map((stream) => stream.userId),
    muted: snapshot.muted,
    listenOnly: snapshot.listenOnly,
    microphonePermission: snapshot.microphonePermission,
    cameraOff: snapshot.cameraOff,
    cameraPermission: snapshot.cameraPermission,
    sharingScreen: snapshot.sharingScreen,
    screenChangePending: snapshot.screenChangePending,
    remoteScreenCount: snapshot.remoteScreenSharingIds.length,
    recording: snapshot.recording,
    recordingUploadState: snapshot.recordingUploadState,
    recordingUploadProgress: snapshot.recordingUploadProgress,
    relayObserved: snapshot.iceTelemetry.relayObserved,
    iceService: snapshot.iceService.status,
    connectionQuality: snapshot.connectionQuality,
    status: snapshot.status,
    reconnectionNotice: snapshot.reconnectionNotice,
    failureNotice: snapshot.failureNotice,
    mediaRequests: fixture.mediaRequests,
    displayRequests: fixture.displayRequests,
    localTrackStates: snapshot.localStream?.getTracks().map((track) => ({
      kind: track.kind,
      enabled: track.enabled,
      readyState: track.readyState,
    })) || [],
    acquiredTrackStates: fixture.userMediaStreams.flatMap((stream) => stream.getTracks().map((track) => ({
      kind: track.kind,
      enabled: track.enabled,
      readyState: track.readyState,
    }))),
    eventTypes: fixture.socketEvents.map((event) => event.type),
    stateHistory: fixture.stateHistory,
  }), [snapshot]);

  const connected = snapshot.socketState === "open";
  const controls = (
    <section aria-label="Controles do fixture" className="m-4 flex flex-wrap gap-2">
      <button data-testid="start-group" disabled={!connected || snapshot.busy} onClick={() => void commands.start({ scope: "team", title: "Time todo" })} className="rounded bg-blue-600 px-4 py-2 text-white">Iniciar grupo</button>
      <button data-testid="start-direct-member" disabled={!connected || snapshot.busy} onClick={() => void commands.start({ scope: "direct", title: "Member", recipientId: "member", subteamId: null })} className="rounded bg-blue-600 px-4 py-2 text-white">Ligar para Member</button>
      <button data-testid="start-direct-other" disabled={!connected || snapshot.busy} onClick={() => void commands.start({ scope: "direct", title: "Other", recipientId: "other", subteamId: null })} className="rounded bg-blue-600 px-4 py-2 text-white">Ligar para Other</button>
      <button data-testid="cancel-next-screen" onClick={() => { fixture.cancelNextDisplay = true; }} className="rounded border px-4 py-2">Cancelar próxima tela</button>
    </section>
  );

  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <h1>Teste de chamada - {userId}</h1>
      <div data-testid="fixture-ready">{connected ? "ready" : "connecting"}</div>
      <output data-testid="session-phase">{snapshot.phase}</output>
      <output data-testid="socket-state">{snapshot.socketState}</output>
      <output data-testid="call-id">{diagnostics.callId}</output>
      <output data-testid="participants">{snapshot.participantIds.join(",")}</output>
      <output data-testid="media-request-count">{fixture.mediaRequests.length}</output>
      <output data-testid="media-requests">{JSON.stringify(fixture.mediaRequests)}</output>
      <output data-testid="event-types">{diagnostics.eventTypes.join(",")}</output>
      <output data-testid="diagnostics">{JSON.stringify(diagnostics)}</output>
      {controls}
      {renderDrawer ? (
        <TeamChatDrawer open onClose={() => {}} session={session} variant="page" />
      ) : (
        <>
          {snapshot.availableCalls.map((meeting) => (
            <TeamActiveCallCard key={meeting.callId} meeting={meeting} busy={snapshot.busy} onJoin={() => void commands.join(meeting)} />
          ))}
          <TeamCallOverlay snapshot={snapshot} commands={commands} members={members} currentUserId={userId} onDownloadAttachment={() => {}} />
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
