// Fixture de desenvolvimento: reutiliza a sessao, overlay e protocolo reais.
// Somente os dispositivos sao sinteticos; nao acessa camera/microfone fisicos.
import { createRoot } from "react-dom/client";
import { CallSessionProvider, useCallSession } from "../../src/components/team-chat/CallSession";
import TeamCallOverlay from "../../src/components/team-chat/TeamCallOverlay";
import TeamActiveCallCard from "../../src/components/team-chat/TeamActiveCallCard";
import "../../src/index.css";

const fixtureParameters = new URLSearchParams(location.search);
const requestedUser = fixtureParameters.get("user");
const relayOnly = fixtureParameters.get("relay") === "1";
const userId = requestedUser === "member" || requestedUser === "other" ? requestedUser : "owner";
const members = [{ id: "owner", nome: "Owner" }, { id: "member", nome: "Member" }, { id: "other", nome: "Other" }];
function syntheticVideo(label: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext("2d")!;
  const draw = () => {
    context.fillStyle = label.startsWith("Tela") ? (label.endsWith("1") ? "#12539c" : "#8536b5") : "#156345";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "white"; context.font = "30px sans-serif";
    context.fillText(`${label} · ${userId}`, 30, 80);
    context.fillText(String(Date.now()), 30, 160);
  };
  draw();
  const timer = window.setInterval(draw, 100);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { window.clearInterval(timer); stop(); };
  return stream;
}
function syntheticAudio(frequency: number) {
  const context = new AudioContext();
  void context.resume();
  const destination = context.createMediaStreamDestination();
  const tone = context.createOscillator(); tone.frequency.value = frequency;
  const gain = context.createGain(); gain.gain.value = 0.05;
  tone.connect(gain).connect(destination); tone.start();
  const track = destination.stream.getAudioTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { tone.stop(); void context.close(); stop(); };
  return destination.stream;
}
let displayNumber = 0;
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async ({ video }: { video: unknown }) => {
    if (video) {
      return syntheticVideo("Câmera");
    }
    return syntheticAudio(220);
  },
  getDisplayMedia: async () => {
    if ((window as any).__cancelNextDisplay) { (window as any).__cancelNextDisplay = false; throw new DOMException("Cancelado", "NotAllowedError"); }
    const stream = new MediaStream([...syntheticVideo(`Tela ${++displayNumber}`).getTracks(), ...syntheticAudio(880).getTracks()]);
    ((window as any).__displayStreams ||= []).push(stream);
    return stream;
  },
  enumerateDevices: async () => [],
  addEventListener() {}, removeEventListener() {},
} });
const session = { token: userId, user: { id: userId, nome: userId, permissions: {}, role: "owner" } } as any;

export function Fixture() {
  return <CallSessionProvider
    session={session}
    resolveSocketUrl={async () => `ws://127.0.0.1:8000/api/team-chat/ws?ticket=${userId}`}
    iceTransportPolicy={relayOnly ? "relay" : "all"}
  >
    <FixtureContent />
  </CallSessionProvider>;
}

function FixtureContent() {
  const { snapshot, commands } = useCallSession();
  const connected = snapshot.socketState === "open";
  return <main style={{ maxWidth: 760, margin: "40px auto", padding: 24 }}>
    <h1>Teste local · {userId}</h1>
    <p>{connected ? "Conectado" : "Conectando"}</p>
    <p data-testid="ice-service">ICE: {snapshot.iceService.status}</p>
    <p data-testid="relay-observed">Relay observado: {snapshot.iceTelemetry.relayObserved ? "sim" : "não"}</p>
    <p>Reuniões ativas: {snapshot.availableCalls.length}</p>
    <button disabled={!connected || snapshot.busy} onClick={() => void commands.start({ scope: "team", title: "Time todo" })} className="m-4 rounded bg-blue-600 px-4 py-2 text-white">Iniciar reunião</button>
    {snapshot.availableCalls.map((meeting) => <TeamActiveCallCard key={meeting.callId} meeting={meeting} busy={snapshot.busy} onJoin={() => void commands.join(meeting)} />)}
    <p>{snapshot.status}</p>
    <TeamCallOverlay snapshot={snapshot} commands={commands} members={members} currentUserId={userId} onDownloadAttachment={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
